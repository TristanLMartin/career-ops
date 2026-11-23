// Which unjudged jobs Sonnet evaluates first:
// highest Haiku quick score (1-5) first, ties by the caller's own order (Best overall / composite);
// a quick score of 1 is never judged; a job with no quick score yet goes last.
// Used by the daily autoscore picker and scripts/hunt-eval-run.mjs.
export const SKIP_QUICK_AT_OR_BELOW = 1;

/** False for a quick score of 1 (not worth a Sonnet evaluation). */
export function worthJudging(e) {
  const q = e?.quick_score;
  return !(typeof q === "number" && q <= SKIP_QUICK_AT_OR_BELOW);
}

/** Comparator: quick score high to low (none = last), then `tieBreak`. */
export function quickFirst(tieBreak = () => 0, get = (x) => x) {
  const q = (x) => (typeof get(x)?.quick_score === "number" ? get(x).quick_score : -1);
  return (a, b) => q(b) - q(a) || tieBreak(a, b);
}
