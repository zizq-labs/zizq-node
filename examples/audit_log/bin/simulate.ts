// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

// Fire one (or N) fake-but-plausible `audit.create` job(s) at the
// local Zizq server. Run via:
//
//   npm run simulate            # one event
//   npm run simulate 50         # fifty events
//
// To stream at variable intervals from a shell loop:
//
//   while true; do npm run simulate; sleep $((RANDOM % 3 + 1)); done
//
// This is a *producer* — it shares no code with the audit app. If
// you ported it to Ruby, Python, or Go, the audit app would still
// happily ingest the events it produces.

import { Client } from "@zizq-labs/zizq";
import { ZIZQ_QUEUE } from "../src/audit-router.ts";

const client = new Client({
  url: process.env.ZIZQ_URL ?? "http://127.0.0.1:7890",
});

const USERS = [
  "alice@example.com",
  "bob@example.com",
  "chris@example.com",
  "diana@example.com",
  "eve@example.com",
];
const ADMINS = ["ops@example.com", "admin@example.com"];
const IPS: (string | null)[] = [
  "203.0.113.7",
  "198.51.100.12",
  "192.0.2.99",
  "10.0.0.45",
  null,
];

interface EventSpec {
  actor?: string;
  resource: string;
  text: string;
  data: Record<string, unknown>;
}

type Builder = () => EventSpec;

const EVENTS: Array<[[string, string], Builder]> = [
  [["billing_api", "invoice.refunded"], () => {
    const cents = randInt(100, 50_000);
    const card = String(randInt(0, 9_999)).padStart(4, "0");
    return {
      resource: `invoice:${randInt(1000, 9999)}`,
      text: `Refunded $${(cents / 100).toFixed(2)} to card ending ${card}`,
      data: { amount_cents: cents, card_last4: card },
    };
  }],
  [["billing_api", "invoice.created"], () => {
    const cents = randInt(500, 120_000);
    const items = randInt(1, 8);
    return {
      resource: `invoice:${randInt(1000, 9999)}`,
      text: `Invoiced $${(cents / 100).toFixed(2)} across ${items} item(s)`,
      data: { amount_cents: cents, items_count: items },
    };
  }],
  [["billing_api", "payment.failed"], () => {
    const cents = randInt(500, 50_000);
    const reason = pick([
      "insufficient_funds",
      "card_declined",
      "expired_card",
      "processor_timeout",
    ]);
    return {
      actor: "system",
      resource: `invoice:${randInt(1000, 9999)}`,
      text: `Payment of $${(cents / 100).toFixed(2)} failed: ${reason}`,
      data: { amount_cents: cents, reason },
    };
  }],
  [["auth_service", "user.login.success"], () => {
    const method = pick(["password", "sso", "mfa"]);
    return {
      resource: `user:${randInt(100, 999)}`,
      text: `Signed in via ${method}`,
      data: { method },
    };
  }],
  [["auth_service", "user.login.failed"], () => {
    const reason = pick(["bad_password", "user_locked", "mfa_failed"]);
    return {
      resource: `user:${randInt(100, 999)}`,
      text: `Failed sign-in: ${reason}`,
      data: { reason, attempts_today: randInt(1, 7) },
    };
  }],
  [["auth_service", "mfa.enabled"], () => {
    const method = pick(["totp", "webauthn", "sms"]);
    return {
      resource: `user:${randInt(100, 999)}`,
      text: `Enabled MFA via ${method}`,
      data: { method },
    };
  }],
  [["admin_console", "permission.granted"], () => {
    const role = pick(["admin", "auditor", "billing_manager", "support"]);
    const target = `user:${randInt(100, 999)}`;
    return {
      actor: pick(ADMINS),
      resource: target,
      text: `Granted role ${role}`,
      data: { role, target },
    };
  }],
  [["admin_console", "user.suspended"], () => {
    const reason = pick(["fraud_review", "tos_violation", "manual_request"]);
    return {
      actor: pick(ADMINS),
      resource: `user:${randInt(100, 999)}`,
      text: `Suspended: ${reason}`,
      data: { reason },
    };
  }],
  [["crm", "contact.created"], () => {
    const first = pick(["Alex", "Sam", "Robin", "Jordan", "Riley", "Pat", "Casey", "Morgan"]);
    const last = pick(["Brown", "Smith", "Lee", "Patel", "Garcia", "Nguyen", "Cohen", "Davis"]);
    return {
      resource: `contact:${randInt(10_000, 99_999)}`,
      text: `Created contact ${first} ${last}`,
      data: {
        first_name: first,
        last_name: last,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@example.org`,
      },
    };
  }],
  [["crm", "deal.won"], () => {
    const cents = randInt(50_000, 500_000);
    return {
      resource: `deal:${randInt(1000, 9999)}`,
      text: `Closed deal for $${(cents / 100).toFixed(2)}`,
      data: { value_cents: cents, stage: "closed_won" },
    };
  }],
];

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)]!;
}

function randomEvent() {
  const [[source, type], build] = pick(EVENTS);
  const spec = build();
  const occurred = new Date(Date.now() - randInt(0, 30) * 1000);
  return {
    occurred_at: occurred.toISOString(),
    source,
    event_type: type,
    actor: spec.actor ?? pick(USERS),
    ip: pick(IPS),
    resource: spec.resource,
    text: spec.text,
    data: spec.data,
  };
}

const count = Number(process.argv[2] ?? "1");
try {
  for (let i = 0; i < count; i++) {
    const payload = randomEvent();
    await client.enqueue({
      type: "audit.create",
      queue: ZIZQ_QUEUE,
      payload,
    });
    console.log(`${payload.source}/${payload.event_type} <- ${payload.text}`);
  }
} finally {
  await client.close();
}
