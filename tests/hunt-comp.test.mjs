// Tests for lib/hunt-comp.mjs: TC estimates and the company factor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCompDoc, compFor, estimateTc, companyScore, recentLayoff, tcScore, confidenceAtLeast, formatPayWithTc, normCompany, UNKNOWN_COMPANY_SCORE } from "../lib/hunt-comp.mjs";

const DOC = [
  { company: "Stripe", tc_median_usd: 460000, tc_range_usd: null, base_usd: 218000, stock_per_year_usd: 221000, bonus_usd: 21000, equity_type: "private RSU/options", location_basis: "US national (levels.fyi, no Seattle split)", source_urls: ["a", "b"], confidence: "high", stage: "late-private", stability_note: "Profitable; no major 2026 layoffs found.", company_tier: 1 },
  { company: "Snowflake", tc_median_usd: 400000, tc_range_usd: [350000, 450000], base_usd: 200000, stock_per_year_usd: 180000, bonus_usd: 20000, equity_type: "public RSU", location_basis: "Greater Seattle (levels.fyi)", source_urls: ["a", "b"], confidence: "medium", stage: "public", stability_note: "Cut 5% of staff in a March 2026 restructuring.", company_tier: 2 },
  { company: "Hex", tc_median_usd: 240000, base_usd: 200000, equity_type: "options", location_basis: "US (levels.fyi, 1 data point)", source_urls: ["a"], confidence: "medium", stage: "growth", company_tier: 3 },
  { company: "LiveKit", tc_median_usd: 260000, base_usd: 230000, equity_type: "options", location_basis: "Canada only (CA$237K-287K avg)", confidence: "low", company_tier: 3 },
  { company: "Anduril", tc_median_usd: 320000, base_usd: 220000, stock_per_year_usd: 100000, equity_type: "private RSU/options", location_basis: "US national", source_urls: ["a", "b"], confidence: "high", company_tier: 1 },
];
// The fixture is a Seattle-based search: tc_home.basis_words names that metro.
const map = loadCompDoc(DOC, { homeWords: ["seattle", "bellevue"] });
const pay = (min, max, extra = {}) => ({ min, max, currency: "USD", period: "year", annualMin: min, annualMax: max, basis: "base", ...extra });

test("loadCompDoc + compFor: case-insensitive, suffixes and YC tags, prefix fallback", () => {
  assert.equal(map.size, 5);
  assert.equal(compFor("stripe", map)?.company, "Stripe");
  assert.equal(compFor("Snowflake Inc.", map)?.company, "Snowflake");
  assert.equal(compFor("Hex (YC W19)", map)?.company, "Hex");
  assert.equal(compFor("Andurilindustries", map)?.company, "Anduril");
  assert.equal(compFor("Nobody Corp", map), null);
  assert.equal(normCompany("Postscript (YC W19)"), "postscript");
  assert.equal(loadCompDoc(null).size, 0);
  assert.equal(loadCompDoc({ companies: { Stripe: { tc_median_usd: 1 } } }).size, 1);
});

test("estimateTc: company median when the posting has no base; private stock at 0.6 for ranking", () => {
  const t = estimateTc(compFor("Stripe", map), null, { locationTier: 2 });
  assert.equal(t.usd, 460000);
  assert.equal(t.basis, "company median");
  assert.equal(t.privateEquity, true);
  assert.equal(t.rankUsd, Math.round((460000 - 221000 * 0.4) / 1000) * 1000);
  assert.equal(t.confidence, "high");
});

test("estimateTc: scaled by posting base, ratio clamped to 0.8-1.25, then to the company range", () => {
  const snow = compFor("Snowflake", map);
  // base mid 220k / company base 200k = 1.1 -> 440k, inside the range; public RSU, home-metro basis.
  const t = estimateTc(snow, pay(200000, 240000), { locationTier: 1 });
  assert.equal(t.usd, 440000);
  assert.equal(t.rankUsd, 440000);
  assert.equal(t.homeAdjusted, false, "basis already the home metro");
  // mid 400k / 200k = 2.0 -> clamped to 1.25 -> 500k -> range cap 450k.
  assert.equal(estimateTc(snow, pay(380000, 420000)).usd, 450000);
  // OTE is not a base to scale by.
  assert.equal(estimateTc(snow, pay(300000, 300000, { basis: "OTE" })).basis, "company median");
});

test("estimateTc: tc_home.factor for home-tier rows when the basis isn't the home metro; none by default", () => {
  assert.equal(estimateTc(compFor("Stripe", map), null, { locationTier: 1 }).homeAdjusted, false, "no factor assumed");
  const t = estimateTc(compFor("Stripe", map), null, { locationTier: 1, homeFactor: 0.9 });
  assert.equal(t.usd, 414000);
  assert.equal(t.homeAdjusted, true);
});

test("estimateTc: single data point is low confidence; non-US basis gives no estimate", () => {
  assert.equal(estimateTc(compFor("Hex", map), null).confidence, "low");
  assert.equal(estimateTc(compFor("LiveKit", map), null), null);
  assert.equal(estimateTc(null, null), null);
  assert.equal(confidenceAtLeast("low"), false);
  assert.equal(confidenceAtLeast("medium"), true);
  assert.equal(confidenceAtLeast("high"), true);
});

test("companyScore: tier factor, 2026 layoff -10, unknown 60", () => {
  assert.equal(companyScore(compFor("Stripe", map)), 100);
  assert.equal(companyScore(compFor("Snowflake", map)), 70);
  assert.equal(companyScore(compFor("Hex", map)), 55);
  assert.equal(companyScore(null), UNKNOWN_COMPANY_SCORE);
  assert.equal(recentLayoff("No major 2026 layoffs found"), false);
  assert.equal(recentLayoff("Layoffs in 2023"), false);
  assert.equal(recentLayoff("Laid off 10% in Jan 2026"), true);
});

test("tcScore and the UI line", () => {
  assert.equal(tcScore(200000), 0);
  assert.equal(tcScore(550000), 100);
  assert.equal(tcScore(375000), 50);
  assert.equal(tcScore(null), null);
  const line = formatPayWithTc(pay(200000, 280000), estimateTc(compFor("Stripe", map), null));
  assert.equal(line, "base $200k–280k · est. TC ~$460k (high confidence, private equity)");
  assert.equal(formatPayWithTc(null, null), null);
});
