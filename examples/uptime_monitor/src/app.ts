// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Express app factory. Boots read/write routes for the monitored
// URL list, form submission, and the polled `#urls` partial.

import express, { type Express } from "express";
import session from "express-session";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { Client } from "@zizq-labs/zizq";

import { CHECK_URL, ZIZQ_QUEUE } from "./jobs/queue.ts";
import {
  create as createMonitored,
  findByUrlScoped,
  listAllOrderedByLastCheck,
  ValidationError,
  type MonitoredUrl,
} from "./models/monitored-url.ts";
import { emit as emitAudit } from "./lib/audit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  db: DatabaseSync;
  client: Client;
  sessionSecret?: string;
}

export function createApp({ db, client, sessionSecret }: AppOptions): Express {
  const app = express();

  app.set("view engine", "ejs");
  app.set("views", `${HERE}/../views`);
  app.use(express.static(`${HERE}/../public`));
  app.use(express.urlencoded({ extended: false }));

  app.use(
    session({
      secret:
        sessionSecret ??
        process.env.SESSION_SECRET ??
        "dev_only_replace_in_env_local_for_stable_sessions_across_restarts",
      resave: false,
      saveUninitialized: false,
    }),
  );

  app.get("/", (req, res) => {
    const monitoredUrls = listAllOrderedByLastCheck(db);
    // Flash-style: consume the session values once and clear them.
    const notice = ((req.session as unknown as { notice?: string }).notice) ?? null;
    const alert = ((req.session as unknown as { alert?: string }).alert) ?? null;
    delete (req.session as unknown as { notice?: string }).notice;
    delete (req.session as unknown as { alert?: string }).alert;

    const view = req.get("X-Requested-With") === "XMLHttpRequest"
      ? "_urls"
      : "index";

    res.render(view, {
      monitoredUrls,
      notice,
      alert,
      helpers: { timeAgo },
    });
  });

  app.post("/monitored_urls", async (req, res) => {
    const url = normalizeUrl(String((req.body as { url?: string }).url ?? ""));

    let monitored: MonitoredUrl | null = findByUrlScoped(db, url, null);
    let created = false;

    if (monitored) {
      (req.session as unknown as { notice?: string }).notice = `Re-checking ${url}`;
    } else {
      try {
        monitored = createMonitored(db, { url });
        created = true;
        (req.session as unknown as { notice?: string }).notice = `Now monitoring ${url}`;
      } catch (err) {
        if (err instanceof ValidationError) {
          (req.session as unknown as { alert?: string }).alert = err.message;
        } else if (isUniqueViolation(err)) {
          // Race window between the find and the create — retry.
          monitored = findByUrlScoped(db, url, null);
          (req.session as unknown as { notice?: string }).notice = `Re-checking ${url}`;
        } else {
          throw err;
        }
      }
    }

    if (monitored) {
      await client.enqueue({
        type: CHECK_URL,
        queue: ZIZQ_QUEUE,
        payload: { id: monitored.id },
      });

      if (created) {
        await emitAudit(client, {
          eventType: "url.added",
          actor: "user",
          resource: `monitored_url:${monitored.id}`,
          text: `Started monitoring ${url}`,
          data: { url },
        });
      }
    }

    res.redirect("/");
  });

  return app;
}

// --- Internal --------------------------------------------------------

/**
 * Trim and auto-prefix `https://` if no scheme is present. Anything
 * that already starts with `scheme://` is left alone; the model
 * validation rejects schemes other than http/https.
 */
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return trimmed;
  if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function timeAgo(time: Date | null | undefined): string {
  if (!time) return "never";
  const seconds = Math.floor((Date.now() - time.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}
