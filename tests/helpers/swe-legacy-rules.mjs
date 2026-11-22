// The SWE ranking rules the hunt-* tests were written against (tests/fixtures/ranking-swe-legacy.yml).
// The library itself ships with neutral defaults; each profile's config/ranking.yml sets its rules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { configureRankRules, normalizeTarget } from "../../lib/hunt-rank.mjs";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ranking-swe-legacy.yml");
export const LEGACY = yaml.load(fs.readFileSync(FILE, "utf8"));
export const LEGACY_TARGET = normalizeTarget(LEGACY.target);
export const LEGACY_LEVEL = { bigCompanies: LEGACY.level.big_companies };
export function useLegacyRules() {
  return configureRankRules(LEGACY.profile_rules);
}
