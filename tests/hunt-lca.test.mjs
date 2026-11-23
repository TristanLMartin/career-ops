// Tests for lib/hunt-lca.mjs, scripts/hunt-comp-refresh.mjs and lib/hunt-comp-validate.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The fixture rows are in Seattle; the home split is whatever lca-employers.yml says.
const HOME = { states: ["WA"], cities: ["Seattle", "Bellevue", "Redmond", "Kirkland"] };
import { annualize, employerIndex, estimateFromLca, filterRow, isGenericSweTitle, isSeniorSweTitle, quantile, summarize } from "../lib/hunt-lca.mjs";
import { lcaLinks, rowsOf } from "../scripts/hunt-comp-refresh.mjs";
import { validateComp } from "../lib/hunt-comp-validate.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hunt-lca", "mini.xlsx");
const index = employerIndex({ Stripe: ["Stripe, LLC"], Meta: ["Meta Platforms, Inc"] });

test("title matching: senior software family in, staff/manager/generic-only out", () => {
  for (const t of ["Senior Software Engineer", "Sr. Backend Engineer", "Senior Full-Stack Developer", "Senior Forward Deployed Engineer", "Senior Solutions Engineer"]) assert.ok(isSeniorSweTitle(t), t);
  for (const t of ["Staff Software Engineer", "Senior Staff Software Engineer", "Software Engineer", "Senior Engineering Manager", "Senior Data Scientist", "Senior Mechanical Engineer"]) assert.ok(!isSeniorSweTitle(t), t);
  assert.ok(isGenericSweTitle("Software Engineer"));
  assert.ok(isGenericSweTitle("Member of Technical Staff (Software Engineering)"));
  assert.ok(!isGenericSweTitle("Software Engineer II"));
});

test("annualize: hourly x2080, weekly x52, monthly x12, junk -> null", () => {
  assert.equal(annualize("100", "Hour"), 208000);
  assert.equal(annualize("4000", "Week"), 208000);
  assert.equal(annualize("$15,000.00", "Month"), 180000);
  assert.equal(annualize("200000", "Year"), 200000);
  assert.equal(annualize("", "Year"), null);
  assert.equal(annualize("200000", "Fortnight"), null);
  assert.equal(annualize("5", "Year"), null, "below a plausible salary");
});

test("quantile and median", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 3);
  assert.equal(quantile([100, 200, 300], 0.5), 200);
  assert.equal(quantile([], 0.5), null);
});

test("fixture xlsx: streamed, filtered (Certified, employer table, senior titles), summarized", async () => {
  const kept = [];
  for await (const row of await rowsOf(FIXTURE)) { const r = filterRow(row, index, HOME); if (r) kept.push(r); }
  // Stripe: 200k Seattle, 100/hr Seattle (inline string title), 240k SF, 210k Seattle ("&" in a shared string).
  // Out: Withdrawn, Staff, Unknown Corp. Meta's generic title is kept as tier "generic".
  const stripe = kept.filter((r) => r.company === "Stripe");
  assert.deepEqual(stripe.map((r) => r.wage).sort(), [200000, 208000, 210000, 240000]);
  assert.equal(stripe.filter((r) => r.home).length, 3);
  assert.equal(kept.filter((r) => r.company === "Meta" && r.tier === "generic").length, 1);
  const s = summarize(kept, { minHome: 3 });
  assert.equal(s.Stripe.basis, "senior titles");
  assert.equal(s.Stripe.n, 4);
  assert.equal(s.Stripe.median, 209000);
  assert.equal(s.Stripe.home.n, 3);
  assert.equal(s.Stripe.home.median, 208000);
  assert.equal(s.Meta, undefined, "1 generic row is below minGeneric");
  assert.equal(summarize(kept).Stripe.home, null, "home split needs n >= 5 by default");
});

test("missing company: not in the employer table -> no row, no summary, no estimate", () => {
  assert.equal(filterRow({ CASE_STATUS: "Certified", EMPLOYER_NAME: "Nobody Inc", JOB_TITLE: "Senior Software Engineer", WAGE_RATE_OF_PAY_FROM: "200000", WAGE_UNIT_OF_PAY: "Year" }, index), null);
  assert.equal(estimateFromLca(undefined, { tc_median_usd: 400000, base_usd: 200000 }), null);
  assert.equal(estimateFromLca({ median: 200000, n: 10, home: null }, null), null);
});

