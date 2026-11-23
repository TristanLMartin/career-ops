// hunt: Best overall (the one #N), the other sorts, the card line, and Home following Jobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitLabel, payValue, placeLabel, rankCaption, rankMap, rankSettings, rankedJobs, shortPay, sortValue, warningChip } from "../../src/lib/hunt-rank-order.mjs";
import { homeSections, trueRank, worthALook } from "../../src/lib/hunt-home-v2.mjs";

const job = (o) => ({ source: "inbox", composite: 50, groupLeader: true, ...o });
const JOBS = {
  a: job({ company: "A", h2h_rank: 2, fit: 3.9, composite: 70 }),
  b: job({ company: "B", h2h_rank: 1, fit: 4.0, composite: 60 }),
  c: job({ company: "C", fit: 4.4, composite: 80 }), // evaluated after the tournament
  d: job({ company: "D", quick_score: 5, composite: 90 }),
  e: job({ company: "E", quick_score: 4, composite: 85, relevanceEst: true }),
  f: job({ company: "F", fit: 4.1, composite: 75, status: "Rejected" }),
  g1: job({ company: "G", fit: 3.8, composite: 65, group: "g", groupLeader: true }),
  g2: job({ company: "G", fit: 3.8, composite: 64, group: "g", groupLeader: false }),
  grp: job({ company: "H", h2h_rank: 3, h2hVia: "group", fit: 3.5, composite: 40 }),
};

test("Best overall: one 1-5 score (quick, or the judged decimal), judged and unjudged on one scale", () => {
  // d quick 5 > c 4.4 > b 4.0 = e quick 4 (tie: b's head-to-head place) > a 3.9 > g1 3.8 > grp 3.5
  assert.deepEqual(rankedJobs(JOBS).map((e) => e.url), ["d", "c", "b", "e", "a", "g1", "grp"]);
});

test("closed jobs are not ranked; duplicate-group members share the leader's #", () => {
  const m = rankMap(JOBS);
  assert.equal(m.get("f"), undefined);
  assert.equal(m.get("g2"), m.get("g1"));
});

test("an unjudged quick 5 ranks above a judged 4.4; a judged 4.4 above an unjudged 4", () => {
  const m = rankMap(JOBS);
  assert.ok(m.get("d") < m.get("c"), "unjudged quick 5 above judged 4.4");
  assert.ok(m.get("c") < m.get("e"), "judged 4.4 above unjudged quick 4");
  assert.equal(m.get("d"), 1);
});

test("Home's order is a subsequence of the Jobs order, with the same numbers", () => {
  const jobsOrder = rankedJobs(JOBS).map((e) => e.url);
  const home = trueRank(JOBS);
  let i = 0;
  for (const e of home) {
    i = jobsOrder.indexOf(e.url, i);
    assert.ok(i >= 0, `${e.url} out of order`);
    assert.equal(e.rank, rankMap(JOBS).get(e.url));
  }
  const worth = worthALook(JOBS, 100).map((e) => e.url);
  assert.deepEqual(worth, jobsOrder.filter((u) => worth.includes(u)));
  // New since last visit: ranked by Best overall too
  const firstSeen = Object.fromEntries(Object.keys(JOBS).map((u) => [u, "2026-11-21T10:00:00Z"]));
  const { fresh } = homeSections({ jobs: JOBS, firstSeen, lastVisit: "2026-11-20T00:00:00Z" });
  assert.deepEqual(fresh.map((e) => e.url), jobsOrder.filter((u) => fresh.some((f) => f.url === u)));
});

test("Best fit: full evaluation, then quick score; a full evaluation wins a tie", () => {
  assert.ok(sortValue({ fit: 4 }, "fit") > sortValue({ quick_score: 4 }, "fit"));
  assert.ok(sortValue({ quick_score: 5 }, "fit") > sortValue({ fit: 4.4 }, "fit"));
  assert.equal(sortValue({}, "fit"), null);
});

test("Highest pay: est. TC for a TC profile, else the posted base; no pay sorts last", () => {
  const tc = rankSettings({ pay_basis: "tc" });
  const base = rankSettings({ pay_basis: "base" });
  const e = { pay: { currency: "USD", annualMin: 180000, annualMax: 220000, min: 180000, max: 220000 }, tc_est: { usd: 400000 } };
  assert.deepEqual(payValue(e, tc), { usd: 400000, kind: "est. TC" });
  assert.deepEqual(payValue(e, base), { usd: 200000, kind: "posted base" });
  assert.equal(sortValue({}, "pay", base), null);
  assert.equal(payValue({ pay: { currency: "USD", annualMin: 41600, annualMax: 45760, period: "hour", min: 20, max: 22 } }, base).kind, "hourly, annualized");
});

test("the card line: fit or quick, short pay, place; one warning chip at most", () => {
  assert.equal(fitLabel({ fit: 4.2, quick_score: 5 }), "Fit 4.2/5");
  assert.equal(fitLabel({ quick_score: 4 }), "Quick 4/5");
  assert.equal(shortPay({ pay: { currency: "USD", min: 172000, max: 280000, annualMin: 172000, annualMax: 280000 }, tc_est: { usd: 570000 } }), "$172–280k base · ~$570k TC est.");
  assert.equal(shortPay({ pay: { currency: "USD", min: 20, max: 22, period: "hour", annualMin: 41600, annualMax: 45760 } }), "$20–22/hr");
  assert.equal(shortPay({}), null);
  assert.equal(placeLabel({ locationTier: 2, location: "Remote - USA" }), "Remote US");
  assert.equal(warningChip({ caution: true, belowFloor: true }).label, "Caution: layoffs");
  assert.equal(warningChip({}), null);
});

test("the caption: your ratings, then the 1-5 score, then pay and location (preferred places named)", () => {
  const t = rankCaption(rankSettings({ location_scores: { 1: 100, 2: 100, 3: 50, 4: 20, 5: 70 } }));
  assert.match(t, /^Best overall: your ratings first, then the 1-5 score \(Sonnet's decimal once judged\), then pay and location \(Seattle\/remote first\)/);
});
