// How a failed batch evaluation is handled (scripts/hunt-reeval.mjs).
//   "limit"  - the Claude usage/rate limit: pause the batch and retry later.
//   "silent" - $0, no tokens, no wording: usually the limit; retried a couple of times.
//   false    - a real outcome for this job (recorded, not retried).
// A "gated: ..." result is the evaluator's own verdict after it ran (and was charged), even when
// it quotes a site's "HTTP 429 (rate limited)" (some job boards do this after a few hundred reads), so
// it is never a usage limit.
export const LIMIT_RE = /usage limit|hit your (?:\w+ )?limit|limit (?:reached|exceeded)|rate.?limit|quota|\b429\b|overloaded|too many requests|resets? (?:at )?\d/i;

export function retryKind(last) {
  if (last?.type === "done") return false;
  const msg = String(last?.msg ?? "");
  if (/^\s*(error:\s*)?gated:/i.test(msg)) return false;
  if (LIMIT_RE.test(msg)) return "limit";
  return !(Number(last?.costUsd) > 0) && !(Number(last?.tokens) > 0) ? "silent" : false;
}
