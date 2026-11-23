// hunt: ratings, posted age and liveness layered over the enrich data, and how Best overall uses them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRatingOp, applySignals, normalizeRatingsDoc, staleChip } from "../../src/lib/hunt-job-signals.mjs";
import { moreAtMap, rankMap, rankedJobs, spreadTop, warningChip } from "../../src/lib/hunt-rank-order.mjs";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const job = (o) => ({ composite: 60, groupLeader: true, ...o });

test("applySignals: rating reaches the whole duplicate group, posted age, closed", () => {
  const jobs = {
    "https://a/1": job({ company: "A", group: "a|swe", postedAt: "2024-06-14" }),
    "https://a/2": job({ company: "A", group: "a|swe", groupLeader: false }),
    "https://b/1": job({ company: "B", postedAt: "2026-11-01" }),
  };
  applySignals(jobs, { ratings: { "https://a/1": { rating: 4, note: "good", source: "manual" } }, liveness: { "https://b/1": { verdict: "expired" } }, now: NOW });
  assert.equal(jobs["https://a/1"].my_rating, 4);
  assert.equal(jobs["https://a/2"].my_rating, 4);
  assert.equal(jobs["https://a/1"].postedDays, 890);
  assert.equal(jobs["https://b/1"].postedDays, 20);
  assert.equal(jobs["https://b/1"].closed, true);
  assert.equal(jobs["https://a/1"].closed, undefined);
  // a member with its own 4.0+ evaluation is its own job: no rating by proxy
  const g = { "https://s/1": job({ company: "S", group: "s|swe", fit: 4.0 }), "https://s/2": job({ company: "S", group: "s|swe", groupLeader: false, fit: 4.0 }) };
  applySignals(g, { ratings: { "https://s/1": { rating: 4, source: "manual" } }, now: NOW });
  assert.equal(g["https://s/2"].my_rating, undefined);
});

test("ratings: a manual 4 beats an unrated 4.8; an inferred 4 (or one with no source) is only a note", () => {
  const jobs = {
    manual: job({ company: "M", fit: 3.5 }),
    inferred: job({ company: "I", fit: 3.5 }),
    legacy: job({ company: "L", fit: 3.5 }),
    strong: job({ company: "S", fit: 4.8 }),
  };
  applySignals(jobs, { ratings: { manual: { rating: 4, source: "manual" }, inferred: { rating: 4, note: "Good (review)", source: "inferred" }, legacy: { rating: 4 } }, now: NOW });
  assert.equal(jobs.manual.my_rating, 4);
  assert.equal(jobs.inferred.my_rating, undefined);
  assert.equal(jobs.legacy.my_rating, undefined);
  assert.equal(jobs.inferred.my_rating_said, "You said: looked good");
  assert.deepEqual(rankedJobs(jobs).map((e) => e.url), ["manual", "strong", "inferred", "legacy"]);
  // the job page writes manual ratings
  assert.equal(applyRatingOp({ ratings: {} }, { url: "https://x/1", rating: 4, at: "2026-11-22" }).ratings["https://x/1"].source, "manual");
});

test("stale: chip and penalty only past 60 days", () => {
  assert.equal(staleChip({ postedDays: 60 }), null);
  assert.equal(staleChip({ postedDays: 890, postedAt: "2024-06-14" }).label, "Posted 29mo ago");
  assert.equal(warningChip({ postedDays: 890, postedAt: "2024-06-14" }).label, "Posted 29mo ago");
  assert.equal(warningChip({ closed: true, postedDays: 890 }).label, "Closed");
});

test("Best overall: rating 4-5 on top (5 first), 3 neutral, 1-2 at the bottom", () => {
  const jobs = {
    five: job({ company: "V", fit: 3.0, my_rating: 5 }),
    four: job({ company: "R", fit: 3.5, my_rating: 4 }),
    best: job({ company: "T", fit: 4.6 }),
    three: job({ company: "H", fit: 4.0, my_rating: 3 }),
    meh: job({ company: "M", fit: 4.8, my_rating: 2 }),
    unscored: job({ company: "U", quick_score: 5 }),
  };
  // unscored's quick 5 outranks best's judged 4.6: one 1-5 scale
  assert.deepEqual(rankedJobs(jobs).map((e) => e.url), ["five", "four", "unscored", "best", "three", "meh"]);
});

