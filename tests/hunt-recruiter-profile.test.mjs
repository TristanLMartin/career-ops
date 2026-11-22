// A non-tech (recruiter) profile. Recruiting titles pass the scanner and rank as relevant; SWE
// titles do not. The default profile's boards are reused read-only, with its search terms,
// favorites and websearch entries removed. Pay never uses tech TC estimates.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildTitleFilter } from "../title-keywords.mjs";
import { configureRankRules, relevanceV2, levelFit } from "../lib/hunt-rank.mjs";
import * as yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { adaptEntry, profileBoards, renderPortals, buildProfilePortals, MARKER } from "../scripts/hunt-profile-boards.mjs";
import { readPerson } from "../lib/profile-paths.mjs";

// The same keyword shapes as a recruiter profile's portals.yml title_filter.
const RECRUITER_TITLES = {
  positive: ["Recruit", "Talent Acquisition", "Talent Partner", "Talent Sourc", "word:Sourcer", "Technical Sourcing", "Sourcing Lead", "word:TA + Partner"],
  negative: ["word:Intern", "Internship", "word:Director", "word:VP", "Strategic Sourcing", "Procurement"],
};
const RULES = {
  location: { home: ["Denver", "Boulder", "CO"] },
  relevance: {
    title_family: ["recruiter", "recruiting", "talent acquisition", "talent partner", "sourcer", "TA partner"],
    title_strong: ["technical recruiter", "technical sourcer", "talent acquisition partner", "senior recruiter"],
    title_off: ["director", "procurement", "strategic sourcing", "engineer", "developer"],
    domains: { tech_hiring: { weight: 15, words: ["software engineers", "technical roles"] }, full_cycle: { weight: 12, words: ["full cycle", "offer negotiation"] } },
    languages: ["greenhouse", "successfactors"],
  },
};

test("recruiter title filter keeps recruiting titles and drops SWE, procurement and too-senior titles", () => {
  const keep = buildTitleFilter(RECRUITER_TITLES);
  for (const t of ["Senior Technical Recruiter", "Technical Recruiter II", "Talent Acquisition Partner", "Sr. TA Partner", "Technical Sourcer",
    "Sourcing Lead, Talent", "Lead Recruiter", "Recruiting Manager", "University Recruiter", "Recruiting Coordinator", "Recruiting Programs Manager"]) {
    assert.equal(keep(t), true, t);
  }
  for (const t of ["Senior Software Engineer", "Backend Engineer", "Forward Deployed Engineer", "Solutions Architect", "Staff Platform Engineer",
    "Strategic Sourcing Manager", "Procurement Specialist", "Director, Talent Acquisition", "VP Recruiting", "Recruiting Intern"]) {
    assert.equal(keep(t), false, t);
  }
});

test("recruiter profile_rules rank recruiting roles above engineering ones, and reset cleanly", () => {
  try {
    configureRankRules(RULES);
    const jd = "Partner with hiring managers on full cycle recruiting for software engineers; offer negotiation; Greenhouse.";
    const rec = relevanceV2("Senior Technical Recruiter", jd);
    assert.ok(rec >= 40, `recruiter relevance ${rec}`);
    assert.equal(relevanceV2("Senior Software Engineer", "Build distributed systems in Go."), 0);
    assert.ok(relevanceV2("Strategic Sourcing Manager", "procurement") < 20);
    // Lead/Principal recruiter is a stretch, not the SWE "Staff+" 0.25 penalty.
    const factors = { senior: 1, mid: 0.9, dual: 0.9, stretch: 0.75, staff: 0.75, staffplus: 0.7 };
    assert.equal(levelFit("Lead Recruiter", "", "", { factors, bigCompanies: [] }).factor, 0.7);
    assert.equal(levelFit("Senior Technical Recruiter", "", "", { factors, bigCompanies: [] }).factor, 1);
  } finally {
    configureRankRules(null);
  }
  assert.ok(relevanceV2("Senior Technical Recruiter", "") === 0, "neutral defaults: no relevance words assumed");
});

test("shared boards: software queries replaced, favorites and websearch entries dropped", () => {
  const q = ["technical recruiter", "sourcer"];
  const amazon = adaptEntry({ name: "Amazon", provider: "amazon", careers_url: "https://www.amazon.jobs/en/search", amazon: { loc_query: "Denver, Colorado, USA", base_query: "software development engineer", category: "software-development" }, max_pages: 6 }, { queries: q });
  assert.equal(amazon.length, 2);
  assert.deepEqual(amazon.map((e) => e.amazon.base_query), q);
  assert.ok(amazon.every((e) => !("category" in e.amazon) && e.amazon.loc_query.startsWith("Denver")));
  assert.deepEqual(adaptEntry({ name: "Google", provider: "google", google: { location: "Denver, CO, USA", queries: ["senior software engineer"] } }, { queries: q }).google.queries, q);
  const fav = adaptEntry({ name: "Acme Rockets", careers_url: "https://job-boards.greenhouse.io/acmerockets", title_allow: ["Software Engineer"], notes: "x" });
  assert.equal(fav.title_allow, undefined);
  assert.equal(adaptEntry({ name: "Example Trading", scan_method: "websearch", scan_query: "Software Engineer" }), null);
  assert.equal(adaptEntry({ name: "Built In Denver", provider: "builtin", categories: ["dev-engineering"] }), null);
  assert.equal(adaptEntry({ name: "Off", enabled: false }), null);
});

