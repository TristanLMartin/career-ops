// hunt: Jobs Map axes stay readable with outliers (robustDomain / offScale), hourly points keep
// their rate, and quick-score-only rows open the job's detail page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPoints, offScale, robustDomain } from "../../src/lib/hunt-map.mjs";
import { rowTarget } from "../../src/components/inbox/triage-row-target.mjs";

test("one $832k outlier does not stretch the pay axis", () => {
  const pays = [43680, 57500, 65000, 80000, 95000, 110000, 120000, 125000, 130000, 140000, 150000, 165000, 180000, 215000, 228000, 249052, 832000];
  const [lo, hi] = robustDomain(pays, { pad: 0.08, minPad: 10_000, hardMin: 0 });
  assert.ok(hi < 500_000, `hi ${hi}`);
  assert.ok(lo < 60_000 && lo >= 0, `lo ${lo}`);
  assert.equal(offScale(832000, [lo, hi]), "high");
  assert.equal(offScale(130000, [lo, hi]), null);
});

test("the floor is kept inside the domain when one is set", () => {
  const [lo, hi] = robustDomain([210000, 220000, 230000], { include: [200000], minPad: 10_000 });
  assert.ok(lo <= 200000 && hi >= 230000);
});

test("no values falls back", () => {
  assert.deepEqual(robustDomain([], { fallback: [5, 10] }), [5, 10]);
});

test("hourly pay keeps its rate on the point", () => {
  const { points } = mapPoints({
    "https://x/1": { company: "Pigment", role: "TA Partner (Contract)", quick_score: 4, shortlist: true, pay: { min: 400, max: 400, currency: "USD", period: "hour", annualMin: 832000, annualMax: 832000 } },
  });
  assert.deepEqual(points[0].hourly, [400, 400]);
  assert.equal(points[0].y, 832000);
});

test("a row with no report opens the job's detail page, a report opens the report", () => {
  assert.equal(rowTarget(null, "https://jobs.example.com/1"), "/pipeline/posting?url=https%3A%2F%2Fjobs.example.com%2F1");
  assert.equal(rowTarget("/pipeline/42", "https://jobs.example.com/1"), "/pipeline/42");
});
