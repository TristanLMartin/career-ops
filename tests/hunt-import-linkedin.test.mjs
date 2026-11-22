// Tests for scripts/hunt-import-linkedin.mjs and the pick rules in scripts/hunt-autoscore.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importLinkedIn, splitCompany, toRows } from "../scripts/hunt-import-linkedin.mjs";
import { pickCandidates } from "../scripts/hunt-autoscore.mjs";
import { LEGACY_TARGET as target } from "./helpers/swe-legacy-rules.mjs";

test("splitCompany: coworker notes, via-agency and parentheticals", () => {
  assert.deepEqual(splitCompany("ex-Initech coworker (now at a startup)"), { company: null, note: "ex-Initech coworker (now at a startup)", via: null });
  assert.deepEqual(splitCompany("Hex (via Paraform)"), { company: "Hex", note: null, via: "Paraform" });
  assert.deepEqual(splitCompany("Amazon (AWS)"), { company: "Amazon", note: "AWS", via: null });
  assert.deepEqual(splitCompany("The Voleon Group"), { company: "The Voleon Group", note: null, via: null });
});

test("toRows maps fields, forces needs-reply and sorts high priority first", () => {
  const rows = toRows({ unanswered: [
    { person: "Chris Park", company: "ex-Initech coworker", role: null, last_msg: "2026-11-02", priority: "low", summary: "s1", url: "https://www.linkedin.com/messaging/thread/2-Y1/" },
    { person: "Hannah Zacharia", company: "Rippling", role: "Senior-to-Staff SWE", last_msg: "2026-11-19", priority: "high", summary: "s2", url: "https://www.linkedin.com/messaging/thread/2-N1/" },
  ] });
  assert.deepEqual(rows.map((r) => r.fromName), ["Hannah Zacharia", "Chris Park"]);
  const h = rows[0];
  assert.equal(h.source, "linkedin-manual");
  assert.equal(h.company, "Rippling");
  assert.equal(h.subtitle, "Senior-to-Staff SWE");
  assert.equal(h.date, "2026-11-19T12:00:00Z");
  assert.equal(h.needsReplyOverride, true);
  assert.equal(h.replyVia, "linkedin");
  assert.equal(h.link, "https://www.linkedin.com/messaging/thread/2-N1/");
  assert.equal(h.threadId, "linkedin:2-N1");
  assert.equal(rows[1].company, null);
  assert.equal(rows[1].note, "ex-Initech coworker");
});

test("importLinkedIn replaces the output file entirely", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-li-"));
  fs.mkdirSync(path.join(root, "data"));
  const input = path.join(root, "data", "linkedin-unanswered.json");
  const out = path.join(root, "data", "hunt-messages.linkedin-manual.jsonl");
  fs.writeFileSync(out, '{"threadId":"stale"}\n');
  fs.writeFileSync(input, JSON.stringify({ unanswered: [{ person: "A B", company: "Hex", last_msg: "2026-11-18", priority: "high", url: "https://www.linkedin.com/messaging/thread/x/" }] }));
  assert.equal(importLinkedIn({ root, input }).rows, 1);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).fromName, "A B");
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});

test("autoscore picks: unscored inbox, on target (level, place or always-company, title exclusions), per-company cap", () => {
  const e = (company, composite, extra = {}) => ({ source: "inbox", fit: null, company, role: "Senior Software Engineer", composite, locationTier: 1, level: { key: "senior" }, ...extra });
  const jobs = {
    a1: e("A", 90), a2: e("A", 89), a3: e("A", 88),
    b1: e("B", 95, { level: { key: "staff" } }), c1: e("C", 94, { locationTier: 3 }), d1: e("DRW", 93, { locationTier: 3 }),
    e1: e("E", 92, { fit: 4.1 }), f1: e("F", 91, { role: "IT Systems Engineer" }), g1: e("G", 80, { level: { key: "dual" } }),
  };
  assert.deepEqual(pickCandidates(jobs, { count: 10, perCompany: 2, target }).map((p) => p.url), ["d1", "a1", "a2", "g1"]);
  assert.deepEqual(pickCandidates(jobs, { count: 2, perCompany: 2, target }).map((p) => p.url), ["d1", "a1"]);
});