test("profileBoards reads the main lists read-only, dedupes, honors extras and excludes; never rewrites the default profile", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-boards-"));
  const main = path.join(tmp, "main");
  fs.mkdirSync(path.join(main, "data"), { recursive: true });
  const mainPortals = "title_filter:\n  positive: [Software Engineer]\ntracked_companies:\n  - { name: Acme, careers_url: https://jobs.lever.co/acme }\n  - { name: Skipme, careers_url: https://jobs.lever.co/skipme }\n";
  fs.writeFileSync(path.join(main, "portals.yml"), mainPortals);
  fs.writeFileSync(path.join(main, "data", "discovery-boards.yml"), `# gen\n${JSON.stringify({ tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme/" }, { name: "Beta", careers_url: "https://jobs.ashbyhq.com/beta" }] })}\n`);
  const boards = profileBoards({ mainRoot: main, cfg: { exclude: ["skipme"], extra_companies: [{ name: "Gem", careers_url: "https://jobs.ashbyhq.com/gem" }] } });
  assert.deepEqual(boards.map((b) => b.name), ["Gem", "Acme", "Beta"]);

  const prof = path.join(tmp, "profiles", "sam");
  fs.mkdirSync(path.join(prof, "config"), { recursive: true });
  fs.writeFileSync(path.join(prof, "portals.yml"), `title_filter:\n  positive: [Recruit]\n\n${MARKER}\ntracked_companies: []\n`);
  buildProfilePortals({ dir: prof, mainRoot: main });
  buildProfilePortals({ dir: prof, mainRoot: main }); // idempotent
  const text = fs.readFileSync(path.join(prof, "portals.yml"), "utf8");
  assert.equal(text.split(MARKER).length, 2);
  assert.match(text, /positive: \[Recruit\]/);
  assert.match(text, /jobs\.lever\.co\/acme/);
  assert.equal(fs.readFileSync(path.join(main, "portals.yml"), "utf8"), mainPortals, "main portals untouched");
  assert.throws(() => buildProfilePortals({ dir: main, mainRoot: main }), /refusing/);
  assert.match(renderPortals("a: 1\n", []), /a: 1\n\n# ---- generated/);
});

test("a non-tech person never gets tech TC estimates, and the quick-score prompt carries their rubric, not SWE text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-rec-"));
  fs.mkdirSync(path.join(tmp, "config"));
  fs.writeFileSync(path.join(tmp, "config", "person.yml"), "first_name: Sam\nname: Sam\nactive: true\nfield: technical recruiting\nis_tech: false\ntarget_roles: [Technical Recruiter, Talent Acquisition Partner]\nlocations: [Denver area, Remote US]\n");
  const p = readPerson(tmp);
  assert.equal(p.is_tech, false);
  assert.match(p.quick_context, /technical recruiting[\s\S]*Technical Recruiter/);
  assert.doesNotMatch(p.quick_context, /software engineer|backend|payments|Meta|\$200k/i);
});

test("the recruiting preset's title filter and ladder match the recruiter titles above", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const portals = yaml.load(fs.readFileSync(path.join(ROOT, "presets", "recruiting", "portals.yml"), "utf8"));
  const keep = buildTitleFilter(portals.title_filter);
  for (const t of ["Senior Technical Recruiter", "Talent Acquisition Partner", "Technical Sourcer", "Recruiting Coordinator", "University Recruiter", "Recruiting Programs Manager"]) assert.equal(keep(t), true, t);
  for (const t of ["Senior Software Engineer", "Strategic Sourcing Manager", "VP Recruiting", "Recruiting Intern"]) assert.equal(keep(t), false, t);
  const ranking = yaml.load(fs.readFileSync(path.join(ROOT, "presets", "recruiting", "config", "ranking.yml"), "utf8"));
  const opts = { rules: ranking.profile_rules.level.rules, defaultLevel: ranking.profile_rules.level.default };
  assert.ok(levelFit("Lead Recruiter", "", "", opts).factor >= 0.8, "lead is a near-target level, not a Staff+ penalty");
  assert.equal(levelFit("Senior Technical Recruiter", "", "", opts).factor, 1);
});

test("profile boards: search terms default to the profile's target roles", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-boards-q-"));
  const main = path.join(tmp, "main");
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(main, "portals.yml"), `tracked_companies:\n  - ${JSON.stringify({ name: "Google", provider: "google", google: { location: "Denver, CO, USA", queries: ["software engineer"] } })}\n`);
  const prof = path.join(tmp, "profiles", "sam");
  fs.mkdirSync(path.join(prof, "config"), { recursive: true });
  fs.writeFileSync(path.join(prof, "config", "person.yml"), "target_roles: [Technical Recruiter, Sourcer]\n");
  buildProfilePortals({ dir: prof, mainRoot: main });
  assert.match(fs.readFileSync(path.join(prof, "portals.yml"), "utf8"), /"queries":\["technical recruiter","sourcer"\]/);
});
