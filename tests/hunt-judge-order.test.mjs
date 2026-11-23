import assert from "node:assert/strict";
import { test } from "node:test";
import { quickFirst, worthJudging } from "../lib/hunt-judge-order.mjs";
import { pickCandidates } from "../scripts/hunt-autoscore.mjs";

test("quickFirst: 5 before 4 before none; ties keep the caller's order; 1s are not worth judging", () => {
  const rows = [{ id: "a", quick_score: 3, c: 90 }, { id: "b", quick_score: 5, c: 10 }, { id: "c", c: 99 }, { id: "d", quick_score: 5, c: 50 }];
  assert.deepEqual([...rows].sort(quickFirst((x, y) => y.c - x.c)).map((r) => r.id), ["d", "b", "a", "c"]);
  assert.equal(worthJudging({ quick_score: 1 }), false);
  assert.equal(worthJudging({ quick_score: 2 }), true);
  assert.equal(worthJudging({}), true);
});

test("daily autoscore picks the highest quick scores first and never a 1", () => {
  const job = (o) => ({ source: "inbox", fit: null, composite: 50, level: { key: "senior" }, locationTier: 1, role: "Senior Software Engineer", ...o });
  const jobs = {
    topRankQuick3: job({ company: "A", composite: 95, quick_score: 3 }),
    quick5: job({ company: "B", composite: 60, quick_score: 5 }),
    quick4: job({ company: "C", composite: 70, quick_score: 4 }),
    quick1: job({ company: "D", composite: 99, quick_score: 1 }),
    unscored: job({ company: "E", composite: 98 }),
  };
  assert.deepEqual(pickCandidates(jobs, { count: 10 }).map((p) => p.url), ["quick5", "quick4", "topRankQuick3", "unscored"]);
  assert.deepEqual(pickCandidates(jobs, { count: 2 }).map((p) => p.url), ["quick5", "quick4"]);
});
