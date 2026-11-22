// levelFit's no_title_levels companies, and group copies at another level/place not inheriting
// the leader's fit (group order uses the SWE test fixture's target).
import { test } from "node:test";
import assert from "node:assert/strict";
import { levelFit } from "../lib/hunt-rank.mjs";
import { sameLevelAndPlace, groupLeaderOrder } from "../scripts/hunt-enrich.mjs";
import { LEGACY_TARGET as target } from "./helpers/swe-legacy-rules.mjs";

const opts = { bigCompanies: ["Anthropic", "OpenAI", "Databricks"], noTitleLevels: ["Anthropic", "OpenAI", "Perplexity"] };

test("plain Software Engineer / MTS at a no-title-levels company is senior-eligible", () => {
  assert.equal(levelFit("Software Engineer, Research Tools", "Anthropic", "", opts).key, "senior");
  assert.equal(levelFit("Member of Technical Staff (Software Engineer, Enterprise AI)", "Perplexity", "", opts).key, "senior");
  assert.equal(levelFit("Software Engineer, Backend", "Databricks", "", opts).key, "mid");
  assert.equal(levelFit("Software Engineer II", "OpenAI", "", opts).key, "mid");
  assert.equal(levelFit("Staff Software Engineer", "Anthropic", "", opts).key, "staff");
});

test("a group copy inherits fit only at the same level and location tier", () => {
  const lead = { level: { key: "senior" }, locationTier: 1 };
  assert.equal(sameLevelAndPlace({ level: { key: "senior" }, locationTier: 1 }, lead), true);
  assert.equal(sameLevelAndPlace({ level: { key: "staff" }, locationTier: 1 }, lead), false);
  assert.equal(sameLevelAndPlace({ level: { key: "senior" }, locationTier: 4 }, lead), false);
});

test("a duplicate group's leader is usable first, then its best-scored member", () => {
  const out = {
    a: { fit: 3.3, level: { key: "senior" }, locationTier: 1, pay: { min: 1 }, composite: 90, jdChars: 5000 },
    b: { fit: 3.9, level: { key: "senior" }, locationTier: 2, composite: 40, jdChars: 900 },
    c: { level: { key: "senior" }, locationTier: 1, pay: { min: 1 }, composite: 99, jdChars: 9000 },
  };
  // Among usable members, the 3.9 beats the 3.3; unscored last.
  assert.deepEqual(["a", "c", "b"].sort(groupLeaderOrder(out, target)), ["b", "a", "c"]);
  // A usable 3.6 beats an unusable 3.8 (Staff, or an off-list location).
  const out2 = {
    u: { fit: 3.6, level: { key: "senior" }, locationTier: 1 },
    s: { fit: 3.8, level: { key: "staff" }, locationTier: 1 },
    n: { fit: 3.8, level: { key: "senior" }, locationTier: 3 },
  };
  assert.deepEqual(["s", "n", "u"].sort(groupLeaderOrder(out2, target))[0], "u");
});
