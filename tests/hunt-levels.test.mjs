// Tests for lib/hunt-levels.mjs: TC from Levels.fyi per-level data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { levelInTitle, levelEquivName, seniorIndex, pickLevel, estimateFromLevels, levelsFor, loadLevelsDoc, bestTcEstimate, US } from "../lib/hunt-levels.mjs";

const HOME = "greater-austin-area"; // any Levels.fyi location slug set as levels.home_location
import { loadCompDoc } from "../lib/hunt-comp.mjs";

const lv = (level, median, base, stock, bonus, p10 = median * 0.85, p90 = median * 1.15, secondaryLevelName) =>
  ({ level, secondaryLevelName, medianTotalCompensation: median, p10TotalCompensation: p10, p90TotalCompensation: p90, averageBaseSalary: base, averageStockPerYear: stock, averageBonus: bonus });

// Shapes from the Levels.fyi MCP; figures illustrative.
const SALESFORCE = [
  lv("Associate MTS", 172000, 133279, 24215, 15264, 161250, 183600, "Associate Member of Technical Staff"),
  lv("MTS", 198000, 166448, 27604, 9415, 184500, 221500, "Software Engineer (SWE)"),
  lv("Senior MTS", 266000, 206685, 41456, 22588, 229000, 313250, "Senior SWE"),
  lv("Lead MTS", 300000, 234851, 45368, 27353, 255000, 365000, "Lead SWE"),
  lv("Principal MTS", 404000, 282762, 86146, 42632, 334968, 505000, "Principal SWE"),
];
const STRIPE = [
  lv("L1", 209500, 144079, 47816, 16184), lv("L2", 269940, 183830, 74569, 17901),
  lv("L3", 406750, 223604, 170073, 24991, 347000, 495000), lv("L4", 688000, 270300, 355170, 52038, 590000, 740000, "Staff Engineer"),
  lv("L5", 997400, 336200, 543980, 69700),
];
const ANTHROPIC_US = [lv("Software Engineer", 450000, 280000, 150000, 0), lv("Senior Software Engineer", 600000, 320000, 280000, 0), lv("Staff Software Engineer", 850000, 380000, 470000, 0)];

test("levelInTitle: explicit level names, compact initials and codes; generic names never match", () => {
  assert.equal(levelInTitle(SALESFORCE, "Forward Deployed Engineer LMTS"), 3);
  assert.equal(levelInTitle(SALESFORCE, "Senior Member of Technical Staff, Agentforce"), 2);
  assert.equal(levelInTitle(SALESFORCE, "Lead Member of Technical Staff - Payments"), 3);
  assert.equal(levelInTitle(SALESFORCE, "Software Engineer"), -1); // "MTS"/"Software Engineer (SWE)" are not seniority-worded
  assert.equal(levelInTitle(STRIPE, "Software Engineer, L3 Payments"), 2);
  assert.equal(levelInTitle(ANTHROPIC_US, "Software Engineer, Payments"), -1);
  assert.equal(levelInTitle(ANTHROPIC_US, "Senior Software Engineer, Billing"), 1);
  assert.equal(levelInTitle(STRIPE, "Staff Engineer, Ledger"), 3);
});

test("levelEquivName and seniorIndex read the curated Senior/E5 equivalent", () => {
  assert.equal(levelEquivName("Lead MTS (~E5; SMTS ~E4)"), "Lead MTS");
  assert.equal(levelEquivName("L3 (Senior)"), "L3");
  assert.equal(levelEquivName("unknown (India data only)"), null);
  assert.equal(seniorIndex(SALESFORCE, "Lead MTS (~E5; SMTS ~E4)"), 3);
  assert.equal(seniorIndex(SALESFORCE, null), 2); // first "Senior" level
  assert.equal(seniorIndex(STRIPE, "L3 (Senior)"), 2);
  assert.equal(seniorIndex(STRIPE, null), -1); // no curated entry, no "Senior" level: no guess
});

