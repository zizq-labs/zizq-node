// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Web entrypoint. Read-only Express server that renders the audit
// feed. Jobs run in a separate `worker` process — see `bin/worker`.

import { createApp } from "./app.ts";
import { openDb, defaultDbPath } from "./db.ts";
import { migrate } from "./migrate.ts";

const bind = process.env.BIND ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "3000");
const dbPath = process.env.DATABASE_PATH ?? defaultDbPath();

const db = openDb(dbPath);
migrate(db);

const app = createApp({ db });
const server = app.listen(port, bind, () => {
  console.log(`[audit_log] web listening on http://${bind}:${port}`);
});

function shutdown(signal: string): void {
  console.log(`[audit_log] ${signal} — shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
