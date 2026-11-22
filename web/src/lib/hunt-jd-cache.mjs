// hunt: a JD that scripts/hunt-jd-fetch.mjs already read from a public
// careers API (Amazon, Google, Apple, Microsoft, Netflix, Oracle HCM, Atlassian, Built In) and
// cached by URL. Used by the evaluate run when fetch-jd.mjs misses, so a JS-rendered big-tech
// page is not scored as "JD unavailable". The text is untrusted posting data, like any JD.
import fs from "node:fs";
import path from "node:path";

export const MIN_CACHED_JD_CHARS = 400;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/** @returns {string|null} */
export function cachedJd(root, url, now = Date.now()) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  const key = url.trim();
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, "data", "cache", "hunt-jd", "sites.json"), "utf8"));
    const hit = doc?.postings?.[key];
    if (hit && typeof hit.text === "string" && hit.text.length >= MIN_CACHED_JD_CHARS && now - Number(hit.fetchedAt) < MAX_AGE_MS) return hit.text;
  } catch { /* no cache */ }
  return null;
}