test("pickLevel follows the title's seniority around the senior equivalent", () => {
  const eq = "Lead MTS (~E5; SMTS ~E4)";
  assert.deepEqual(pickLevel(SALESFORCE, { title: "Forward Deployed Engineer (Mid/Senior Level)", levelKey: "senior", levelEquiv: eq }), { index: 3, how: "senior equivalent" });
  assert.deepEqual(pickLevel(SALESFORCE, { title: "Software Engineer", levelKey: "mid", levelEquiv: eq }), { index: 2, how: "below senior" });
  assert.deepEqual(pickLevel(STRIPE, { title: "Staff Software Engineer", levelKey: "staff", levelEquiv: "L3 (Senior)" }), { index: 3, how: "staff" });
  assert.deepEqual(pickLevel(ANTHROPIC_US, { title: "Software Engineer, Payments", levelKey: "senior" }), { index: 1, how: "senior" });
  assert.equal(pickLevel(STRIPE, { title: "Software Engineer", levelKey: "senior" }), null);
  assert.equal(pickLevel([], { title: "Senior Engineer" }), null);
});

test("estimateFromLevels: home-metro median at the picked level, private stock x0.6 in the ranked figure", () => {
  const rec = { name: "Salesforce", public: true, fetchedAt: "2026-11-22", locations: { [HOME]: SALESFORCE } };
  const tc = estimateFromLevels(rec, { title: "Forward Deployed Engineer (Mid/Senior Level)", levelKey: "senior", levelEquiv: "Lead MTS (~E5; SMTS ~E4)", locationTier: 1, homeLocation: HOME });
  assert.equal(tc.usd, 300000);
  assert.equal(tc.rankUsd, 300000); // public RSUs count in full
  assert.equal(tc.confidence, "high");
  assert.equal(tc.source, "levels.fyi (Greater Austin Area, Lead MTS)");
  assert.deepEqual(tc.parts, { base: 235000, stock: 45000, bonus: 27000 });
  assert.deepEqual(tc.range, [255000, 365000]);

  const stripe = { name: "Stripe", public: false, locations: { [HOME]: STRIPE } };
  const s = estimateFromLevels(stripe, { title: "Software Engineer, Payments", levelKey: "senior", levelEquiv: "L3 (Senior)", locationTier: 2, homeLocation: HOME });
  assert.equal(s.usd, 407000);
  assert.equal(s.rankUsd, Math.round((406750 - 170073 * 0.4) / 1000) * 1000);
  assert.equal(s.privateEquity, true);
});

test("estimateFromLevels: US data for a home-metro row is scaled by tc_home.factor and drops to medium confidence", () => {
  const rec = { name: "Anthropic", public: false, locations: { [HOME]: [], [US]: ANTHROPIC_US } };
  const tc = estimateFromLevels(rec, { title: "Software Engineer", levelKey: "senior", locationTier: 1, homeLocation: HOME, homeFactor: 0.9 });
  assert.equal(tc.where, "US");
  assert.equal(tc.homeAdjusted, true);
  assert.equal(tc.usd, 540000);
  assert.equal(tc.confidence, "medium");
  // A NYC row (tier 3) uses US data unscaled.
  assert.equal(estimateFromLevels(rec, { title: "Software Engineer", levelKey: "senior", locationTier: 3 }).usd, 600000);
});

test("estimateFromLevels: no usable level gives null, a very wide spread gives low confidence", () => {
  assert.equal(estimateFromLevels({ locations: { [HOME]: STRIPE } }, { title: "Software Engineer", levelKey: "senior", locationTier: 1, homeLocation: HOME }), null);
  assert.equal(estimateFromLevels(null, {}), null);
  const wide = { public: true, locations: { [HOME]: [lv("Senior Engineer", 300000, 200000, 80000, 20000, 150000, 400000)] } };
  assert.equal(estimateFromLevels(wide, { title: "Senior Engineer", levelKey: "senior", locationTier: 1, homeLocation: HOME }).confidence, "low");
});

