// "Who do I know here?" links (web/src/lib/hunt-referrals.mjs): LinkedIn people search, 1st/2nd degree.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// web/ is optional in a checkout; load its modules only when it is there.
const HAS_WEB = existsSync(new URL("../web/src", import.meta.url));
const { cleanCompanyName, referralLinks } = HAS_WEB ? await import("../web/src/lib/hunt-referrals.mjs") : {};

test("cleanCompanyName: strips legal suffixes and notes, keeps real name words", () => {
  assert.equal(cleanCompanyName("Stripe, Inc."), "Stripe");
  assert.equal(cleanCompanyName("Acme Corp"), "Acme");
  assert.equal(cleanCompanyName("Foo Holdings LLC"), "Foo Holdings");
  assert.equal(cleanCompanyName("Anthropic PBC"), "Anthropic");
  assert.equal(cleanCompanyName("Zillow (via Greenhouse)"), "Zillow");
  assert.equal(cleanCompanyName("Unity Technologies"), "Unity Technologies");
  assert.equal(cleanCompanyName("  Amazon   Web Services "), "Amazon Web Services");
  assert.equal(cleanCompanyName("Company"), "Company"); // never stripped to nothing
  assert.equal(cleanCompanyName(null), "");
});

test("referralLinks: 1st-degree and 2nd-degree people-search URLs", () => {
  const r = referralLinks("Stripe, Inc.");
  assert.equal(r.company, "Stripe");
  assert.equal(r.first.label, "1st-degree at Stripe");
  assert.equal(r.first.url, "https://www.linkedin.com/search/results/people/?keywords=Stripe&network=%5B%22F%22%5D&origin=FACETED_SEARCH");
  assert.equal(r.second.label, "Friends of friends");
  assert.equal(r.second.url, "https://www.linkedin.com/search/results/people/?keywords=Stripe&network=%5B%22S%22%5D&origin=FACETED_SEARCH");
});

test("referralLinks: encodes spaces and symbols; null without a name", () => {
  assert.equal(
    referralLinks("AT&T Labs").first.url,
    "https://www.linkedin.com/search/results/people/?keywords=AT%26T%20Labs&network=%5B%22F%22%5D&origin=FACETED_SEARCH",
  );
  assert.equal(referralLinks(""), null);
  assert.equal(referralLinks("  "), null);
});
