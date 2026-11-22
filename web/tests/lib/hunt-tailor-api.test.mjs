// hunt: /api/profile/tailor — request validation, run start (detached script), state reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coverSuggestions, readOne, readTailorState, startTailorRun, statePath, validateTailorRequest, STALE_MS } from "../../src/lib/hunt-tailor.mjs";

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-api-"));
  fs.mkdirSync(path.join(r, "reports"));
  fs.writeFileSync(path.join(r, "reports", "274-acme-2026-11-21.md"), "# Evaluation: Acme — FDE\n\n| Archetype | Forward Deployed Engineer (your primary target), with X |\n| Function | Build inside customer environments |\n| Domain | Enterprise AI |\n");
  return r;
}

test("validateTailorRequest: kinds, report number, cover needs all three answers", () => {
  assert.deepEqual(validateTailorRequest({ kind: "answers", report: "274" }), { ok: true, kind: "answers", report: "274", brief: null });
  assert.equal(validateTailorRequest({ kind: "submit", report: "274" }).ok, false);
  assert.equal(validateTailorRequest({ kind: "answers", report: "../x" }).ok, false);
  assert.equal(validateTailorRequest(null).ok, false);
  assert.match(validateTailorRequest({ kind: "cover", report: 274, brief: { why: "w", problem: "", approach: "a" } }).error, /all four/);
  assert.deepEqual(validateTailorRequest({ kind: "cover", report: 274, brief: { why: " w ", problem: "p", approach: "a", tone: "nonsense" } }).brief, { why: "w", problem: "p", approach: "a", tone: "mirror" });
  assert.match(validateTailorRequest({ kind: "cover", report: "1", brief: { why: "x".repeat(1001), problem: "p", approach: "a" } }).error, /1000/);
});

test("startTailorRun: spawns the runner detached with the brief file; refuses a second run; 404 without a report", () => {
  const r = root();
  const calls = [];
  const spawnFn = (bin, args, opts) => { calls.push({ bin, args, opts }); return { unref() {} }; };
  const ok = startTailorRun({ root: r, codeRoot: "/code", kind: "cover", report: "274", brief: { why: "w", problem: "p", approach: "a", tone: "direct" }, spawnFn, nodePath: "node" });
  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 6), ["/code/scripts/hunt-tailor-run.mjs", "--yes", "--kind", "cover", "--report", "274"]);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.env.CAREER_OPS_ROOT, r);
  const briefFile = calls[0].args[calls[0].args.indexOf("--input") + 1];
  assert.equal(JSON.parse(fs.readFileSync(briefFile, "utf8")).tone, "direct");
  assert.equal(readOne(r, "274", "cover").state, "running");
  const again = startTailorRun({ root: r, codeRoot: "/code", kind: "cover", report: "274", brief: {}, spawnFn });
  assert.deepEqual([again.ok, again.status], [false, 409]);
  const missing = startTailorRun({ root: r, codeRoot: "/code", kind: "answers", report: "9", spawnFn });
  assert.deepEqual([missing.ok, missing.status], [false, 404]);
  assert.equal(calls.length, 1);
});

test("readTailorState: a run silent past STALE_MS reads as failed; missing runs are null", () => {
  const r = root();
  fs.mkdirSync(path.join(r, "data", "hunt-tailor"), { recursive: true });
  fs.writeFileSync(statePath(r, 274, "answers"), JSON.stringify({ state: "running", updatedAt: "2026-11-22T00:00:00Z" }));
  const now = Date.parse("2026-11-22T00:00:00Z");
  assert.equal(readOne(r, 274, "answers", now + 1000).state, "running");
  assert.equal(readOne(r, 274, "answers", now + STALE_MS + 1000).state, "failed");
  assert.deepEqual(Object.keys(readTailorState(r, 274, now)), ["cover", "answers"]);
  assert.equal(readTailorState(r, 274, now).cover, null);
});

test("coverSuggestions reuses the report's labels, never its second-person prose", () => {
  const s = coverSuggestions(fs.readFileSync(path.join(root(), "reports", "274-acme-2026-11-21.md"), "utf8"));
  assert.equal(s.why, "Forward Deployed Engineer is the kind of role I am targeting.");
  assert.equal(s.problem, "Build inside customer environments (Enterprise AI)");
  assert.equal(s.tone, "mirror");
  assert.doesNotMatch(JSON.stringify(s), /\byour\b/i);
  assert.deepEqual(coverSuggestions(""), { why: "", problem: "", approach: "", tone: "mirror" });
});
