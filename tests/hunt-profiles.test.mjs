// Per-person profiles. The default profile resolves to the checkout's paths, prompts come only
// from config/person.yml, and a new profile inherits nothing from anyone else's.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { profileDir, profilePaths, readPerson, genericPromptPart } from "../lib/profile-paths.mjs";
import { configureRankRules, locationTier, relevanceV2 } from "../lib/hunt-rank.mjs";
import { newProfile } from "../scripts/hunt-new-profile.mjs";
import { useLegacyRules } from "./helpers/swe-legacy-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The default profile's own person.yml + profile.yml are personal and never shipped.
const HAS_PERSON = fs.existsSync(path.join(ROOT, "config", "person.yml")) && fs.existsSync(path.join(ROOT, "config", "profile.yml"));

test("default profile = the checkout, at today's exact paths", () => {
  assert.equal(profileDir({}), ROOT);
  const p = profilePaths(profileDir({}));
  assert.equal(p.cv, path.join(ROOT, "cv.md"));
  assert.equal(p.skillsProfile, path.join(ROOT, "skills-profile.md"));
  assert.equal(p.portals, path.join(ROOT, "portals.yml"));
  assert.equal(p.ranking, path.join(ROOT, "config", "ranking.yml"));
  assert.equal(p.comp, path.join(ROOT, "config", "comp.json"));
  assert.equal(p.person, path.join(ROOT, "config", "person.yml"));
  assert.equal(p.enrich, path.join(ROOT, "data", "hunt-enrich.json"));
  assert.equal(p.tracker, path.join(ROOT, "data", "applications.md"));
  assert.equal(p.studyState, path.join(ROOT, "data", "study-state.json"));
  assert.equal(p.data("x.json"), path.join(ROOT, "data", "x.json"));
});

test("CAREER_OPS_PROFILE_DIR wins over CAREER_OPS_ROOT, relative to the checkout", () => {
  assert.equal(profileDir({ CAREER_OPS_PROFILE_DIR: "profiles/sam", CAREER_OPS_ROOT: "/elsewhere" }), path.join(ROOT, "profiles", "sam"));
  assert.equal(profileDir({ CAREER_OPS_ROOT: "/elsewhere" }), "/elsewhere");
  // the core resolver every script uses agrees
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", "import { getCareerOpsRoot } from './path-resolver.mjs'; process.stdout.write(getCareerOpsRoot())"], { cwd: ROOT, env: { ...process.env, CAREER_OPS_PROFILE_DIR: "profiles/sam", CAREER_OPS_ROOT: "" }, encoding: "utf8" });
  assert.equal(r.stdout, path.join(ROOT, "profiles", "sam"));
  const d = spawnSync(process.execPath, ["--input-type=module", "-e", "import { getCareerOpsRoot } from './path-resolver.mjs'; process.stdout.write(getCareerOpsRoot())"], { cwd: ROOT, env: { ...process.env, CAREER_OPS_PROFILE_DIR: "", CAREER_OPS_ROOT: "", CAREER_OPS_DATA_DIR: "" }, encoding: "utf8" });
  assert.equal(d.stdout, ROOT, "unset = the checkout, as before");
});

