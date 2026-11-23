import assert from "node:assert/strict";
import { test } from "node:test";
import { gateHistory, gateKind, skipForGate } from "../lib/hunt-gate-history.mjs";

const tsv = (rows) => ["date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl", ...rows.map((r) => [r[0], r[1], r[2], 1, 1, 0.05, "", "Co", "Role", r[3]].join("\t"))].join("\n");

test("gateKind: floor and agency gates are permanent; unreadable postings can be retried", () => {
  assert.equal(gateKind("error: gated: dealbreaker: This breaks your rule: base salary floor of $200k"), "permanent");
  assert.equal(gateKind("error: gated: agency_confirmation: Agency confirmation needed"), "permanent");
  assert.equal(gateKind("error: gated: needs_confirmation: The posting returned HTTP 429"), "unreadable");
  assert.equal(gateKind("gated: jd_unavailable (Workday JS shell)"), "unreadable");
  assert.equal(gateKind("ok"), null);
  assert.equal(gateKind("error: no report"), null);
});

test("gateHistory keeps each job's latest evaluation; a later success clears it; spot-checks are ignored", () => {
  const h = gateHistory(tsv([
    ["2026-11-21T10:00:00Z", "spend_tier", "error: gated: dealbreaker: floor", "u1"],
    ["2026-11-22T10:00:00Z", "claude-sonnet-5-5 (reeval lite)", "error: gated: needs_confirmation: unreadable", "u2"],
    ["2026-11-22T11:00:00Z", "claude-sonnet-5-5 (reeval lite)", "ok", "u2"],
    ["2026-11-22T12:00:00Z", "claude-sonnet-5-5 (auto lite)", "error: gated: needs_confirmation: shell", "u3"],
    ["2026-11-22T13:00:00Z", "claude-opus-5-5 (spot-check lite)", "error: gated: dealbreaker: x", "u4"],
    ["2026-11-22T13:00:00Z", "claude-haiku-5-5 (quick score)", "ok 20/20", "u5"],
  ]));
  assert.deepEqual([...h.keys()].sort(), ["u1", "u3"]);
  const now = Date.parse("2026-11-23T00:00:00Z");
  assert.equal(skipForGate(h.get("u1"), now), true);
  assert.equal(skipForGate(h.get("u3"), now), true); // unreadable, less than 7 days ago
  assert.equal(skipForGate(h.get("u3"), now + 8 * 86400000), false); // retried after a week
  assert.equal(skipForGate(undefined, now), false);
});
