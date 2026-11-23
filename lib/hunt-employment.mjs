// Employment type from a posting's title and text : flags roles that are not
// full-time employment (contract, contract-to-hire, part-time, temporary, freelance, internship).
// A profile with `exclude_contract: true` in config/ranking.yml drops them from the
// ranking, the Jobs list and every Sonnet pick (scripts/hunt-enrich.mjs stamps `excluded`).
//
// Conservative on purpose: the title, or an explicit employment-type phrase in the text, must say
// so. "Smart contracts", a "Contracts" team, or "contractors" mentioned in passing don't count,
// and an explicit full-time employment type wins over a loose mention.

const TITLE_TYPES = [
  ["contract", /\bcontract[- ]to[- ]hire\b|\bc2h\b|\bc2c\b|\bcorp[- ]to[- ]corp\b|\b1099\b|\bcontractor\b|(?<!smart[- ])\bcontract\b(?!s)/i],
  ["part-time", /\bpart[- ]time\b/i],
  ["temporary", /\btemp(orary)?\b|\bfixed[- ]term\b|\b\d+\s*[-–]?\s*(\d+\s*)?months?\b/i],
  ["freelance", /\bfreelance(r)?\b/i],
  ["internship", /\bintern(ship)?\b|\bco-?op\b/i],
];

const TEXT_TYPES = [
  ["contract", /\b(employment|job|position|work|engagement|role)[ -]?type\s*[:\-–]\s*(contract|contractor|contract[- ]to[- ]hire)\b/i],
  ["contract", /\bthis (is|will be) an? (\d+[- ]?(month|mo|week)s?[- ])?(w-?2 |1099 |c2c )?(contract|contract[- ]to[- ]hire|contractor)\b/i],
  ["contract", /\bcontract[- ]to[- ]hire\b|\b(w-?2|1099|c2c|corp[- ]to[- ]corp)\s+(only|contract|position|role|basis)\b/i],
  ["contract", /\b\d+\s*[-–]?\s*(\d+\s*)?(month|mo)s?\s+contract\b|\bcontract (length|duration|term)\s*[:\-–]/i],
  ["part-time", /\b(employment|job|position|work)[ -]?type\s*[:\-–]\s*part[- ]time\b|\bthis is a part[- ]time\b/i],
  ["temporary", /\b(employment|job|position|work)[ -]?type\s*[:\-–]\s*(temporary|temp|fixed[- ]term)\b|\bthis is a (temporary|fixed[- ]term)\b/i],
  ["freelance", /\b(employment|job|position|work)[ -]?type\s*[:\-–]\s*freelance\b|\bthis is a freelance\b/i],
  ["internship", /\b(employment|job|position|work)[ -]?type\s*[:\-–]\s*intern(ship)?\b/i],
];

const FULL_TIME_TITLE = /\bfull[- ]time\b/i;
const FULL_TIME_TEXT = /\b(employment|job|position|work)[ -]?type\s*[:\-–]\s*(full[- ]time|permanent|regular)\b/i;

/** { type, why } for a non-full-time role, else null (full-time or not stated). */
export function employmentType(title = "", text = "") {
  const t = String(title ?? "");
  const d = String(text ?? "").slice(0, 20000);
  if (!FULL_TIME_TITLE.test(t)) {
    for (const [type, re] of TITLE_TYPES) {
      const m = re.exec(t);
      if (m) return { type, why: `title says "${m[0]}"` };
    }
  }
  if (FULL_TIME_TEXT.test(d) || FULL_TIME_TITLE.test(t)) return null;
  for (const [type, re] of TEXT_TYPES) {
    const m = re.exec(d);
    if (m) return { type, why: `posting says "${m[0].trim()}"` };
  }
  return null;
}
