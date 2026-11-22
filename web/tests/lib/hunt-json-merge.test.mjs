// hunt: marks / study writes keep unknown top-level keys and per-item fields.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MARKS_MAPS, STUDY_MAPS, mergeKnown, updateJsonFile } from "../../src/lib/hunt-json-merge.mjs";
import { applyMarkOp, normalizeMarks } from "../../src/lib/hunt-message-kinds.mjs";
import { applyOp, normalizeState } from "../../src/lib/hunt-study.mjs";

const tmpFile = (name, doc) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-merge-"));
  const f = path.join(dir, name);
  if (doc !== undefined) fs.writeFileSync(f, JSON.stringify(doc));
  return f;
};
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const noTmp = (f) => assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith(".tmp")), []);

test("marks: unknown top-level key survives a mark write", () => {
  const f = tmpFile("message-marks.json", { marks: {}, kindOverrides: {}, updatedAt: null, mcpNote: { by: "mcp", v: 2 } });
  const next = updateJsonFile(f, normalizeMarks, (s) => applyMarkOp(s, { op: "mark", id: "t1", mark: "done", lastDate: "2026-11-20" }), [...MARKS_MAPS]);
  const doc = read(f);
  assert.deepEqual(doc.mcpNote, { by: "mcp", v: 2 });
  assert.equal(doc.marks.t1.mark, "done");
  assert.deepEqual(Object.keys(next).sort(), ["kindOverrides", "marks", "updatedAt"], "returned state keeps its shape");
  noTmp(f);
});

test("marks: per-item extra fields survive, on the touched item and on others", () => {
  const f = tmpFile("message-marks.json", {
    marks: {
      t1: { mark: "done", at: "a", lastDate: "d", source: "phone" },
      t2: { mark: "wont", at: "b", lastDate: "e", note: "recruiter spam" },
      t3: { mark: "snooze", until: "2026-12-01" }, // a mark this build doesn't know
    },
    kindOverrides: { t9: { kind: "bogus-kind", at: "x", why: "newer build" } },
  });
  updateJsonFile(f, normalizeMarks, (s) => applyMarkOp(s, { op: "mark", id: "t1", mark: "wont", lastDate: "d2" }), [...MARKS_MAPS]);
  const doc = read(f);
  assert.equal(doc.marks.t1.mark, "wont");
  assert.equal(doc.marks.t1.source, "phone");
  assert.equal(doc.marks.t2.note, "recruiter spam");
  assert.deepEqual(doc.marks.t3, { mark: "snooze", until: "2026-12-01" });
  assert.deepEqual(doc.kindOverrides.t9, { kind: "bogus-kind", at: "x", why: "newer build" });
});

test("marks: clearing a mark still deletes the item", () => {
  const f = tmpFile("message-marks.json", { marks: { t1: { mark: "done", at: "a", lastDate: "d", extra: 1 } }, keep: true });
  updateJsonFile(f, normalizeMarks, (s) => applyMarkOp(s, { op: "mark", id: "t1", mark: null }), [...MARKS_MAPS]);
  const doc = read(f);
  assert.equal(doc.marks.t1, undefined);
  assert.equal(doc.keep, true);
});

test("marks: a bad op writes nothing", () => {
  const raw = { marks: {}, other: 1 };
  const f = tmpFile("message-marks.json", raw);
  assert.equal(updateJsonFile(f, normalizeMarks, (s) => applyMarkOp(s, { op: "nope", id: "t1" }), [...MARKS_MAPS]), null);
  assert.deepEqual(read(f), raw);
});

test("marks: a missing file is created", () => {
  const f = tmpFile("message-marks.json");
  updateJsonFile(f, normalizeMarks, (s) => applyMarkOp(s, { op: "kind", id: "t1", kind: null }), [...MARKS_MAPS]);
  assert.deepEqual(read(f).marks, {});
});

test("study: unknown top-level key survives a tick", () => {
  const f = tmpFile("study-state.json", { ticks: {}, flags: {}, reviewed: {}, startDate: "2026-11-10", notes: ["keep me"] });
  const next = updateJsonFile(f, normalizeState, (s) => applyOp(s, { op: "tick", id: "abc123", value: true }), [...STUDY_MAPS]);
  const doc = read(f);
  assert.deepEqual(doc.notes, ["keep me"]);
  assert.equal(doc.ticks.abc123, true);
  assert.equal(doc.startDate, "2026-11-10");
  assert.equal("notes" in next, false, "returned state keeps its shape");
});

test("study: per-item extras survive and untick still deletes", () => {
  const f = tmpFile("study-state.json", {
    ticks: { abc123: true, def456: true, "Weird-Id!": { at: "2026-11-01" } },
    flags: { card01: { why: "hard" } },
    reviewed: { card02: true },
  });
  updateJsonFile(f, normalizeState, (s) => applyOp(s, { op: "tick", id: "def456", value: false }), [...STUDY_MAPS]);
  const doc = read(f);
  assert.equal(doc.ticks.abc123, true);
  assert.equal(doc.ticks.def456, undefined);
  assert.deepEqual(doc.ticks["Weird-Id!"], { at: "2026-11-01" });
  assert.deepEqual(doc.flags.card01, { why: "hard" });
  assert.equal(doc.reviewed.card02, true);
});

test("mergeKnown: object items merge, known fields win", () => {
  const raw = { m: { a: { x: 1, extra: "e" } }, top: 1 };
  const out = mergeKnown(raw, { m: { a: { x: 1 } } }, { m: { a: { x: 2 } } }, ["m"]);
  assert.deepEqual(out, { m: { a: { x: 2, extra: "e" } }, top: 1 });
});
