// hunt: "Who do I know here?" — LinkedIn people-search links for a company, filtered to
// 1st-degree (and 2nd-degree) connections. Links only: you click yourself. No
// scraping, no LinkedIn automation, no fetching.
//
// Future: data/linkedin-connections.csv (gitignored, private) may hold the "Connections"
// export from LinkedIn's data archive. Matching on it is deliberately NOT built: since
// Dec 2026 that export no longer includes connections' companies or titles, so it can't
// answer "who works here?". Only the search links below can.

const SEARCH = "https://www.linkedin.com/search/results/people/";

// Legal-entity suffixes that never appear in how people write their employer on a profile.
// Words like "Technologies" or "Labs" are kept: they are often part of the name people use.
const LEGAL_SUFFIX = /(?:[\s,]+(?:inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|pbc|gmbh|ag|s\.?a|b\.?v|pty)\.?)+$/i;

/** Company name as people put it on their profile: no "(…)" notes, no ", Inc." etc. */
export function cleanCompanyName(name) {
  let s = String(name ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const stripped = s.replace(LEGAL_SUFFIX, "").replace(/[\s,]+$/, "").trim();
  if (stripped) s = stripped; // never strip a name down to nothing ("Company", "Co")
  return s;
}

function searchUrl(company, network) {
  const q = new URLSearchParams({ keywords: company, network: JSON.stringify([network]), origin: "FACETED_SEARCH" });
  // URLSearchParams writes spaces as "+"; LinkedIn's own links use %20.
  return `${SEARCH}?${q.toString().replace(/\+/g, "%20")}`;
}

/**
 * Referral search links for a company, or null when there is no usable name.
 * @returns {{ company: string, first: { label: string, url: string }, second: { label: string, url: string } } | null}
 */
export function referralLinks(companyName) {
  const company = cleanCompanyName(companyName);
  if (!company) return null;
  return {
    company,
    first: { label: `1st-degree at ${company}`, url: searchUrl(company, "F") },
    second: { label: "Friends of friends", url: searchUrl(company, "S") },
  };
}
