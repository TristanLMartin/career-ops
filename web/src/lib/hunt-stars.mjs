// hunt: starred companies. A star is only a filter on the Jobs list
// ("Starred only"); it never changes the ranking. Stored in data/hunt-stars.json as
// { "companies": ["Acme", ...] }, written by POST /api/profile/stars. Company names match
// the way the Jobs company filter matches them (lib/hunt-company-filter.mjs companyKey), so
// "Andurilindustries" and "Anduril Industries" are one company.
import { companyKey } from "./hunt-company-filter.mjs";

/** { companies: [...] } with blanks and same-company duplicates dropped (first spelling kept). */
export function normalizeStarsDoc(doc) {
  const list = Array.isArray(doc?.companies) ? doc.companies : [];
  const seen = new Set();
  const companies = [];
  for (const c of list) {
    if (typeof c !== "string" || !c.trim()) continue;
    const k = companyKey(c);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    companies.push(c.trim());
  }
  return { companies };
}

/** Star or unstar one company; null for a bad request. */
export function applyStarOp(doc, { company, starred } = {}) {
  if (typeof company !== "string" || !company.trim() || typeof starred !== "boolean") return null;
  const k = companyKey(company);
  if (!k) return null;
  const rest = doc.companies.filter((c) => companyKey(c) !== k);
  return { companies: starred ? [...rest, company.trim()] : rest };
}

/** Set of company keys for fast lookups. */
export function starKeys(companies) {
  return new Set((companies ?? []).map((c) => companyKey(c)).filter(Boolean));
}

export function isStarred(keys, company) {
  const k = companyKey(company);
  return Boolean(k) && keys.has(k);
}