test("Best overall: the 1-5 score first (exact); equal scores by TC band, then location, then freshness; head-to-head only breaks ties", () => {
  const jobs = {
    h2hTop: job({ company: "H", fit: 3.9, h2h_rank: 1, tc_est: { usd: 600000 } }),
    better: job({ company: "B", fit: 4.1 }),
    highPay: job({ company: "P", fit: 4.0, tc_est: { usd: 420000 }, locationTier: 3 }),
    lowPay: job({ company: "L", fit: 4.0, tc_est: { usd: 210000 }, locationTier: 1 }),
    noPay: job({ company: "N", fit: 4.0, locationTier: 1 }), // neutral $250k: between the two
    staleHigh: job({ company: "S", fit: 4.0, tc_est: { usd: 420000 }, locationTier: 3, postedDays: 400 }),
    unscored: job({ company: "U", quick_score: 5, tc_est: { usd: 900000 } }),
  };
  // unscored (quick 5) > better (4.1) > the 4.0s, ordered among themselves by pay band (noPay = neutral
  // $250k, between), staleHigh (400 days) losing only the freshness tie to highPay > h2hTop (3.9).
  assert.deepEqual(rankedJobs(jobs).map((e) => e.url), ["unscored", "better", "highPay", "staleHigh", "noPay", "lowPay", "h2hTop"]);
  const tie = { x: job({ company: "X", fit: 4.0, h2h_rank: 9 }), y: job({ company: "Y", fit: 4.0, h2h_rank: 3 }) };
  assert.deepEqual(rankedJobs(tie).map((e) => e.url), ["y", "x"]);
});

test("Best overall: a 4.0+ group member with its own evaluation is ranked on its own, not hidden behind its leader", () => {
  const jobs = {
    lead: job({ company: "A", fit: 3.4, group: "a|swe", groupLeader: true }),
    strong: job({ company: "A", fit: 4.1, group: "a|swe", groupLeader: false }),
    inherited: job({ company: "A", fit: 4.1, fitVia: "group", group: "a|swe", groupLeader: false }),
  };
  const r = rankedJobs(jobs).map((e) => e.url);
  assert.deepEqual(r, ["strong", "lead"]);
  assert.equal(rankMap(jobs).get("inherited"), rankMap(jobs).get("lead"), "an inherited fit still shares the leader's #");
});

test("spreadTop: a job you rated 4+ is never pushed out of the top by the per-company cap", () => {
  const sorted = [{ company: "R" }, { company: "R" }, { company: "R", my_rating: 4 }, { company: "X" }].map((e, i) => ({ url: `u${i}`, ...e }));
  assert.deepEqual(spreadTop(sorted, { caps: [{ n: 3, perCompany: 2 }] }).map((e) => e.url), ["u0", "u1", "u2", "u3"]);
});

test("Best overall: a closed posting is not ranked", () => {
  assert.deepEqual(rankedJobs({ a: job({ company: "A", closed: true }), b: job({ company: "B" }) }).map((e) => e.url), ["b"]);
});

test("spreadTop: at most 2 per company in the top n, the rest follow with +N more", () => {
  const sorted = ["R", "R", "H", "R", "R", "X"].map((company, i) => ({ url: `u${i}`, company }));
  const out = spreadTop(sorted, { caps: [{ n: 4, perCompany: 2 }] });
  assert.deepEqual(out.map((e) => e.url), ["u0", "u1", "u2", "u5", "u3", "u4"]);
  assert.equal(out[1].moreAtCompany, 2);
  assert.equal(out[0].moreAtCompany, undefined);
  assert.equal(out[4].movedFromTop, true);
  const jobs = Object.fromEntries(sorted.map((e, i) => [e.url, job({ company: e.company, h2h_rank: i + 1 })]));
  assert.equal(moreAtMap(jobs).get("u1"), 2);
});

test("applyRatingOp: set, clear, refuse bad input; normalize drops junk", () => {
  const a = applyRatingOp({ ratings: {} }, { url: "https://x/1", rating: 4, note: " good ", at: "2026-11-21" });
  assert.deepEqual(a, { ratings: { "https://x/1": { rating: 4, note: "good", at: "2026-11-21", source: "manual" } } });
  assert.deepEqual(applyRatingOp(a, { url: "https://x/1", rating: null }), { ratings: {} });
  assert.equal(applyRatingOp(a, { url: "https://x/1", rating: 6 }), null);
  assert.equal(applyRatingOp(a, { url: "javascript:alert(1)", rating: 3 }), null);
  assert.deepEqual(normalizeRatingsDoc({ ratings: { "https://x/1": { rating: 9 }, "https://x/2": { rating: "3" } } }), { ratings: { "https://x/2": { rating: 3, source: "inferred" } } });
});