test("quick-score and head-to-head prompts come from the profile's person.yml", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-prompts-"));
  fs.mkdirSync(path.join(tmp, "config"));
  fs.writeFileSync(path.join(tmp, "config", "person.yml"), [
    'name: "Alex Doe"', 'home: "Denver"', 'field: "software engineering"', 'target_roles: ["Senior Backend Engineer"]',
    "base_floor: 150000", 'level_target: "Senior IC"', 'locations: ["Denver area", "Remote US"]',
    'quick_rubric: "Score 1-5: 5 = apply now, 1 = wrong role."', 'h2h_preferences: "- Pay matters most."',
  ].join("\n"));
  const env = { ...process.env, CAREER_OPS_PROFILE_DIR: tmp };
  const code = `const q = await import("./scripts/hunt-quickscore.mjs"); const h = await import("./scripts/hunt-h2h.mjs");
    const e = { company: "Acme", role: "Senior Backend Engineer", location: "Denver, CO", pay: { basis: "base", annualMin: 160000, annualMax: 200000 }, level: { label: "Senior" }, fit: 4.1 };
    process.stdout.write(q.promptFor([q.jobBlock("j1", e, "Build APIs.")]) + "\\n=====\\n" + h.promptFor("PROFILE TEXT", [h.cardFor("J001", e, "5+ years")]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Candidate: Alex Doe, Denver\. Field: software engineering\./);
  assert.match(r.stdout, /Target roles: Senior Backend Engineer\./);
  assert.match(r.stdout, /Base salary floor \$150k/);
  assert.match(r.stdout, /Score 1-5: 5 = apply now, 1 = wrong role\. Use only the text given\./);
  assert.match(r.stdout, /untrusted posting data/);
  assert.match(r.stdout, /<preferences>\n- Pay matters most\.\n<\/preferences>/);
  assert.match(r.stdout, /\[j1\] Senior Backend Engineer \| Acme \| Denver, CO \| base \$160k-200k/);
});

test("a new profile from the template has no trace of anyone else, software or a city in its prompts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "co-profile-"));
  fs.mkdirSync(path.join(tmp, "profiles"));
  fs.cpSync(path.join(ROOT, "profiles", "_template"), path.join(tmp, "profiles", "_template"), { recursive: true });
  const dir = newProfile("sam", { firstName: "Sam", codeRoot: tmp });
  assert.ok(fs.existsSync(path.join(dir, "data")));
  assert.throws(() => newProfile("sam", { codeRoot: tmp }), /already exists/);
  const p = readPerson(dir);
  assert.equal(p.first_name, "Sam");
  assert.equal(p.active, false, "inactive until filled in");
  assert.equal(p.is_tech, false, "TC from the tech LCA table is off by default");
  const h = await import("../scripts/hunt-h2h.mjs");
  const text = [p.quick_context, h.promptFor("CV", [], p)].join("\n");
  assert.doesNotMatch(text, /software|Seattle|Meta|\bhis\b/i);
  const filled = { ...p, name: "Sam Lee", field: "nursing", target_roles: ["Registered Nurse"], base_floor: 95000, locations: ["Portland"] };
  assert.match(genericPromptPart("quick_context", filled), /Sam Lee.*\n?.*nursing[\s\S]*Registered Nurse[\s\S]*\$95k[\s\S]*Portland/);
});

test("the library is neutral until profile_rules are set, and resets cleanly", () => {
  configureRankRules(null);
  assert.equal(locationTier("Seattle, WA"), 4, "no home metro assumed");
  assert.equal(locationTier("Remote - US"), 2);
  assert.equal(relevanceV2("Senior Backend Engineer", "payments platform go python"), 0, "no relevance words assumed");
  try {
    configureRankRules({ location: { home: ["Portland"] }, relevance: { title_family: ["nurse"], title_strong: ["ICU"], domains: { clinical: { weight: 20, words: ["patient care"] } }, languages: [] } });
    assert.equal(locationTier("Portland, OR"), 1);
    assert.equal(locationTier("Seattle, WA"), 4);
    assert.ok(relevanceV2("ICU Nurse", "patient care in the ICU") > relevanceV2("Senior Backend Engineer", "payments platform"));
    useLegacyRules();
    assert.equal(locationTier("Seattle, WA"), 1);
    assert.equal(relevanceV2("Senior Backend Engineer", "payments platform go python"), 44, "the SWE fixture reproduces the old built-in rules");
  } finally {
    configureRankRules(null);
  }
  assert.equal(locationTier("Portland, OR"), 4);
});

test("a configured level ladder replaces the IC ladder (recruiting preset)", async () => {
  const yml = (await import("js-yaml")).load(fs.readFileSync(path.join(ROOT, "presets", "recruiting", "config", "ranking.yml"), "utf8"));
  const { levelFit } = await import("../lib/hunt-rank.mjs");
  const opts = { rules: yml.profile_rules.level.rules, defaultLevel: yml.profile_rules.level.default };
  assert.equal(levelFit("Senior Technical Recruiter", "", "", opts).key, "senior");
  assert.equal(levelFit("Technical Recruiter", "", "", opts).key, "mid");
  assert.equal(levelFit("Lead Technical Sourcer", "", "", opts).key, "lead");
  assert.equal(levelFit("Recruiting Manager, Engineering", "", "", opts).key, "manager");
  assert.equal(levelFit("Director of Talent Acquisition", "", "", opts).key, "exec");
  assert.equal(levelFit("Recruiting Coordinator", "", "", opts).key, "junior");
});

test("autoscore: auto_score_per_day 0 picks nothing (a new profile spends nothing)", async () => {
  const { pickCandidates } = await import("../scripts/hunt-autoscore.mjs");
  const jobs = { u: { source: "inbox", fit: null, composite: 90, level: { key: "senior" }, locationTier: 1, company: "A", role: "R" } };
  assert.deepEqual(pickCandidates(jobs, { count: 0 }), []);
  assert.equal(pickCandidates(jobs, { count: 1 }).length, 1);
});

// Target roles, floor and location come from config/profile.yml (the evaluator's file).
test("targetsLine reads roles, floor (with the straddle rule) and location from profile.yml", async () => {
  const { targetsLine } = await import("../lib/profile-paths.mjs");
  const line = targetsLine({ target_roles: { primary: ["Forward Deployed Engineer", "Senior Backend Engineer"] }, compensation: { minimum: "200000", location_flexibility: "Seattle or remote US" } });
  assert.match(line, /target roles: Forward Deployed Engineer, Senior Backend Engineer/);
  assert.match(line, /base floor \$200k, met when the TOP of a posted band reaches it/);
  assert.match(line, /location: Seattle or remote US/);
  assert.equal(targetsLine({ compensation: { minimum: "" } }), "");
  if (!HAS_PERSON) return; // the readPerson checks need the personal config/person.yml + profile.yml
  const p = readPerson(ROOT);
  assert.match(p.quick_context, /Targets \(config\/profile\.yml\)/);
  assert.match(p.h2h_preferences, /- Targets \(config\/profile\.yml\)/);
});

test("no drift: every profile's person.yml base_floor matches its profile.yml compensation.minimum", async () => {
  const { profileFloor, readProfileYml } = await import("../lib/profile-paths.mjs");
  const dirs = [ROOT, ...fs.readdirSync(path.join(ROOT, "profiles")).filter((d) => !d.startsWith("_")).map((d) => path.join(ROOT, "profiles", d))];
  for (const dir of dirs) {
    const person = readPerson(dir);
    const floor = profileFloor(readProfileYml(dir));
    if (person.base_floor && floor) assert.equal(Number(person.base_floor), floor, `${path.relative(ROOT, dir) || "default"}: person.yml base_floor vs profile.yml compensation.minimum`);
  }
});
