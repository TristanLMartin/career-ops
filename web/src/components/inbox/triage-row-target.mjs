// hunt: where a click on a Jobs row (outside its buttons) goes, as a plain module so it is
// testable: the report when there is one, else the job's detail page (/pipeline/posting?url=…:
// quick score, its reason, pay, Run full evaluation).
import { postingUrl } from "../../lib/posting-url.mjs";

/**
 * @param {string | null} scoreHref the row's report link, if any
 * @param {string} url the posting URL
 * @returns {string | null}
 */
export function rowTarget(scoreHref, url) {
  if (scoreHref && scoreHref.startsWith("/pipeline/")) return scoreHref;
  const u = postingUrl(url);
  return u ? `/pipeline/posting?url=${encodeURIComponent(u)}` : null;
}
