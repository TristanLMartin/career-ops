/**
 * One resolver for everything that belongs to one person.
 *
 * A profile directory holds a person's cv.md, profile files, portals, ranking config and data/.
 * The default profile is the data root itself (the checkout, or CAREER_OPS_ROOT).
 * CAREER_OPS_PROFILE_DIR points every script and the web app at another one, e.g.
 * profiles/<id>/; path-resolver.mjs and web/src/lib/core/data-root.mjs honor it first, so every
 * root-relative path in the scripts follows it too.
 *
 * Per-person settings (name, field, target roles, pay floor, locations, the scorer's rubric and
 * prompt text, whether TC estimates use tech comp data) live in the profile's config/person.yml.
 * Ranking rules (weights, level ladder, location tiers, relevance words) live in
 * config/ranking.yml. presets/<name>/ has complete examples; `npm run onboard` writes them.
 *
 * Older checkouts named some files with a personal prefix (e.g. "<name>-ranking.yml"). Set
 * CAREER_OPS_LEGACY_PREFIX to that prefix ("<name>-") and those names are still read when the
 * new one is missing; scripts/migrate-legacy-names.mjs renames them for good.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadYaml } from "./yaml-document.mjs";
import { getProfilePath } from "../path-resolver.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The profile directory: CAREER_OPS_PROFILE_DIR, else CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR, else the checkout. */
export function profileDir(env = process.env, codeRoot = CODE_ROOT) {
  const v = env.CAREER_OPS_PROFILE_DIR?.trim() || env.CAREER_OPS_ROOT?.trim() || env.CAREER_OPS_DATA_DIR?.trim();
  return v ? path.resolve(codeRoot, v) : codeRoot;
}

/** Config files that older checkouts kept under a prefixed name (config/<prefix><name>). */
export const LEGACY_CONFIG = Object.freeze(["ranking.yml", "comp.json", "lca-employers.yml", "discovery-wide.yml", "cron.env"]);

/** The old-name prefix (CAREER_OPS_LEGACY_PREFIX, e.g. "sam-"), or "" for none. */
export function legacyPrefix(env = process.env) {
  const p = String(env.CAREER_OPS_LEGACY_PREFIX ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,30}-$/i.test(p) ? p : "";
}

/** New config path -> old path, for a prefix: { "config/ranking.yml": "config/<prefix>ranking.yml", ... }. */
export function legacyNames(prefix = legacyPrefix()) {
  return prefix ? Object.fromEntries(LEGACY_CONFIG.map((n) => [`config/${n}`, `config/${prefix}${n}`])) : {};
}

/** The new path, or its old prefixed twin (CAREER_OPS_LEGACY_PREFIX) when only that one exists. */
export function withLegacy(file) {
  if (fs.existsSync(file)) return file;
  const rel = path.join(path.basename(path.dirname(file)), path.basename(file)).split(path.sep).join("/");
  const old = legacyNames()[rel];
  if (!old) return file;
  const alt = path.join(path.dirname(path.dirname(file)), old);
  return fs.existsSync(alt) ? alt : file;
}

/** The profile's config/ranking.yml as an object ({} when missing or unreadable). */
export function readRanking(dir = profileDir()) {
  try { return loadYaml(fs.readFileSync(profilePaths(dir).ranking, "utf8")) ?? {}; } catch { return {}; }
}

