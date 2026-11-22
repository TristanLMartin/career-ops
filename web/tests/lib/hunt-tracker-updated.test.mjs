// "updated" on tracker rows is when the row last changed, never a future date from the notes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lastUpdate, trackerRows } from "../../src/lib/hunt-tracker.mjs";

const NOW = Date.parse("2026-11-21T16:00:00");
const hex = { n: "435", date: "2026-11-21", company: "Hex", role: "Senior/Staff Engineer", status: "Interview", url: "",
  notes: "Agency recruiter (Paraform), intro call scheduled Tue 2026-11-24 1:00-1:20 PM PT; Next: Hex intro call (via Paraform) Tue 11/24 1:00 PM PT" };

test("a future date written in the notes is not the last update (row #435)", () => {
  assert.equal(lastUpdate(hex, [], NOW), "2026-11-21");
  assert.equal(trackerRows([hex], [], {}, NOW)[0].updated, "2026-11-21");
});

test("ledger and past note dates still win over an older Date column; nothing is later than today", () => {
  const row = { ...hex, date: "2026-11-01", notes: "applied 2026-11-05; call 2026-12-01" };
  assert.equal(lastUpdate(row, [], NOW), "2026-11-05");
  assert.equal(lastUpdate(row, [{ n: "435", date: "2026-11-12" }, { n: "435", date: "2026-11-30" }], NOW), "2026-11-12");
  assert.equal(lastUpdate({ ...row, notes: "" }, [{ n: "9", date: "2026-11-20" }], NOW), "2026-11-01");
});

test("a Date column later than today is capped at today", () => {
  assert.equal(lastUpdate({ n: "1", date: "2026-11-30", notes: "" }, [], NOW), "2026-11-21");
  assert.equal(lastUpdate({ n: "1", date: "", notes: "" }, [], NOW), "");
});
