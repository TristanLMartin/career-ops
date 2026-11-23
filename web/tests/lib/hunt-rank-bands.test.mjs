// hunt: Best overall bands (2026-11-22): upstream score bands, TC bands within a band, stale
// demotion, favorite/stretch half-band boost, company caps, ratings always on top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitTier, levelDrop, payBand, rankedJobs, spreadTop, stretchLabel, tierUnits } from "../../src/lib/hunt-rank-order.mjs";
import { applySignals, staleChip } from "../../src/lib/hunt-job-signals.mjs";
import { inProgress } from "../../src/lib/hunt-home-v2.mjs";

const job = (o) => ({ source: "inbox", composite: 50, groupLeader: true, locationTier: 1, ...o });
const order = (jobs) => rankedJobs(jobs).map((e) => e.url);

test("fit tiers are upstream's bands: >=4.5 Strong apply, >=4.0 Apply, >=3.0 Maybe, else Skip", () => {
  assert.deepEqual([4.6, 4.5, 4.4, 4.0, 3.9, 3.0, 2.9].map(fitTier), [4, 4, 3, 3, 2, 2, 1]);
  assert.equal(fitTier(null), -1);
});

test("TC bands: $400k+, $300-400k, $250-300k, $200-250k, <$200k; missing pay is the $250k band", () => {
  assert.deepEqual([450e3, 300e3, 260e3, 200e3, 150e3].map(payBand), [4, 3, 2, 1, 0]);
  assert.equal(payBand(null), payBand(250e3));
});

test("the exact score beats pay inside a band (the 1-5 decides; pay only breaks exact ties)", () => {
  const jobs = {
    sentilink: job({ company: "SentiLink", fit: 4.3, tc_est: { usd: 200000 } }),
    openai: job({ company: "OpenAI", fit: 4.0, tc_est: { usd: 821000 } }),
    mid: job({ company: "Mid", fit: 4.2, tc_est: { usd: 320000 } }),
  };
  assert.deepEqual(order(jobs), ["sentilink", "mid", "openai"]);
});

test("a higher band still wins over pay", () => {
  const jobs = { strong: job({ company: "S", fit: 4.5, tc_est: { usd: 180000 } }), apply: job({ company: "A", fit: 4.4, tc_est: { usd: 600000 } }) };
  assert.deepEqual(order(jobs), ["strong", "apply"]);
});

test("your ratings stay above every band, even a Strong apply with top pay", () => {
  const raw = {
    "https://x/rated": job({ company: "Ramp", fit: 4.0, tc_est: { usd: 200000 } }),
    "https://x/strong": job({ company: "Top", fit: 4.8, tc_est: { usd: 900000 } }),
    "https://x/meh": job({ company: "Meh", fit: 4.8, tc_est: { usd: 900000 } }),
  };
  const jobs = applySignals(raw, { ratings: { "https://x/rated": { rating: 4, source: "manual" }, "https://x/meh": { rating: 2, source: "manual" } } });
  assert.deepEqual(order(jobs), ["https://x/rated", "https://x/strong", "https://x/meh"]);
});

test("posting age alone never demotes: a 900-day posting keeps its band; only a closed one leaves", () => {
  assert.equal(tierUnits({ fit: 4.0, postedDays: 900 }), tierUnits({ fit: 4.0, postedDays: 5 }));
  const raw = {
    "https://x/old": job({ company: "Old", fit: 4.2, postedAt: "2024-06-14", tc_est: { usd: 500000 } }),
    "https://x/new": job({ company: "New", fit: 4.0, postedAt: "2026-11-18", tc_est: { usd: 260000 } }),
    "https://x/gone": job({ company: "Gone", fit: 4.8, postedAt: "2026-11-18", tc_est: { usd: 900000 } }),
  };
  const jobs = applySignals(raw, { liveness: { "https://x/old": { verdict: "active", at: "2026-11-22" }, "https://x/gone": { verdict: "expired", at: "2026-11-22" } }, now: Date.parse("2026-11-22") });
  assert.deepEqual(order(jobs), ["https://x/old", "https://x/new"]);
  assert.match(staleChip(jobs["https://x/old"]).title, /answered live on 2026-11-22/);
});

test("a Staff 4.1 the report puts below the bar ranks below a Senior 4.0 in the same band", () => {
  const jobs = {
    staff: job({ company: "Anthropic", fit: 4.1, tc_est: { usd: 641000 }, level: { key: "staff", label: "Staff", factor: 0.45 }, report: { decision: "Consider", level: { meets: false, why: "Staff level: missing." } } }),
    senior: job({ company: "Snowflake", fit: 4.0, tc_est: { usd: 300000 }, level: { key: "senior", label: "Senior", factor: 1 } }),
  };
  assert.equal(fitTier(4.1), fitTier(4.0));
  assert.deepEqual(order(jobs), ["senior", "staff"]);
  assert.equal(stretchLabel(jobs.staff).label, "Stretch");
  assert.equal(stretchLabel(jobs.senior), null);
});

