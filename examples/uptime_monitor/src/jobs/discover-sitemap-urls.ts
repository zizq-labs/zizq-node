// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Re-fetches a known sitemap URL, parses out the child <url><loc>
// entries, and reconciles them against existing MonitoredUrls with
// the same source_sitemap_url:
//
//   * URLs in the sitemap but not the DB → created (enabled).
//   * URLs in both DB and sitemap        → re-enabled if disabled.
//   * URLs in the DB but not the sitemap → disabled (kept for history).
//
// After reconciliation we bulk-enqueue an immediate CheckUrlJob for
// every enabled child.
//
// Sitemap-index files (<sitemapindex>) parse to zero <urlset><url><loc>
// matches and reconcile down to "no children", matching the Ruby
// example.

import { fetch, Agent, type Dispatcher } from "undici";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Client } from "@zizq-labs/zizq";
import type { DatabaseSync } from "node:sqlite";

import {
  ZIZQ_QUEUE,
  CHECK_URL,
} from "./queue.ts";
import {
  create as createMonitored,
  enabledSitemapChildrenIds,
  findByUrlScoped,
  get as getMonitored,
  reconcileSitemapChildren,
} from "../models/monitored-url.ts";
import { emit as emitAudit } from "../lib/audit.ts";

const TIMEOUT_MS = 30_000;
const BATCH_SIZE = 500;

const defaultAgent = new Agent({
  connectTimeout: 5_000,
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

const parser = new XMLParser({
  ignoreAttributes: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (_name, jpath) =>
    // Force `url` inside `urlset` to always be an array — fast-xml-parser
    // collapses single-element lists to a bare object by default.
    jpath === "urlset.url",
});

export interface DiscoverSitemapUrlsPayload {
  id: number;
}

export interface DiscoverSitemapUrlsDeps {
  db: DatabaseSync;
  client: Client;
  /** Undici dispatcher for the sitemap fetch. Injected in tests. */
  dispatcher?: Dispatcher;
}

export async function discoverSitemapUrls(
  payload: DiscoverSitemapUrlsPayload,
  deps: DiscoverSitemapUrlsDeps,
): Promise<void> {
  const sitemap = getMonitored(deps.db, payload.id);
  if (!sitemap) return;

  const body = await fetchBody(sitemap.url, deps.dispatcher);
  if (body === null) return;

  const discovered = extractUrls(body);
  if (discovered === null) return; // parse error: leave children untouched

  reconcile(deps.db, sitemap.url, discovered);
  await emitAudit(deps.client, {
    eventType: "sitemap.scanned",
    actor: "system",
    resource: `monitored_url:${sitemap.id}`,
    text: `Found ${discovered.length} URL(s) in ${sitemap.url}`,
    data: {
      sitemap_url: sitemap.url,
      discovered_count: discovered.length,
    },
  });
  await enqueueImmediateChecks(deps, sitemap.url);
}

// --- Internal --------------------------------------------------------

async function fetchBody(
  url: string,
  dispatcher: Dispatcher | undefined,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      dispatcher: dispatcher ?? defaultAgent,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return await res.text();
  } catch (err) {
    console.warn(
      `[discover-sitemap-urls] failed to fetch ${url}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

function extractUrls(body: string): string[] | null {
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    console.warn(
      `[discover-sitemap-urls] malformed sitemap body: ${validation.err.msg}`,
    );
    return null;
  }

  const doc = parser.parse(body) as { urlset?: { url?: Array<{ loc?: string }> } };
  const entries = doc.urlset?.url ?? [];
  return entries
    .map((e) => String(e.loc ?? "").trim())
    .filter((s) => s.length > 0);
}

function reconcile(
  db: DatabaseSync,
  sitemapUrl: string,
  discovered: string[],
): void {
  // Create any URLs we haven't seen before under this parent. We
  // check-then-create rather than INSERT OR IGNORE so validation runs
  // (URL scheme check, etc.).
  for (const url of discovered) {
    if (findByUrlScoped(db, url, sitemapUrl)) continue;
    try {
      createMonitored(db, {
        url,
        source: "sitemap",
        sourceSitemapUrl: sitemapUrl,
      });
    } catch (err) {
      // Race window with another worker; the row exists now, fine.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  reconcileSitemapChildren(db, sitemapUrl, discovered);
}

async function enqueueImmediateChecks(
  deps: DiscoverSitemapUrlsDeps,
  sitemapUrl: string,
): Promise<void> {
  const ids = enabledSitemapChildrenIds(deps.db, sitemapUrl);
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await deps.client.enqueueBulk(
      batch.map((id) => ({
        type: CHECK_URL,
        queue: ZIZQ_QUEUE,
        payload: { id },
      })),
    );
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /UNIQUE constraint failed/i.test(err.message);
}
