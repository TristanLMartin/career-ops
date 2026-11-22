// Tests for lib/hunt-rank.mjs and the parsers in scripts/hunt-enrich.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  locationTier, parsePay, payScore, benefitFlags, benefitScore,
  relevanceTargets, relevanceScore, parseFit, composite, fitToPct, levelFit, topPicks, DEFAULT_WEIGHTS,
} from "../lib/hunt-rank.mjs";
import { useLegacyRules, LEGACY_LEVEL } from "./helpers/swe-legacy-rules.mjs";

// The library ships neutral; these tests use the SWE fixture rules (a Seattle backend engineer).
useLegacyRules();

test("locationTier: Seattle area beats remote beats NYC/Chicago", () => {
  assert.equal(locationTier("San Francisco, CA / New York City, NY / Seattle, WA"), 1);
  assert.equal(locationTier("US-CA-Menlo Park · US-WA-Bellevue · Bellevue"), 1);
  assert.equal(locationTier("Remote - USA"), 2);
  assert.equal(locationTier("New York City · New York · United States"), 3);
  assert.equal(locationTier("Chicago, Illinois, United States"), 3);
  assert.equal(locationTier("Austin, TX"), 4);
  assert.equal(locationTier(""), null);
});

test("parsePay: stored cells, JD ranges, hourly and junk", () => {
  assert.deepEqual(parsePay("200000-280000 USD"), { min: 200000, max: 280000, currency: "USD", period: "year", annualMin: 200000, annualMax: 280000 });
  const jd = parsePay("Annual Salary:\n $350,000 — $850,000 USD \n Logistics");
  assert.equal(jd.annualMin, 350000);
  assert.equal(jd.annualMax, 850000);
  assert.equal(parsePay("Salary: $206,086 - $285,600/yr.").annualMax, 285600);
  assert.equal(parsePay("$150K–$200K").annualMin, 150000);
  const hourly = parsePay("$60 - $80 per hour");
  assert.equal(hourly.period, "hour");
  assert.equal(hourly.annualMin, 60 * 2080);
  assert.equal(parsePay("CA$120,000 - CA$150,000").currency, "CAD");
  assert.equal(parsePay("$152,405—$179,300,152 USD"), null, "implausible totals are dropped");
  assert.equal(parsePay("no numbers here"), null);
});

test("payScore maps the midpoint across the band and clamps", () => {
  const band = { floor: 150000, ceiling: 350000 };
  assert.equal(payScore(parsePay("200000-300000 USD"), band), 50);
  assert.equal(payScore(parsePay("400000-500000 USD"), band), 100);
  assert.equal(payScore(parsePay("80000-100000 USD"), band), 0);
  assert.equal(payScore(null, band), null);
});

test("benefitFlags finds the six flags with regexes", () => {
  const f = benefitFlags("We offer a 401(k) plan with company match, RSUs, a home office stipend, 16 weeks of parental leave, 100% of medical premiums covered and an annual bonus.");
  assert.deepEqual(f, { k401_match: true, equity: true, remote_stipend: true, parental_leave: true, health_full: true, bonus: true });
  assert.equal(benefitScore(f), 100);
  assert.equal(benefitFlags(""), null);
  assert.equal(benefitScore(benefitFlags("Competitive salary.")), 0);
});

test("relevanceScore uses target roles and CV skills", () => {
  const profile = { target_roles: { primary: ["Forward Deployed Engineer", "Senior Backend Software Engineer"], archetypes: [{ name: "Applied AI Engineer" }] } };
  const cv = "## Skills\n\n- **Languages:** Java, Python, TypeScript, SQL\n- **Frameworks & Infrastructure:** React, Kafka, Redis, AWS, Stripe\n- **Other:** Circumnavigated the globe\n";
  const t = relevanceTargets(profile, cv);
  assert.ok(t.skills.includes("kafka"));
  assert.ok(!t.skills.some((s) => s.includes("circumnavigat")));
  assert.equal(relevanceScore("Forward Deployed Engineer", "", t), 100);
  assert.ok(relevanceScore("Forward Deployed Engineer", "Python, Kafka, AWS and React", t) > relevanceScore("Forward Deployed Engineer", "Excel", t));
  assert.ok(relevanceScore("Account Executive", "Excel", t) < 30);
});