test("a Staff role the report says you meet keeps its band (still labeled Stretch); unevaluated or below-bar ones drop", () => {
  const staff = (o) => ({ level: { key: "staff", label: "Staff", factor: 0.45 }, fit: 4.1, ...o });
  assert.equal(levelDrop(staff({ report: { level: { meets: true, why: "a one-band stretch" } } })), false);
  assert.equal(levelDrop(staff({ report: { level: { meets: false } } })), true);
  assert.equal(levelDrop(staff({ report: null })), true);
  assert.equal(levelDrop(staff({ report: { level: { meets: false } }, my_rating: 3 })), false, "your own rating overrides");
  assert.equal(levelDrop({ level: { key: "senior" }, fit: 4.1 }), false);
  assert.equal(levelDrop({ level: { key: "dual" }, fit: 4.1 }), false, "Senior/Staff stays Senior");
  assert.equal(stretchLabel(staff({ report: { level: { meets: true } } })).label, "Stretch");
  const jobs = {
    meets: job({ company: "Anthropic", tc_est: { usd: 641000 }, ...staff({ report: { level: { meets: true } } }) }),
    senior: job({ company: "Snowflake", fit: 4.0, tc_est: { usd: 300000 }, level: { key: "senior", label: "Senior", factor: 1 } }),
  };
  assert.deepEqual(order(jobs), ["meets", "senior"]);
});

test("favorite/stretch companies (rankBoost) get half a band: above their band, below the next", () => {
  const jobs = {
    boosted: job({ company: "Stoke Space", fit: 4.0, rankBoost: true, tc_est: { usd: 150000 } }),
    apply: job({ company: "A", fit: 4.4, tc_est: { usd: 600000 } }),
    strong: job({ company: "S", fit: 4.5, tc_est: { usd: 150000 } }),
  };
  assert.deepEqual(order(jobs), ["strong", "boosted", "apply"]);
});

test("company cap: at most 2 per company in the top 20 and 4 in the top 50; a 4+ rating is never pushed down", () => {
  const sorted = [];
  for (let i = 0; i < 8; i++) sorted.push({ url: `big${i}`, company: "Big" });
  for (let i = 0; i < 60; i++) sorted.push({ url: `o${i}`, company: `Other${i}` });
  const out = spreadTop(sorted).map((e) => e.company);
  assert.equal(out.slice(0, 20).filter((c) => c === "Big").length, 2);
  assert.equal(out.slice(0, 50).filter((c) => c === "Big").length, 4);
  assert.equal(out.length, sorted.length);
  const rated = [...Array(4)].map((_, i) => ({ url: `r${i}`, company: "Big", my_rating: 4 })).concat(sorted.slice(8));
  assert.deepEqual(spreadTop(rated).slice(0, 4).map((e) => e.url), ["r0", "r1", "r2", "r3"]);
});

test("In progress lane: Applied through Offer only, furthest stage first, rows without a URL kept", () => {
  const rows = [
    { n: "1", status: "Evaluated", updated: "2026-11-21" },
    { n: "2", status: "Applied", updated: "2026-11-21", url: "" },
    { n: "54", status: "Interview", updated: "2026-11-20" },
    { n: "55", status: "Interview", updated: "2026-11-21", url: "" },
    { n: "9", status: "Responded", updated: "2026-11-19" },
    { n: "7", status: "Speculative", updated: "2026-11-21" },
  ];
  assert.deepEqual(inProgress(rows).map((r) => r.n), ["55", "54", "9", "2"]);
});

test("the Staff rule keeps its old weight on one scale: a Staff quick 5 ranks like a quick 4, below a judged 4.4", () => {
  const jobs = {
    staff5: job({ company: "S", quick_score: 5, role: "Staff Software Engineer", level: { key: "staff", factor: 0.45 } }),
    judged44: job({ company: "J", fit: 4.4 }),
    quick4: job({ company: "Q", quick_score: 4, h2h_rank: 1 }),
  };
  const o = order(jobs);
  assert.ok(o.indexOf("judged44") < o.indexOf("staff5"), o.join(","));
  assert.ok(o.indexOf("quick4") < o.indexOf("staff5"), o.join(",")); // equal 4.0, quick4 wins its head-to-head tie
});
