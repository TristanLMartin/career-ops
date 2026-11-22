// hunt: pay line + single verdict for the job detail page (src/lib/hunt-job-pay.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { findEnrichRow, payLine, parseAdvertised, singleVerdict } from "../../src/lib/hunt-job-pay.mjs";

const SNOW = "https://jobs.ashbyhq.com/snowflake/e47d5736-b86b-4c10-a487-4cc3a012096e";
const snowRow = {
  company: "Snowflake",
  pay: { min: 200000, max: 287500, currency: "USD", period: "year", annualMin: 200000, annualMax: 287500, from: "description", basis: "base" },
  tc_est: { usd: 517000, confidence: "high", levelEquiv: "IC3 (Senior SWE)" },
  report: { tracker: "57", n: "108" },
};

test("findEnrichRow: matches a markdown-link tracker URL to the enrich key", () => {
  const jobs = { [SNOW]: snowRow, "https://x.example/1": { company: "X" } };
  assert.equal(findEnrichRow(jobs, { urls: [`[ashby](${SNOW})`] }), snowRow);
  assert.equal(findEnrichRow(jobs, { urls: [`${SNOW}/`] }), snowRow);
});

test("findEnrichRow: falls back to the tracker number, then null", () => {
  const jobs = { "https://other/a": snowRow };
  assert.equal(findEnrichRow(jobs, { urls: ["https://nope/b"], tracker: "057" }), snowRow);
  assert.equal(findEnrichRow(jobs, { urls: [], tracker: "58" }), null);
  assert.equal(findEnrichRow(null, { tracker: "57" }), null);
});

test("findEnrichRow: a group member URL finds its group row", () => {
  const jobs = { "https://lead/1": { company: "L", groupUrls: ["https://member/2"] } };
  assert.equal(findEnrichRow(jobs, { urls: ["https://member/2"] }).company, "L");
});

test("payLine: posted band and estimate on one line (#57)", () => {
  const p = payLine(snowRow);
  assert.equal(p.kind, "both");
  assert.equal(p.posted, "Base $200k–$288k · posted");
  assert.equal(p.estimated, "Est. total comp ~$517k · levels.fyi, IC3 (Senior SWE)");
  assert.equal(p.text, "Base $200k–$288k · posted · Est. total comp ~$517k · levels.fyi, IC3 (Senior SWE)");
});

test("payLine: estimate only, low confidence is labeled", () => {
  const p = payLine({ tc_est: { usd: 300000, confidence: "low", levelEquiv: null } });
  assert.equal(p.kind, "estimated");
  assert.equal(p.text, "Est. total comp ~$300k · levels.fyi (low confidence)");
});

test("payLine: OTE, hourly and non-USD bands keep their basis", () => {
  assert.equal(payLine({ pay: { min: 220000, max: 288000, annualMin: 220000, annualMax: 288000, currency: "USD", period: "year", basis: "OTE" } }).posted, "OTE $220k–$288k · posted");
  assert.equal(payLine({ pay: { min: 60, max: 75, annualMin: 124800, annualMax: 156000, currency: "USD", period: "hour", basis: "base" } }).posted, "Base $60–$75/hr (hourly, ~$125k–$156k/yr) · posted");
  assert.equal(payLine({ pay: { min: 150000, max: 150000, annualMin: 150000, annualMax: 150000, currency: "CAD", period: "year", basis: "base" } }).posted, "Base $150k CAD · posted");
});

test("payLine: the report's advertised comp is used when the row has no band", () => {
  assert.equal(payLine({ report: { advertisedComp: "$145,000 - $200,000/year" } }).posted, "Base $145k–$200k · posted");
  assert.deepEqual(parseAdvertised("no figure"), null);
});

test("payLine: nothing known is 'Pay not listed', never a number", () => {
  for (const row of [null, {}, { pay: null, tc_est: null }, { tc_est: { usd: 0 } }]) {
    const p = payLine(row);
    assert.equal(p.kind, "none");
    assert.equal(p.text, "Pay not listed");
  }
});

test("singleVerdict: one badge from score vs apply line plus the legitimacy flag", () => {
  assert.deepEqual(singleVerdict({ score: "4.0/5", legitimacy: "Proceed with Caution" }), { label: "Apply · verify posting", tone: "warn", apply: true });
  assert.deepEqual(singleVerdict({ score: "4.3/5", legitimacy: "High Confidence" }), { label: "Apply", tone: "good", apply: true });
  assert.deepEqual(singleVerdict({ score: 4.1 }), { label: "Apply", tone: "good", apply: true });
  assert.equal(singleVerdict({ score: "3.7/5", legitimacy: "Proceed with Caution" }).label, "Maybe");
  assert.equal(singleVerdict({ score: "3.5/5" }).label, "Maybe");
  assert.equal(singleVerdict({ score: "3.4/5" }).label, "Skip");
  assert.deepEqual(singleVerdict({ score: "4.6/5", legitimacy: "Suspicious" }), { label: "Skip · posting looks suspect", tone: "bad", apply: false });
  assert.equal(singleVerdict({ score: "", legitimacy: "High Confidence" }), null);
  assert.equal(singleVerdict({ score: "N/A" }), null);
});

test("singleVerdict: honors a custom apply line", () => {
  assert.equal(singleVerdict({ score: "4.2/5", applyLine: 4.5 }).label, "Maybe");
});