test("composite renormalizes missing parts instead of zeroing them", () => {
  const w = { fit: 35, relevance: 25, pay: 20, location: 15, benefits: 5 };
  assert.equal(composite({ fit: null, relevance: 80, pay: null, location: 100, benefits: null }, w), Math.round(((80 * 25 + 100 * 15) / 40) * 10) / 10);
  assert.equal(composite({ fit: null, relevance: null, pay: null, location: null, benefits: null }, w), null);
  assert.equal(composite({ fit: 100, relevance: 100, pay: 100, location: 100, benefits: 100 }, w), 100);
});

test("parseFit and fitToPct", () => {
  assert.equal(parseFit("4.1/5"), 4.1);
  assert.equal(parseFit("N/A"), null);
  assert.equal(fitToPct(5), 100);
  assert.equal(fitToPct(1), 0);
  assert.equal(fitToPct(null), null);
});

test("hunt-enrich parsers: pipeline rows and job ids", async () => {
  process.env.CAREER_OPS_ROOT ??= process.cwd();
  const { parsePipeline, jobIdFromUrl, htmlToText } = await import("../scripts/hunt-enrich.mjs");
  const rows = parsePipeline("# x\n\n## Pending\n\n- [ ] https://jobs.ashbyhq.com/openai/7f4c5eef-37f9-4454-a1fb-ef1e66b075d9 | OpenAI | FDE | Seattle · United States | 185000-300000 USD | posted: 2026-09-11\n- [ ] https://stripe.com/jobs/search?gh_jid=8301253 | Stripe | Backend | Seattle | posted: 2026-10-19\n## Done\n- [x] https://x.example/1 | X | Y\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].comp, "185000-300000 USD");
  assert.equal(rows[1].comp, "");
  assert.equal(rows[1].posted, "2026-10-19");
  assert.equal(jobIdFromUrl("https://stripe.com/jobs/search?gh_jid=8301253", "greenhouse"), "8301253");
  assert.equal(jobIdFromUrl("https://job-boards.greenhouse.io/affirm/jobs/8197325003", "greenhouse"), "8197325003");
  assert.equal(jobIdFromUrl("https://jobs.ashbyhq.com/openai/7F4C5EEF-37f9-4454-a1fb-ef1e66b075d9", "ashby"), "7f4c5eef-37f9-4454-a1fb-ef1e66b075d9");
  assert.equal(htmlToText("&lt;p&gt;$1 &amp;mdash; $2&lt;/p&gt;"), "$1 — $2");
});

test("levelFit: Senior target, Staff only as a stretch at mid-size payments/real-time", () => {
  const f = (t, c = "Affirm", d = "") => levelFit(t, c, d, LEGACY_LEVEL);
  assert.equal(f("Senior Software Engineer, Backend").key, "senior");
  assert.equal(f("Sr. Solutions Engineer", "Databricks").factor, 1);
  assert.equal(f("Forward Deployed Engineer", "Sierra").factor, 1, "no level stated");
  assert.equal(f("Member of Technical Staff (Software Engineer, Data Platform)", "Perplexity").key, "senior", "MTS is not a Staff title");
  assert.equal(f("Senior / Staff Product Engineer", "Linear").key, "dual");
  assert.equal(f("Senior / Staff Product Engineer", "Linear").factor, 0.7);
  assert.equal(f("Staff + Senior Backend Engineer").key, "dual");
  assert.equal(f("Staff + Sr. Engineer").key, "dual");
  assert.equal(f("Senior+ Software Engineer").key, "senior");
  assert.equal(f("Software Engineer, Labs", "Anthropic").factor, 0.85, "plain SWE at big tech");
  assert.equal(f("Software Engineer II, Backend").factor, 0.85);
  assert.equal(f("Staff Software Engineer, Payments", "Brex").key, "stretch");
  assert.equal(f("Staff Software Engineer, Platform", "Brex", "We process payments at scale").key, "stretch", "domain from the description");
  assert.equal(f("Staff Software Engineer, Payments", "Stripe").key, "staff", "big company: no stretch");
  assert.equal(f("Staff Software Engineer, Search").factor, 0.45);
  assert.equal(f("Solutions Architect", "Databricks").factor, 1, "Solutions Architect is a role, not a level");
  assert.equal(f("Senior Solution Architect", "Snowflake").key, "senior");
  assert.equal(f("Staff Solutions Architect", "Scale AI").key, "staff");
  assert.equal(f("Principal Solutions Architect", "Scale AI").factor, 0.25);
  assert.equal(f("Lead Solutions Architect", "Scale AI").factor, 0.25);
  for (const t of ["Staff+ Software Engineer, Caching", "Senior Staff Software Engineer", "Principal Engineer", "Engineering Lead", "Enterprise Architect"]) {
    assert.equal(f(t).factor, 0.25, t);
  }
  assert.equal(levelFit("Staff Software Engineer", "Affirm", "", { ...LEGACY_LEVEL, factors: { staff: 0.5 } }).factor, 0.5, "factors are configurable");
  assert.deepEqual(DEFAULT_WEIGHTS, { fit: 35, relevance: 20, pay: 10, location: 15, benefits: 5, level: 15 });
});

test("topPicks: fit-scored only, fit >= 3.8, level >= 0.7, max 3 per company", () => {
  const j = (company, fit, composite, factor = 1) => ({ company, fit, composite, level: { factor } });
  const jobs = [
    ["a1", j("A", 4.5, 90)], ["a2", j("A", 4.4, 89)], ["a3", j("A", 4.3, 88)], ["a4", j("A", 4.2, 87)],
    ["b1", j("B", 3.7, 99)], ["c1", j("C", 4.6, 95, 0.45)], ["d1", j("D", null, 100)], ["e1", j("E", 4.0, 70)], ["f1", j("F", 3.8, 60, 0.7)],
  ];
  assert.deepEqual(topPicks(jobs).map(([u]) => u), ["a1", "a2", "a3", "e1", "f1"]);
  assert.deepEqual(topPicks(jobs, { limit: 2 }).map(([u]) => u), ["a1", "a2"]);
});

test("payFromDescription picks the right band and labels it base", async () => {
  const { payFromDescription } = await import("../lib/hunt-rank.mjs");
  const affirm = payFromDescription("USA Pacific base pay range (CA, WA, NY, NJ, CT): $230,000 - $290,000  USA Sapphire base pay range (all other U.S. states): $204,000 - $264,000");
  assert.deepEqual([affirm.annualMin, affirm.annualMax, affirm.basis, affirm.band], [230000, 290000, "base", "high-cost US"]);
  const dropbox = payFromDescription("US Zone 1 This role is not available in Zone 1 US Zone 2 $159,100 — $215,300 USD US Zone 3 $141,400 — $191,400 USD");
  assert.equal(dropbox.annualMin, 159100, "the highest available US zone");
  const doordash = payFromDescription("I4\n $130,600 — $192,000 USD \n I5\n $159,800 — $235,000 USD \n I6\n $193,800 — $285,000 USD");
  assert.deepEqual([doordash.annualMin, doordash.band], [159800, "level band"], "middle level band");
  assert.equal(payFromDescription("Canada: CA$150,000 - CA$190,000 ... US: $200,000 - $250,000").annualMin, 200000, "non-US bands skipped");
  assert.equal(payFromDescription("$220,000 - $288,000 OTE (On Target Earnings = Base + Variable)").basis, "OTE");
  assert.equal(payFromDescription("$60 - $80 per hour"), null, "hourly is left to parsePay");
  assert.equal(payFromDescription("Competitive salary"), null);
});

test("relevanceV2 weights the profile's domains above generic words", async () => {
  const { relevanceV2 } = await import("../lib/hunt-rank.mjs");
  const payments = relevanceV2("Senior Software Engineer, Payments", "Own payments, checkout and fraud systems. Java, Go, Kafka. Real-time ledger.");
  const generic = relevanceV2("Senior Software Engineer", "Build features for our product. Python.");
  const offTarget = relevanceV2("Software Engineer, Design System", "React components and a design system.");
  assert.ok(payments >= 50, `payments ${payments}`);
  assert.ok(generic < payments - 20, `generic ${generic}`);
  assert.ok(offTarget < 25, `off-target ${offTarget}`);
  assert.ok(relevanceV2("Sr. Solutions Engineer", "") > relevanceV2("Account Executive", ""));
});

test("groupKey collapses team, location and level variants but keeps the discipline", async () => {
  const { groupKey } = await import("../lib/hunt-rank.mjs");
  assert.equal(groupKey("Databricks", "Sr. Forward Deployed Engineer (FDE) - Retail"), groupKey("Databricks", "Forward Deployed Engineer (FDE) - Digital Native Business"));
  assert.equal(groupKey("Affirm", "Senior Software Engineer, Backend (Consumer)"), groupKey("Affirm", "Staff Software Engineer, Backend (Cards)"));
  assert.notEqual(groupKey("Affirm", "Senior Software Engineer, Backend (Consumer)"), groupKey("Affirm", "Senior Software Engineer, Fullstack (Consumer)"));
  assert.equal(groupKey("OpenAI", "Forward Deployed Engineer (FDE) - Seattle"), "openai|fde");
  assert.equal(groupKey("Microsoft", "Senior Software Engineer, Minecraft"), groupKey("Microsoft", "Software Engineer II - Minecraft"));
  assert.equal(groupKey("Acme", "Senior Backend Engineer"), groupKey("Acme", "Software Engineer, Backend (Cards)"));
  assert.notEqual(groupKey("Acme", "Senior Backend Engineer"), groupKey("Acme", "Senior Payments Backend Engineer"));
  assert.notEqual(groupKey("Acme", "Forward Deployed Engineer"), groupKey("Acme", "Solutions Engineer"));
  assert.notEqual(groupKey("Stripe", "Backend Engineer"), groupKey("Affirm", "Backend Engineer"));
});

test("company_boost: case-insensitive flat points, capped at 100", async () => {
  const { companyBoost, boostedComposite } = await import("../lib/hunt-rank.mjs");
  assert.equal(companyBoost("acme rockets", { "Acme Rockets": 10 }), 10);
  assert.equal(companyBoost("Stripe", { "Acme Rockets": 10 }), 0);
  assert.equal(boostedComposite({ fit: 80 }, { fit: 1 }, 10), 90);
  assert.equal(boostedComposite({ fit: 95 }, { fit: 1 }, 10), 100);
  assert.equal(boostedComposite({}, { fit: 1 }, 10), null);
});

test("relevanceV2: observability/platform boosted, frontend/mobile down, Kafka/Redis/gRPC/AWS/K8s no credit, Java modest plus", async () => {
  const { relevanceV2 } = await import("../lib/hunt-rank.mjs");
  const jd = "We build the backend platform. ".repeat(20);
  const obs = relevanceV2("Senior Software Engineer, Observability", jd + " logging telemetry metrics tracing analytics data platform ".repeat(5));
  const plain = relevanceV2("Senior Software Engineer", jd);
  const fe = relevanceV2("Senior Frontend Engineer", jd);
  const mobile = relevanceV2("Senior iOS Engineer", jd);
  assert.ok(obs > plain, `observability ${obs} > plain ${plain}`);
  assert.ok(fe < plain && mobile < plain, `frontend ${fe} / mobile ${mobile} < plain ${plain}`);
  const dropped = relevanceV2("Senior Software Engineer", jd + " kafka redis grpc aws kubernetes ".repeat(5));
  assert.equal(dropped, plain, "dropped / Familiar stack keywords get no credit");
  const java = relevanceV2("Senior Software Engineer", jd + " java ".repeat(5));
  assert.ok(java > plain && java - plain <= 2, `Java is a modest plus (${plain} -> ${java})`);
  assert.equal(relevanceV2("Senior Software Engineer", jd + " javascript "), relevanceV2("Senior Software Engineer", jd + " python "), "javascript is not java");
});

test("isBelowFloor: posted USD base max under the floor only", async () => {
  const { isBelowFloor } = await import("../scripts/hunt-enrich.mjs");
  const p = (min, max, extra = {}) => ({ min, max, annualMin: min, annualMax: max, currency: "USD", period: "year", basis: "base", ...extra });
  assert.equal(isBelowFloor(p(150000, 190000), 200000), true);
  assert.equal(isBelowFloor(p(180000, 220000), 200000), false, "straddling is fine");
  assert.equal(isBelowFloor(p(150000, 200000), 200000), false, "max at the floor is fine");
  assert.equal(isBelowFloor(null, 200000), false, "unknown base: no penalty");
  assert.equal(isBelowFloor(p(150000, 190000, { basis: "OTE" }), 200000), false);
  assert.equal(isBelowFloor(p(150000, 190000, { currency: "CAD" }), 200000), false);
  assert.equal(isBelowFloor(p(150000, 190000), null), false);
});

test("payFromDescription: escaped dash entities between the two ends of a band", async () => {
  const { payFromDescription } = await import("../lib/hunt-rank.mjs");
  for (const t of ["$186,065&mdash;$218,900 USD", "$186,065 &amp;mdash; $218,900 USD", "$186,065\n&#8212;\n$218,900"]) {
    const p = payFromDescription(t);
    assert.deepEqual([p.annualMin, p.annualMax], [186065, 218900], t);
  }
});
