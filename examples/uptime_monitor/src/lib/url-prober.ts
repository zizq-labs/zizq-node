// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Performs a single HTTP probe of a URL and returns a {@link CheckResult}
// describing the outcome. A 2xx final response is "up"; anything else
// (non-2xx final, network error, timeout) is "down".
//
// When the response advertises XML, the root element is inspected to
// flag sitemap bodies. `DiscoverSitemapUrlsJob` does the full URL
// extraction; we just set the flag.

import { fetch, Agent, type Dispatcher } from "undici";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { CheckResult } from "../models/check.ts";
import type { Status } from "../models/monitored-url.ts";

const OPEN_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 10_000;

const SITEMAP_ROOT_ELEMENTS = new Set(["urlset", "sitemapindex"]);
const XML_CONTENT_TYPE = /^(application|text)\/(.*\+)?xml(\s*;.*)?$/i;

const defaultAgent = new Agent({
  connectTimeout: OPEN_TIMEOUT_MS,
  headersTimeout: READ_TIMEOUT_MS,
  bodyTimeout: READ_TIMEOUT_MS,
});

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
  parseTagValue: false,
});

export interface ProbeOptions {
  /** Undici dispatcher — pass a `MockAgent` in tests. */
  dispatcher?: Dispatcher;
}

/**
 * Probe `url` and return a `CheckResult`. Never throws — network
 * errors become `status: "down"` on the returned record.
 */
export async function probe(
  url: string,
  options: ProbeOptions = {},
): Promise<CheckResult> {
  const started = performance.now();
  const dispatcher = options.dispatcher ?? defaultAgent;

  try {
    // undici.fetch handles redirects natively via `redirect: 'follow'`,
    // which is what we want here. The `dispatcher` option threads the
    // pooling / timeouts / MockAgent injection through the same code
    // path as the direct `request()` API.
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      dispatcher,
    });

    const finalUrl = res.url || url;
    const contentType = res.headers.get("content-type") ?? "";
    const bodyText = await res.text();

    return buildResult(res.status, finalUrl, contentType, bodyText, started);
  } catch (err) {
    return failure(null, url, started, formatError(err));
  }
}

// --- Internal --------------------------------------------------------

function buildResult(
  status: number,
  finalUrl: string,
  contentType: string,
  body: string,
  started: number,
): CheckResult {
  if (status >= 200 && status < 300) {
    return success(status, finalUrl, contentType, body, started);
  }
  if (status >= 300 && status < 400) {
    // `redirect: 'follow'` should have resolved these.
    return failure(status, finalUrl, started, `Unfollowed redirect: HTTP ${status}`);
  }
  return failure(status, finalUrl, started, `HTTP ${status}`);
}

function success(
  status: number,
  finalUrl: string,
  contentType: string,
  body: string,
  started: number,
): CheckResult {
  const { isSitemap, parseError } = inspectForSitemap(contentType, body);
  return build("up", status, finalUrl, started, parseError, isSitemap);
}

function failure(
  httpStatus: number | null,
  finalUrl: string,
  started: number,
  message: string,
): CheckResult {
  return build("down", httpStatus, finalUrl, started, message, false);
}

function inspectForSitemap(
  contentType: string,
  body: string,
): { isSitemap: boolean; parseError: string | null } {
  if (!XML_CONTENT_TYPE.test(contentType)) {
    return { isSitemap: false, parseError: null };
  }

  // Strict validation first — fast-xml-parser's parser is otherwise
  // permissive and would happily return `{}` for truncated bodies.
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    return {
      isSitemap: false,
      parseError: `Body advertised XML but failed to parse: ${validation.err.msg}`,
    };
  }

  const doc = parser.parse(body) as Record<string, unknown>;
  const rootName = Object.keys(doc)[0];
  return {
    isSitemap: rootName ? SITEMAP_ROOT_ELEMENTS.has(rootName) : false,
    parseError: null,
  };
}

function build(
  status: Status,
  httpStatus: number | null,
  finalUrl: string,
  started: number,
  errorMessage: string | null,
  isSitemap: boolean,
): CheckResult {
  return {
    status,
    httpStatus,
    responseTimeMs: Math.round(performance.now() - started),
    finalUrl,
    errorMessage,
    isSitemap,
    checkedAt: new Date(),
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code
      ?? ((err as { cause?: { code?: string } }).cause?.code);
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      return `Connection failed: ${err.message}`;
    }
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
      return `Timed out: ${err.message}`;
    }
    return `${err.constructor.name}: ${err.message}`;
  }
  return String(err);
}
