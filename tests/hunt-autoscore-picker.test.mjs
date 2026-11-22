// The auto-evaluation picker. Without a profile picker it applies the profile's `target`
// filters (here the SWE test fixture's); with `auto_score_picker` (a recruiter profile's search)
// it picks by that profile's own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { pickCandidates, pickWithProfile } from "../scripts/hunt-autoscore.mjs";
import { LEGACY } from "./helpers/swe-legacy-rules.mjs";

const target = LEGACY.target;

const job = (o) => ({ source: "inbox", fit: null, composite: 50, level: { key: "senior" }, locationTier: 1, company: "Acme", role: "Senior Software Engineer", ...o });

// Every filter of the target picker, frozen: if the fixture's picks ever change, this fails.
const SWE_JOBS = {
  ok1: job({ composite: 90, company: "A" }),
  ok2: job({ composite: 89, company: "A" }),
  thirdAtA: job({ composite: 88, company: "A" }),
  staffplus: job({ composite: 87, company: "B", level: { key: "staffplus" } }),
  noLevel: job({ composite: 86, company: "C", level: null }),
  helpdesk: job({ composite: 85, company: "D", role: "IT Help Desk Engineer" }),
  contract: job({ composite: 84, company: "E", contract: true }),
  nyc: job({ composite: 83, company: "F", locationTier: 3 }),
  quantNyc: job({ composite: 82, company: "Jane Street", locationTier: 3 }),
  global: job({ composite: 81, company: "G", locationTier: 5 }),
  evaluated: job({ composite: 99, company: "H", fit: 4.2 }),
  tracker: job({ composite: 98, company: "I", source: "tracker" }),
  dual: job({ composite: 80, company: "J", level: { key: "dual" } }),
};

test("the target picker (no auto_score_picker) is unchanged", () => {
  const urls = (o) => pickCandidates(SWE_JOBS, { count: 10, perCompany: 2, target, ...o }).map((p) => p.url);
  assert.deepEqual(urls(), ["ok1", "ok2", "noLevel", "quantNyc", "global", "dual"]);
  assert.deepEqual(urls({ picker: null }), urls());
  assert.deepEqual(pickCandidates(SWE_JOBS, { count: 0, target }), []);
});

const RECRUITER = {
  title_include: ["recruiter", "recruiting", "sourcer", "talent acquisition", "talent partner", "TA partner"],
  location_tiers: [1, 2],
  contract_factor: 0.9,
  exclude_titles: ["coordinator", "scheduler"],
  exclude_companies: ["RPO", "Cielo", "Randstad"],
  exclude_unless_quick: 5,
  per_company: 2,
};

test("Recruiter-profile picker: its own titles, home + remote US, any level, no always-companies", () => {
  const jobs = {
    rec: job({ composite: 80, company: "A", role: "Senior Technical Recruiter", level: { key: "staffplus" } }),
    swe: job({ composite: 95, company: "B", role: "Senior Software Engineer" }),
    nyc: job({ composite: 90, company: "C", role: "Recruiter", locationTier: 3 }),
    quant: job({ composite: 90, company: "Jane Street", role: "Recruiter", locationTier: 3 }),
    remote: job({ composite: 70, company: "D", role: "TA Partner", locationTier: 2 }),
    sourcer: job({ composite: 60, company: "E", role: "Lead Sourcer" }),
  };
  assert.deepEqual(pickWithProfile(jobs, RECRUITER, { count: 10 }).map((p) => p.url), ["rec", "remote", "sourcer"]);
});

test("contract roles stay in but rank lower", () => {
  const jobs = {
    contract: job({ composite: 80, company: "A", role: "Technical Recruiter (3-6 month contract)" }),
    perm: job({ composite: 75, company: "B", role: "Technical Recruiter" }),
    flagged: job({ composite: 70, company: "C", role: "Recruiter", contract: true }),
  };
  const picks = pickWithProfile(jobs, RECRUITER, { count: 10 });
  assert.deepEqual(picks.map((p) => p.url), ["perm", "contract", "flagged"]);
  assert.equal(picks[1].contract, true);
  assert.equal(picks[1].rank, 72);
});

test("coordinator and RPO-agency roles are skipped unless their quick score is 5", () => {
  const jobs = {
    coord: job({ composite: 90, company: "A", role: "Recruiting Coordinator", quick_score: 4 }),
    coord5: job({ composite: 89, company: "B", role: "Recruiting Coordinator", quick_score: 5 }),
    rpo: job({ composite: 88, company: "Cielo", role: "Technical Recruiter", quick_score: 4 }),
    rpoTitle: job({ composite: 87, company: "C", role: "Technical Recruiter (RPO)", quick_score: 3 }),
    ok: job({ composite: 80, company: "D", role: "Technical Recruiter", quick_score: 3 }),
  };
  assert.deepEqual(pickWithProfile(jobs, RECRUITER, { count: 10 }).map((p) => p.url), ["coord5", "ok"]);
});

test("at most per_company per company, and pickCandidates routes to the profile picker", () => {
  const jobs = {
    a1: job({ composite: 90, company: "A", role: "Recruiter" }),
    a2: job({ composite: 89, company: "A", role: "Recruiter II" }),
    a3: job({ composite: 88, company: "A", role: "Senior Recruiter" }),
    b1: job({ composite: 70, company: "B", role: "Sourcer" }),
  };
  assert.deepEqual(pickCandidates(jobs, { count: 10, picker: RECRUITER }).map((p) => p.url), ["a1", "a2", "b1"]);
  assert.deepEqual(pickCandidates(jobs, { count: 10, picker: { ...RECRUITER, per_company: 3 } }).map((p) => p.url), ["a1", "a2", "a3", "b1"]);
  assert.deepEqual(pickCandidates(jobs, { count: 0, picker: RECRUITER }), []);
});