test("generic-title fallback uses p75 as the senior proxy", () => {
  const rows = [150, 160, 170, 180, 200].map((k) => ({ company: "Meta", wage: k * 1000, home: false, tier: "generic" }));
  const s = summarize(rows);
  assert.equal(s.Meta.basis, "generic titles, p75 as senior proxy");
  assert.equal(s.Meta.median, 180000);
  assert.equal(s.Meta.allLevels.median, 170000);
});

test("est. TC = LCA base median x curated TC/base ratio, home metro when available", () => {
  const e = estimateFromLca({ median: 200000, n: 20, home: { median: 210000, n: 8 } }, { tc_median_usd: 460000, base_usd: 230000 });
  assert.deepEqual([e.lcaBase, e.basis, e.ratio, e.tc, e.n], [210000, "home area", 2, 420000, 8]);
  assert.equal(e.label, "est. TC (DOL base × curated ratio)");
});

test("lcaLinks: newest quarter first, relative links resolved", () => {
  const html = '<a href="/sites/x/LCA_Disclosure_Data_FY2025_Q4.xlsx">a</a><a href="https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q2.xlsx">b</a><a href="https://www.dol.gov/media/LCA_Disclosure_Data_FY2026_Q1.xlsx">c</a>';
  assert.deepEqual(lcaLinks(html).map((l) => l.file), ["FY2026_Q2.xlsx", "FY2026_Q1.xlsx", "FY2025_Q4.xlsx"]);
  assert.equal(lcaLinks(html)[2].url, "https://www.dol.gov/sites/x/LCA_Disclosure_Data_FY2025_Q4.xlsx");
  assert.deepEqual(lcaLinks("<html>no links</html>"), []);
});

test("validateComp: schema, ranges, ratio 1.0-4.0, stale as_of", () => {
  const ok = { company: "Stripe", tc_median_usd: 460000, base_usd: 218000, location_basis: "US", confidence: "high", company_tier: 1, as_of: "2026-11-20", equity_type: "private RSU" };
  const today = new Date("2026-11-21T00:00:00Z");
  assert.deepEqual(validateComp([ok], { today }), { errors: [], warnings: [] });
  assert.match(validateComp({}, { today }).errors[0], /array/);
  assert.ok(validateComp([{ ...ok, confidence: "great" }], { today }).errors.some((e) => /confidence/.test(e)));
  assert.ok(validateComp([{ ...ok, tc_median_usd: 1000000, base_usd: 200000 }], { today }).errors.some((e) => /ratio 5\.00/.test(e)));
  assert.ok(validateComp([{ ...ok, tc_median_usd: 150000, base_usd: 200000 }], { today }).errors.some((e) => /ratio 0\.75/.test(e)));
  assert.ok(validateComp([{ ...ok, company_tier: 7 }], { today }).errors.some((e) => /tier/.test(e)));
  assert.ok(validateComp([ok, { ...ok }], { today }).errors.some((e) => /duplicate/.test(e)));
  assert.ok(validateComp([{ ...ok, as_of: undefined }], { today }).errors.some((e) => /as_of/.test(e)));
  assert.ok(validateComp([{ ...ok, as_of: "2026-04-01" }], { today }).warnings.some((w) => /older than 6 months/.test(w)));
  assert.deepEqual(validateComp([{ ...ok, tc_median_usd: null, base_usd: null }], { today }).errors, [], "no-data entries are allowed");
});

test("filterRow: a filed wage range counts at its midpoint; a single wage as filed", () => {
  const row = (from, to) => ({ CASE_STATUS: "Certified", EMPLOYER_NAME: "Stripe, LLC", JOB_TITLE: "Senior Software Engineer", WORKSITE_CITY: "Austin", WORKSITE_STATE: "TX", WAGE_RATE_OF_PAY_FROM: from, WAGE_RATE_OF_PAY_TO: to, WAGE_UNIT_OF_PAY: "Year" });
  // Range filers (Stripe, Snowflake, Databricks...) put the band's bottom in FROM: 200k-280k is 240k.
  assert.equal(filterRow(row("200000", "280000"), index).wage, 240000);
  // Single-wage filers (Google, Salesforce...) leave TO empty or equal.
  assert.equal(filterRow(row("236000", ""), index).wage, 236000);
  assert.equal(filterRow(row("236000", "236000"), index).wage, 236000);
  // A TO below FROM is a typo: ignored.
  assert.equal(filterRow(row("236000", "23600"), index).wage, 236000);
});
