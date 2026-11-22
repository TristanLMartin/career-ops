// hunt-job-filters: the filters that decide which unevaluated jobs get an automatic or bulk
// evaluation (scripts/hunt-autoscore.mjs pickCandidates, bulk re-evaluation picks). Everything
// comes from the profile's config/ranking.yml `target` (see lib/hunt-rank.mjs normalizeTarget):
//
//   levels          level keys that pass (null = any)
//   stretch_levels  level keys that pass as a stretch when the evaluation report says the
//                   candidate meets the level, or, unevaluated, when the quick score is >= 4 at a
//                   boosted (target) company
//   location_tiers  tiers that pass; always_companies pass anywhere
//   relocate        optional: { tiers: [3], tc_min: 300000, base_top_min: 250000 } lets a tier
//                   through when the pay clears either bar
//   exclude_titles  title words that never pass
// Contract roles and roles below the base floor never pass.
import { normalizeTarget, wordsRe } from "../lib/hunt-rank.mjs";

/**
 * @param {Record<string, any>} e  one hunt-enrich.json job
 * @param {any} [target]           config/ranking.yml `target` (raw or normalized)
 * @returns {{ ok: boolean, reasons: string[], stretch: boolean }}
 */
export function filterJob(e, target = null) {
  const t = normalizeTarget(target);
  const raw = target && !target.tiers ? target : {};
  const stretchLevels = new Set([].concat(raw.stretch_levels ?? t.stretchLevels ?? []).map(String));
  const reasons = [];
  const title = String(e?.displayRole ?? e?.role ?? "");
  const company = String(e?.company ?? "").trim().toLowerCase();
  const level = e?.level?.key ?? null;
  let stretch = false;
  if (t.levels && level && !t.levels.includes(level)) {
    const meets = e?.report?.level?.meets === true;
    const boosted = !!(e?.rankBoost || e?.boost);
    if (stretchLevels.has(level) && (meets || (e?.report == null && Number(e?.quick_score) >= 4 && boosted))) stretch = true;
    else reasons.push(`level:${level}`);
  }
  if (t.exclude && t.exclude.test(title)) reasons.push("title");
  if (e?.contract) reasons.push("contract");
  const tier = e?.locationTier;
  if (!(t.tiers.includes(tier) || t.always.has(company))) {
    const rel = raw.relocate ?? null;
    const baseTop = Number(e?.pay?.annualMax ?? 0);
    const tc = Number(e?.tc_adj ?? e?.tc_est?.rankUsd ?? 0);
    const relocOk = rel && [].concat(rel.tiers ?? []).map(Number).includes(tier)
      && ((Number(rel.tc_min) > 0 && tc >= Number(rel.tc_min)) || (Number(rel.base_top_min) > 0 && baseTop >= Number(rel.base_top_min)));
    if (!relocOk) reasons.push(`location:tier${tier ?? "?"}`);
  }
  if (e?.belowFloor) reasons.push("below pay floor");
  return { ok: reasons.length === 0, reasons, stretch };
}

export { wordsRe };
