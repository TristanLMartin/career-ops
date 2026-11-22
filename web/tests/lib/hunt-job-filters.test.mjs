// Which unevaluated jobs pass the autoscore / bulk filters, for the SWE test fixture's target
// (tests/fixtures/ranking-swe-legacy.yml: home metro, Senior, Staff as a stretch, relocation
// only for really good pay).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as yaml from "js-yaml";
import { filterJob as filterWith } from "../../../scripts/hunt-job-filters.mjs";

const TARGET = yaml.load(fs.readFileSync(new URL("../../../tests/fixtures/ranking-swe-legacy.yml", import.meta.url), "utf8")).target;
const filterJob = (e) => filterWith(e, TARGET);

const base = { company: "Acme", role: "Senior Software Engineer", level: { key: "senior" }, locationTier: 1, pay: { annualMax: 220000 } };

test("home-metro senior engineering passes", () => assert.ok(filterJob(base).ok));

test("a secondary metro passes only with really good pay (target.relocate)", () => {
  assert.deepEqual(filterJob({ ...base, locationTier: 3 }).reasons, ["location:tier3"]);
  assert.ok(filterJob({ ...base, locationTier: 3, pay: { annualMax: 260000 } }).ok);
  assert.ok(filterJob({ ...base, locationTier: 3, tc_adj: 320000 }).ok);
  assert.ok(!filterJob({ ...base, locationTier: 4, pay: { annualMax: 400000 } }).ok);
});

test("Staff passes as a stretch when the candidate meets the level or a target company scores it 4+", () => {
  const staff = { ...base, level: { key: "staff" } };
  assert.ok(!filterJob(staff).ok);
  assert.ok(!filterJob({ ...staff, quick_score: 4 }).ok);
  const t = filterJob({ ...staff, quick_score: 4, rankBoost: true });
  assert.ok(t.ok && t.stretch);
  assert.ok(filterJob({ ...staff, report: { level: { meets: true } } }).ok);
  assert.ok(!filterJob({ ...staff, report: { level: { meets: false } }, quick_score: 5, rankBoost: true }).ok);
  assert.ok(!filterJob({ ...base, level: { key: "mid" } }).ok);
});

test("account-team, presales, data science and hardware titles are blocked", () => {
  for (const role of ["Sr Solutions Architect, Strategic Accounts", "Solutions Architect - Digital Native Business, Named Accounts", "Solutions Architect, Nonprofit Financial Investments Account Team", "Presales Solutions Architect", "Senior Data Scientist, Full Stack", "Sr Software Engineer - BIOS, AWS Hardware Engineering, Firmware Development", "Customer Solutions Engineer, Compute"]) {
    assert.ok(filterJob({ ...base, role }).reasons.includes("title"), role);
  }
  assert.ok(filterJob({ ...base, role: "Software Engineer, Backend, Accounts Receivable" }).ok);
});

test("below the pay floor stays out", () => assert.ok(!filterJob({ ...base, belowFloor: true }).ok));

test("with no target nothing about level or city is assumed", () => {
  assert.ok(filterWith({ ...base, level: { key: "staff" }, locationTier: 2 }).ok);
  assert.ok(!filterWith({ ...base, locationTier: 4 }).ok, "default tiers are 1, 2, 5");
  assert.ok(!filterWith({ ...base, contract: true }).ok);
});
