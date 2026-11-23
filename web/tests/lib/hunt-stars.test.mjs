// hunt: starred companies are a filter only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStarOp, isStarred, normalizeStarsDoc, starKeys } from "../../src/lib/hunt-stars.mjs";
import { rankedJobs } from "../../src/lib/hunt-rank-order.mjs";

test("normalizeStarsDoc drops blanks and same-company duplicates", () => {
  assert.deepEqual(normalizeStarsDoc({ companies: ["Stripe", " ", "stripe, inc.", 7, "Anduril Industries"] }), { companies: ["Stripe", "Anduril Industries"] });
  assert.deepEqual(normalizeStarsDoc(null), { companies: [] });
});

test("applyStarOp stars and unstars by company, whatever the spelling", () => {
  let doc = { companies: ["Acme Rockets"] };
  doc = applyStarOp(doc, { company: "Anduril Industries", starred: true });
  assert.deepEqual(doc.companies, ["Acme Rockets", "Anduril Industries"]);
  assert.ok(isStarred(starKeys(doc.companies), "Andurilindustries"));
  doc = applyStarOp(doc, { company: "Andurilindustries", starred: false });
  assert.deepEqual(doc.companies, ["Acme Rockets"]);
  assert.equal(applyStarOp(doc, { company: "", starred: true }), null);
  assert.equal(applyStarOp(doc, { company: "X", starred: "yes" }), null);
});

test("stars and the old favorites flag never change Best overall", () => {
  const job = (o) => ({ source: "inbox", composite: 50, groupLeader: true, locationTier: 1, ...o });
  const jobs = { fav: job({ company: "Stripe", fit: 4.2, rankBoost: true }), other: job({ company: "Other", fit: 4.3 }) };
  assert.deepEqual(rankedJobs(jobs).map((e) => e.url), ["other", "fav"]);
});
