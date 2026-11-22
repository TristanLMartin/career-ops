// hunt: stable first_seen_at per job (lib/hunt-first-seen.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignFirstSeen, historyFirstSeen, localMidnight } from "../lib/hunt-first-seen.mjs";

const H = "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n";
const R = "timestamp\tstatus\tnew_added\n";

test("history: older dates are local midnight; today's added rows take their scan run's time, in order", () => {
  const hist = H + "u1\t2026-11-20\tp\tt\tc\tadded\nu2\t2026-11-21\tp\tt\tc\tadded\nu3\t2026-11-21\tp\tt\tc\tskipped_title\nu4\t2026-11-21\tp\tt\tc\tadded\nu5\t2026-11-21\tp\tt\tc\tadded\n";
  const runs = R.replace("status\tnew_added", "status\tnew_added") + "2026-11-21T16:00:00.000Z\tcompleted\t1\n2026-11-21T20:00:00.000Z\tcompleted\t2\n";
  // the runs file's new_added column is the third here
  const m = historyFirstSeen(hist, runs, "2026-11-21");
  assert.equal(m.get("u1"), localMidnight("2026-11-20"));
  assert.equal(m.get("u2"), "2026-11-21T16:00:00.000Z");
  assert.equal(m.get("u3"), localMidnight("2026-11-21"), "skipped rows were not added by a run");
  assert.equal(m.get("u4"), "2026-11-21T20:00:00.000Z");
  assert.equal(m.get("u5"), "2026-11-21T20:00:00.000Z");
});

test("assign: set once, never overwritten; new URLs get history, tracker date, else now", () => {
  const now = Date.parse("2026-11-21T21:00:00Z");
  const history = new Map([["a", "2026-11-20T08:00:00.000Z"]]);
  const trackerDates = new Map([["b", "2026-11-19"]]);
  const { doc, added } = assignFirstSeen({ jobs: { old: "2026-10-01T00:00:00Z" } }, ["old", "a", "b", "c"], { history, trackerDates, now });
  assert.equal(added, 3);
  assert.equal(doc.jobs.old, "2026-10-01T00:00:00Z", "existing value kept");
  assert.equal(doc.jobs.a, "2026-11-20T08:00:00.000Z");
  assert.equal(doc.jobs.b, localMidnight("2026-11-19"));
  assert.equal(doc.jobs.c, new Date(now).toISOString(), "no evidence: the ingest time");
  const again = assignFirstSeen(doc, ["a", "c"], { history: new Map([["a", "2026-01-01T00:00:00Z"]]), now: now + 1e6 });
  assert.equal(again.added, 0);
  assert.equal(again.doc.jobs.a, "2026-11-20T08:00:00.000Z", "never rewritten by later evidence");
});
