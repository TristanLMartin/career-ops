// hunt: the Pipeline table's Pay column (payCell, sortByPay) and the tracker-row enrich lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { payCell, payParts, shortPay, sortByPay } from "../../src/lib/hunt-rank-order.mjs";
import { enrichLookup } from "../../src/lib/hunt-job-pay.mjs";

const yearly = { currency: "USD", min: 172000, max: 280000, annualMin: 172000, annualMax: 280000, period: "year", basis: "base" };

test("payCell: base band with the TC estimate as a second line", () => {
  const c = payCell({ pay: yearly, tc_est: { usd: 570000 } });
  assert.equal(c.base, "$172–280k");
  assert.equal(c.tc, "~$570k TC");
  assert.equal(c.sortUsd, 570000);
});

test("payCell: same pieces as the Jobs card line", () => {
  const e = { pay: yearly, tc_est: { usd: 570000 } };
  const pp = payParts(e);
  assert.equal(shortPay(e), `${pp.base} base · ${pp.tc} est.`);
});

test("payCell: base only sorts by the top of the range; OTE is labeled", () => {
  const c = payCell({ pay: yearly });
  assert.deepEqual([c.base, c.tc, c.sortUsd], ["$172–280k", null, 280000]);
  assert.equal(payCell({ pay: { ...yearly, basis: "OTE" } }).base, "$172–280k OTE");
});

test("payCell: hourly pay is annualized and labeled", () => {
  const c = payCell({ pay: { currency: "USD", min: 60, max: 75, annualMin: 124800, annualMax: 156000, period: "hour", basis: "base" } });
  assert.equal(c.base, "$125–156k/yr hourly");
  assert.equal(c.sortUsd, 156000);
  assert.match(c.title, /Hourly \$60–75\/hr/);
});

test("payCell: estimate only, and nothing known is a dash", () => {
  assert.deepEqual(payCell({ tc_est: { usd: 300000 } }).base, null);
  assert.equal(payCell({ tc_est: { usd: 300000 } }).tc, "~$300k TC");
  for (const e of [null, {}, { tc_est: { usd: 0 } }]) {
    const c = payCell(e);
    assert.equal(c.base, "—");
    assert.equal(c.tc, null);
    assert.equal(c.sortUsd, null);
  }
});

test("sortByPay: TC first, else base top; missing pay last in both directions", () => {
  const rows = [{ n: "1" }, { n: "2" }, { n: "3" }, { n: "4" }];
  const pay = { 1: payCell({ pay: yearly }), 2: payCell({ pay: yearly, tc_est: { usd: 570000 } }), 4: payCell({ pay: { ...yearly, annualMax: 200000 } }) };
  const of = (r) => pay[r.n];
  assert.deepEqual(sortByPay(rows, of, -1).map((r) => r.n), ["2", "1", "4", "3"]);
  assert.deepEqual(sortByPay(rows, of, 1).map((r) => r.n), ["4", "1", "2", "3"]);
});

test("enrichLookup: tracker URL (markdown link) first, then the tracker number", () => {
  const a = { company: "A", report: { tracker: "7" } };
  const b = { company: "B", report: { tracker: "57" }, groupUrls: ["https://member/2"] };
  const find = enrichLookup({ "https://jobs.example/a": a, "https://jobs.example/b": b });
  assert.equal(find({ urls: ["[ashby](https://jobs.example/a)"], tracker: "57" }), a);
  assert.equal(find({ urls: ["https://member/2"] }), b);
  assert.equal(find({ urls: [""], tracker: "057" }), b);
  assert.equal(find({ urls: [], tracker: "99" }), null);
  assert.equal(enrichLookup(null)({ tracker: "1" }), null);
});
