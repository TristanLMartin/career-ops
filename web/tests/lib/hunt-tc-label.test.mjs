import assert from "node:assert/strict";
import { test } from "node:test";
import { tcSourceLabel, tcExplain, isLevelsData } from "../../src/lib/hunt-tc-label.mjs";

const levels = { usd: 300000, rankUsd: 300000, source: "levels.fyi (Greater Austin Area, Lead MTS)", level: "Lead MTS", where: "Greater Austin Area", range: [255000, 365000], parts: { base: 235000, stock: 45000, bonus: 27000 }, privateEquity: false };
const research = { usd: 270000, rankUsd: 250000, source: "research table", levelEquiv: "L3 (Senior)", basis: "company median (posted band spans levels)", privateEquity: true, homeAdjusted: true };

test("tcSourceLabel names the data behind the estimate", () => {
  assert.equal(tcSourceLabel(levels), "levels.fyi, Greater Austin Area, Lead MTS");
  assert.equal(tcSourceLabel(research), "older research, L3 (Senior)");
  assert.equal(tcSourceLabel({ source: "levels.fyi-style estimate" }), "older research");
  assert.equal(isLevelsData({ source: "levels.fyi-style estimate" }), false);
});

test("tcExplain gives the split for Levels.fyi data and the method for research rows", () => {
  assert.equal(tcExplain(levels), "Est. TC: Levels.fyi Greater Austin Area median for Lead MTS ($235k base + $45k stock + $27k bonus), typical range $255k–365k.");
  assert.equal(tcExplain(research), "Est. TC: older research table, company senior median (L3 (Senior)), the posted band spans several levels, so not scaled by it, adjusted for your home metro. Private stock: ranked at ~$250k with stock counted at 60%.");
  assert.equal(tcExplain({ ...levels, where: "US", homeAdjusted: true }).startsWith("Est. TC: Levels.fyi US-wide median, adjusted for your home metro for Lead MTS"), true);
});