test("levelsFor matches the normalized name exactly, never a prefix", () => {
  const map = loadLevelsDoc({ companies: { salesforce: { name: "Salesforce", locations: { [HOME]: SALESFORCE } }, acmerockets: { name: "Acme Rockets", locations: {} } } });
  assert.equal(levelsFor("Salesforce, Inc.", map).name, "Salesforce");
  assert.equal(levelsFor("Acme Rockets Technologies", map).name, "Acme Rockets");
  assert.equal(levelsFor("Sales", map), null);
});

test("bestTcEstimate: Levels.fyi data first, the research table when it has no matching level", () => {
  const levelsMap = loadLevelsDoc({ companies: { salesforce: { name: "Salesforce", public: true, locations: { [HOME]: SALESFORCE } } } });
  const compMap = loadCompDoc([
    { company: "Salesforce", level_equiv: "Lead MTS (~E5; SMTS ~E4)", tc_median_usd: 310000, base_usd: 238000, equity_type: "public RSU", location_basis: "US national", source_urls: ["a", "b"], confidence: "high" },
    { company: "Globex", tc_median_usd: 240000, base_usd: 200000, equity_type: "options", location_basis: "US national", source_urls: ["a", "b"], confidence: "medium" },
  ]);
  const sf = bestTcEstimate({ company: "Salesforce", title: "Forward Deployed Engineer (Mid/Senior Level)", levelKey: "senior", locationTier: 1 }, { levelsMap, compMap, homeLocation: HOME });
  assert.equal(sf.source, "levels.fyi (Greater Austin Area, Lead MTS)");
  assert.equal(sf.usd, 300000);
  const globex = bestTcEstimate({ company: "Globex", title: "Senior Engineer", levelKey: "senior", locationTier: 2 }, { levelsMap, compMap, homeLocation: HOME });
  assert.equal(globex.source, "research table");
  assert.equal(bestTcEstimate({ company: "Nobody", title: "Engineer" }, { levelsMap, compMap }), null);
});

const AMAZON = [
  lv("SDE I", 180000, 140000, 30000, 10000, undefined, undefined, "L4"), lv("SDE II", 267000, 170000, 90000, 7000, undefined, undefined, "L5"),
  lv("SDE III", 355000, 200000, 150000, 5000, undefined, undefined, "L6"), lv("Principal SDE", 550000, 230000, 320000, 0, undefined, undefined, "L7"),
  lv("Senior Principal SDE", 960000, 250000, 710000, 0, undefined, undefined, "L8"),
];

test("seniorIndex: the curated equivalent matches a level's secondary name or its parenthetical", () => {
  assert.equal(seniorIndex(AMAZON, "L6 (SDE III)"), 2);
  assert.equal(seniorIndex(AMAZON, "SDE III (L6)"), 2);
});

test("seniorIndex: the generic Senior fallback never lands on Senior Principal / Senior Staff", () => {
  assert.equal(seniorIndex(AMAZON, null), -1);
  const ladder = [lv("Engineer", 200000, 1, 1, 1), lv("Senior Staff Engineer", 600000, 1, 1, 1), lv("Senior Engineer", 300000, 1, 1, 1)];
  assert.equal(seniorIndex(ladder, null), 2);
  const amazonSenior = pickLevel(AMAZON, { title: "Senior Software Engineer , Amazon Leo - Network Observability", levelKey: "senior", levelEquiv: "L6 (SDE III)" });
  assert.deepEqual(amazonSenior, { index: 2, how: "senior equivalent" });
});

test("estimateFromLevels: with no levels.home_location, every row uses US-wide data unscaled", () => {
  const rec = { name: "Anthropic", public: false, locations: { [HOME]: [lv("Senior Software Engineer", 999000, 1, 1, 1)], [US]: ANTHROPIC_US } };
  const tc = estimateFromLevels(rec, { title: "Software Engineer", levelKey: "senior", locationTier: 1, homeFactor: 0.9 });
  assert.equal(tc.where, "US");
  assert.equal(tc.usd, 600000);
  assert.equal(tc.homeAdjusted, false);
});
