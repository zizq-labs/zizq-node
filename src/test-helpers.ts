// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Shared test helpers for setting up undici mocks.

import { MockAgent } from "undici";
import { Client, type Format } from "./client.ts";
import { encode as msgpackEncode } from "@msgpack/msgpack";

export const BASE_URL = "http://localhost:7890";

export interface MockContext {
  mockAgent: MockAgent;
  mockPool: ReturnType<MockAgent["get"]>;
  client: Client;
}

/** Create a mock context with a MockAgent, MockPool, and Client wired together. */
export function createMockContext(format?: Format): MockContext {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  const mockPool = mockAgent.get(BASE_URL);
  const client = new Client({ url: BASE_URL, format, dispatcher: mockPool });
  return { mockAgent, mockPool, client };
}

/** Build an NDJSON body from job objects. */
export function ndjsonBody(jobs: object[]): string {
  return jobs.map((j) => JSON.stringify(j)).join("\n") + "\n";
}

/** Encode a value as a msgpack Buffer for use in mock replies. */
export function msgpackBody(value: unknown): Buffer {
  return Buffer.from(msgpackEncode(value));
}

/**
 * Build a length-prefixed msgpack stream body from job objects.
 *
 * Frame format: [4-byte big-endian length][msgpack payload].
 */
export function msgpackStreamBody(jobs: object[]): Buffer {
  const frames: Buffer[] = [];
  for (const job of jobs) {
    const payload = Buffer.from(msgpackEncode(job));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    frames.push(header, payload);
  }
  return Buffer.concat(frames);
}
