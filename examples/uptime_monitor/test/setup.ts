// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Shared test bootstrap. Each test file constructs its own DB + mock
// agent + TestClient via `freshEnv()`.

import { DatabaseSync } from "node:sqlite";
import { MockAgent } from "undici";
import { TestClient } from "@zizq-labs/zizq";
import { migrate } from "../src/migrate.ts";

export interface TestEnv {
  db: DatabaseSync;
  mockAgent: MockAgent;
  client: TestClient;
}

export function freshEnv(): TestEnv {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();

  const client = new TestClient();

  return { db, mockAgent, client };
}
