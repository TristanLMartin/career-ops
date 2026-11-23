// hunt: /portals company links -> Jobs filtered to that company (?company=X&board=...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsBoard, companyFilter, companyHref, companyKey, matchesCompany } from "../../src/lib/hunt-company-filter.mjs";

test("company keys ignore case, punctuation, legal suffixes and Industries/Technologies/AI tails", () => {
  assert.equal(companyKey("Anduril Industries, Inc."), companyKey("Andurilindustries"));
  assert.equal(companyKey("Snorkel AI"), companyKey("Snorkelai"));
  assert.equal(companyKey("Acme Rockets Technologies"), companyKey("Acme Rockets"));
  assert.equal(companyKey("OpenAI"), "openai");
  assert.notEqual(companyKey("Stripe"), companyKey("Ramp"));
});

test("ATS boards from portal careers URLs and posting URLs", () => {
  assert.equal(atsBoard("https://job-boards.greenhouse.io/anthropic/jobs/5457716008"), "greenhouse:anthropic");
  assert.equal(atsBoard("https://boards-api.greenhouse.io/v1/boards/anthropic/jobs"), "greenhouse:anthropic");
  assert.equal(atsBoard("https://jobs.ashbyhq.com/livekit/b889ef16"), "ashby:livekit");
  assert.equal(atsBoard("https://jobs.lever.co/palantir/88f8f593"), "lever:palantir");
  assert.equal(atsBoard("https://stripe.com/jobs/search?gh_jid=1"), null);
});

test("a job matches by name or by the portal entry's board (aliases on the same board)", () => {
  const f = companyFilter("Acme Rockets Technologies", ["greenhouse:acmerocketstechnologies"]);
  assert.ok(matchesCompany({ company: "Acme Rockets", url: "https://x/1" }, f));
  assert.ok(matchesCompany({ company: "Acme", url: "https://job-boards.greenhouse.io/acmerocketstechnologies/jobs/1" }, f));
  assert.ok(!matchesCompany({ company: "Relativity Space", url: "https://job-boards.greenhouse.io/relativity/jobs/1" }, f));
  assert.equal(companyHref("Acme Rockets", ["greenhouse:acme"]), "/pipeline?company=Acme+Rockets&board=greenhouse%3Aacme");
});
