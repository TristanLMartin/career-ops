// Where an estimated total comp comes from, in words. One place so the job
// page, the Pipeline table and the rank badges say the same thing.
//
// tc_est.source is "levels.fyi (<metro or US>, <level>)" for Levels.fyi's own per-level data
// (lib/hunt-levels.mjs), or the research table's label (lib/hunt-comp.mjs). Older rows carry
// "levels.fyi-style estimate", which was the research table too.

const k = (n) => `$${Math.round(n / 1000)}k`;

export function isLevelsData(tc) {
  return /^levels\.fyi \(/.test(String(tc?.source ?? ""));
}

/** "levels.fyi, Greater Austin Area, Lead MTS" or "older research, IC3 (Senior SWE)". */
export function tcSourceLabel(tc) {
  if (!tc) return "";
  if (isLevelsData(tc)) return String(tc.source).replace(/^levels\.fyi \((.*)\)$/, "levels.fyi, $1");
  return `older research${tc.levelEquiv ? `, ${tc.levelEquiv}` : ""}`;
}

/** One-sentence explanation for a tooltip. */
export function tcExplain(tc) {
  if (!tc) return "";
  const range = tc.range ? `, typical range ${k(tc.range[0])}–${k(tc.range[1]).slice(1)}` : "";
  const priv = tc.privateEquity && tc.rankUsd ? ` Private stock: ranked at ~${k(tc.rankUsd)} with stock counted at 60%.` : "";
  if (isLevelsData(tc)) {
    const parts = tc.parts ? ` (${k(tc.parts.base)} base + ${k(tc.parts.stock)} stock + ${k(tc.parts.bonus)} bonus)` : "";
    const where = tc.where === "US" && tc.homeAdjusted ? "US-wide median, adjusted for your home metro" : `${tc.where ?? "US"} median`;
    return `Est. TC: Levels.fyi ${where} for ${tc.level}${parts}${range}.${priv}`;
  }
  const how = /spans levels/.test(tc.basis ?? "") ? "the posted band spans several levels, so not scaled by it" : tc.basis === "scaled by posting base" ? "scaled by this posting's base" : "no posting base to scale by";
  return `Est. TC: older research table, company senior median${tc.levelEquiv ? ` (${tc.levelEquiv})` : ""}, ${how}${tc.homeAdjusted ? ", adjusted for your home metro" : ""}${range}.${priv}`;
}
