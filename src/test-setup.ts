// Copyright (c) 2026 Chris Corbyn <chris@zizq.io>
// Licensed under the MIT License. See LICENSE file for details.

/**
 * Loaded before every test via `node --import`.
 *
 * Suppresses the `ZIZQ_JOB_FUNCTIONS_DEPRECATED` warning during test
 * runs — the tests that exercise the deprecated code paths still need
 * to run, and we don't want their output cluttered with the same
 * migration hint they're validating. Any other warning (Node's own
 * experimental notices, real deprecations from dependencies) flows
 * through unchanged.
 *
 * @module
 */

const SUPPRESSED_CODES = new Set(["ZIZQ_JOB_FUNCTIONS_DEPRECATED"]);

const originalListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning instanceof Error &&
    "code" in warning &&
    typeof warning.code === "string" &&
    SUPPRESSED_CODES.has(warning.code)
  ) {
    return;
  }
  // Re-dispatch to whatever the default handler would have done.
  for (const listener of originalListeners) {
    listener(warning);
  }
});
