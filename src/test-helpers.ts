// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Shared test helpers for setting up undici mocks.

import { MockAgent } from "undici";
import { Client } from "./client.ts";

export const BASE_URL = "http://localhost:7890";

export interface MockContext {
  mockAgent: MockAgent;
  mockPool: ReturnType<MockAgent["get"]>;
  client: Client;
}

/** Create a mock context with a MockAgent, MockPool, and Client wired together. */
export function createMockContext(): MockContext {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const mockPool = mockAgent.get(BASE_URL);
  const client = new Client({ url: BASE_URL, dispatcher: mockPool });
  return { mockAgent, mockPool, client };
}

/** Build an NDJSON body from job objects. */
export function ndjsonBody(jobs: object[]): string {
  return jobs.map((j) => JSON.stringify(j)).join("\n") + "\n";
}
