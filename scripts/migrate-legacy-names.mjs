#!/usr/bin/env node
// migrate-legacy-names: rename a profile's files from an old personal prefix to the generic names
// (config/<prefix>ranking.yml -> config/ranking.yml, data/<prefix>enrich.json ->
// data/hunt-enrich.json, data/cache/<prefix>jd/ -> data/cache/hunt-jd/, ...).
//
// Dry run by default: prints the plan and changes nothing. --apply renames. A target that already
// exists is never overwritten (that pair is reported and skipped). Run it with the web UI and
// cron jobs stopped. CAREER_OPS_ROOT (or CAREER_OPS_PROFILE_DIR) picks the profile.
//
// Usage: node scripts/migrate-legacy-names.mjs --prefix <name>- [--apply]
//   (or CAREER_OPS_LEGACY_PREFIX=<name>-; the prefix ends with a dash, e.g. "sam-")
import fs from "node:fs";
import path from "node:path";
import { exitOnHelp } from "../lib/cli-guard.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { profileDir, legacyNames, legacyPrefix } from "../lib/profile-paths.mjs";

/** [from, to] pairs (absolute) for one profile directory, only where `from` exists. */
export function plan(dir, prefix) {
  if (!prefix) return [];
  const pairs = [];
  for (const [to, from] of Object.entries(legacyNames(prefix))) pairs.push([path.join(dir, from), path.join(dir, to)]);
  const data = path.join(dir, "data");
  let names = [];
  try { names = fs.readdirSync(data); } catch { /* no data yet */ }
  for (const n of names) if (n.startsWith(prefix)) pairs.push([path.join(data, n), path.join(data, `hunt-${n.slice(prefix.length)}`)]);
  pairs.push([path.join(data, "cache", `${prefix}jd`), path.join(data, "cache", "hunt-jd")]);
  return pairs.filter(([from]) => fs.existsSync(from));
}

export function migrate(dir, { apply = false, prefix = legacyPrefix() } = {}) {
  const out = { renamed: [], skipped: [], planned: [] };
  for (const [from, to] of plan(dir, prefix)) {
    const rel = `${path.relative(dir, from)} -> ${path.relative(dir, to)}`;
    if (fs.existsSync(to)) { out.skipped.push(`${rel} (target exists)`); continue; }
    if (!apply) { out.planned.push(rel); continue; }
    fs.renameSync(from, to);
    out.renamed.push(rel);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const apply = process.argv.includes("--apply");
  const i = process.argv.indexOf("--prefix");
  const prefix = legacyPrefix({ CAREER_OPS_LEGACY_PREFIX: i > 0 ? process.argv[i + 1] : process.env.CAREER_OPS_LEGACY_PREFIX });
  if (!prefix) { console.error("migrate-legacy-names: give the old prefix, e.g. --prefix sam- (letters/digits, ending in a dash)"); process.exit(2); }
  const dir = profileDir();
  const r = migrate(dir, { apply, prefix });
  for (const l of r.planned) console.log(`would rename ${l}`);
  for (const l of r.renamed) console.log(`renamed ${l}`);
  for (const l of r.skipped) console.log(`skipped ${l}`);
  console.log(`migrate-legacy-names (${dir}): ${apply ? `${r.renamed.length} renamed` : `${r.planned.length} to rename (dry run; --apply to do it)`}, ${r.skipped.length} skipped`);
}
