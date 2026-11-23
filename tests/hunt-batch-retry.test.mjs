import assert from "node:assert/strict";
import { test } from "node:test";
import { retryKind } from "../lib/hunt-batch-retry.mjs";

test("retryKind: a gated verdict quoting a site's 429 is a job outcome, not a usage limit", () => {
  assert.equal(retryKind({ type: "error", msg: "gated: needs_confirmation: The job board posting returned HTTP 429 (rate limited) on two fetch attempts", costUsd: 0.09 }), false);
  assert.equal(retryKind({ type: "error", msg: "error: gated: dealbreaker: base below floor", costUsd: 0.05 }), false);
});

test("retryKind: real limits pause, silent failures retry, done and paid failures don't", () => {
  assert.equal(retryKind({ type: "error", msg: "Claude AI usage limit reached|1763856000" }), "limit");
  assert.equal(retryKind({ type: "error", msg: "API Error: 429 Too Many Requests" }), "limit");
  assert.equal(retryKind({ type: "error", msg: "no <<report-md>> envelope", costUsd: 0 }), "silent");
  assert.equal(retryKind({ type: "error", msg: "no <<report-md>> envelope", costUsd: 0.2 }), false);
  assert.equal(retryKind({ type: "done" }), false);
});