/** Every per-person path, from one profile directory. */
export function profilePaths(dir = profileDir()) {
  const data = (...p) => path.join(dir, "data", ...p);
  return {
    root: dir,
    cv: path.join(dir, "cv.md"),
    profileMd: path.join(dir, "modes", "_profile.md"),
    profileYml: getProfilePath(dir),
    skillsProfile: path.join(dir, "skills-profile.md"),
    person: path.join(dir, "config", "person.yml"),
    portals: path.join(dir, "portals.yml"),
    ranking: withLegacy(path.join(dir, "config", "ranking.yml")),
    comp: withLegacy(path.join(dir, "config", "comp.json")),
    lcaEmployers: withLegacy(path.join(dir, "config", "lca-employers.yml")),
    discoveryWide: withLegacy(path.join(dir, "config", "discovery-wide.yml")),
    env: path.join(dir, ".env"),
    data,
    enrich: data("hunt-enrich.json"),
    quick: data("hunt-quick.json"),
    h2h: data("hunt-h2h.json"),
    usage: data("hunt-usage.tsv"),
    pipeline: data("pipeline.md"),
    tracker: data("applications.md"),
    scanHistory: data("scan-history.tsv"),
    scanRuns: data("scan-runs.tsv"),
    messages: data("hunt-messages.jsonl"),
    messageMarks: data("message-marks.json"),
    studyPlan: data("study", "study-plan.md"),
    studyCards: data("study", "cards.jsonl"),
    studyState: data("study-state.json"),
    homeLastVisit: data("home-last-visit.json"),
    cronLog: data("hunt-cron.log"),
  };
}

// Nothing about any person is assumed: a profile's prompts come from its config/person.yml.
export const DEFAULT_PERSON = Object.freeze({
  first_name: "",
  name: "",
  active: false,
  field: "",
  is_tech: false,
  home: "",
  target_roles: [],
  level_target: "",
  base_floor: null,
  currency: "USD",
  locations: [],
  summary: "",
  quick_context: "",
  // The quick scorer's 1-5 rubric (one paragraph). Empty = DEFAULT_QUICK_RUBRIC.
  quick_rubric: "",
  h2h_intro: "",
  h2h_preferences: "",
  h2h_candidate_word: "their",
});

export const DEFAULT_QUICK_RUBRIC = "Score each job below 1-5 for this candidate: 5 = excellent fit and worth applying now, 4 = strong, 3 = plausible, 2 = weak, 1 = wrong role/level/location or below the pay floor.";

/**
 * config/person.yml merged over DEFAULT_PERSON. Prompt parts the file leaves out are built from
 * its own fields (genericPromptPart). YAML block scalars end with a newline; it is trimmed so
 * the rendered prompts match the old template literals exactly.
 */
export function readPerson(dir = profileDir()) {
  let doc = null;
  try { doc = loadYaml(fs.readFileSync(profilePaths(dir).person, "utf8")); } catch { doc = null; }
  const out = { ...DEFAULT_PERSON };
  for (const [k, v] of Object.entries(doc && typeof doc === "object" ? doc : {})) {
    if (v !== null && v !== undefined && v !== "") out[k] = typeof v === "string" ? v.replace(/\n+$/, "") : v;
  }
  for (const k of ["quick_context", "h2h_intro", "h2h_preferences"]) if (!out[k]) out[k] = genericPromptPart(k, out);
  if (!out.quick_rubric) out.quick_rubric = DEFAULT_QUICK_RUBRIC;
  return out;
}

/** Prompt text built only from a profile's own fields (no names, fields or places assumed). */
export function genericPromptPart(key, p) {
  const roles = [].concat(p.target_roles ?? []).filter(Boolean).join(", ") || "not set yet";
  const places = [].concat(p.locations ?? []).filter(Boolean).join("; ") || "not set yet";
  const cur = String(p.currency || "USD");
  const floor = p.base_floor ? (cur === "USD" ? `$${Math.round(Number(p.base_floor) / 1000)}k` : `${Math.round(Number(p.base_floor) / 1000)}k ${cur}`) : "not set";
  if (key === "quick_context") {
    return `Candidate: ${p.name || "(name not set yet)"}${p.home ? `, ${p.home}` : ""}. Field: ${p.field || "not set yet"}.
${p.summary ? String(p.summary).trim() + "\n" : ""}Target roles: ${roles}.
Preferences: ${p.level_target || "level not set"}. Base salary floor ${floor}. Locations: ${places}.`;
  }
  if (key === "h2h_intro") return `You are helping a job seeker in ${p.field || "their field"} rank job openings against their own profile.`;
  return [
    `- Pay: base floor ${floor}; higher pay is better.`,
    `- Level: ${p.level_target || "not set"}.`,
    `- Target roles: ${roles}.`,
    `- Location: ${places}.`,
  ].join("\n");
}
