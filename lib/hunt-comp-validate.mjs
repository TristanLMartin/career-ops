// Validator for config/comp.json, the curated per-company senior TC table.
// Errors: schema problems a ranking run would mis-read. Warnings: stale or unusual values.

const CONF = new Set(["high", "medium", "low"]);
// tc_median_usd / base_usd may both be null for a company with no usable data (tier and stability only).
const REQUIRED = ["company", "location_basis", "confidence", "company_tier", "as_of"];
const num = (v) => typeof v === "number" && Number.isFinite(v);

/** Returns { errors: string[], warnings: string[] } for the parsed file. */
export function validateComp(doc, { today = new Date(), staleMonths = 6 } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(doc)) return { errors: ["top level must be an array of company entries"], warnings };
  const seen = new Set();
  doc.forEach((e, i) => {
    const at = `#${i} ${e?.company ?? "(no company)"}`;
    if (!e || typeof e !== "object") { errors.push(`${at}: not an object`); return; }
    for (const k of REQUIRED) if (e[k] == null || e[k] === "") errors.push(`${at}: missing ${k}`);
    const key = String(e.company ?? "").trim().toLowerCase();
    if (key && seen.has(key)) errors.push(`${at}: duplicate company`);
    seen.add(key);
    if ((e.tc_median_usd == null) !== (e.base_usd == null)) warnings.push(`${at}: only one of tc_median_usd / base_usd is set, so no TC/base ratio`);
    for (const k of ["tc_median_usd", "base_usd", "stock_per_year_usd", "bonus_usd"]) if (e[k] != null && !num(e[k])) errors.push(`${at}: ${k} must be a number`);
    if (num(e.base_usd) && (e.base_usd < 80000 || e.base_usd > 600000)) errors.push(`${at}: base_usd ${e.base_usd} outside 80k-600k`);
    if (num(e.tc_median_usd) && (e.tc_median_usd < 80000 || e.tc_median_usd > 2000000)) errors.push(`${at}: tc_median_usd ${e.tc_median_usd} outside 80k-2M`);
    if (num(e.tc_median_usd) && num(e.base_usd) && e.base_usd > 0) {
      const r = e.tc_median_usd / e.base_usd;
      if (r < 1.0 || r > 4.0) errors.push(`${at}: TC/base ratio ${r.toFixed(2)} outside 1.0-4.0`);
    }
    if (e.tc_range_usd != null) {
      const r = e.tc_range_usd;
      if (!Array.isArray(r) || r.length !== 2 || !r.every(num) || r[0] > r[1]) errors.push(`${at}: tc_range_usd must be [low, high]`);
      else if (num(e.tc_median_usd) && (e.tc_median_usd < r[0] || e.tc_median_usd > r[1])) warnings.push(`${at}: tc_median_usd outside tc_range_usd`);
    }
    if (e.confidence != null && !CONF.has(e.confidence)) errors.push(`${at}: confidence must be high/medium/low`);
    if (e.company_tier != null && ![1, 2, 3, 4].includes(e.company_tier)) errors.push(`${at}: company_tier must be 1-4`);
    if (e.as_of != null) {
      const d = new Date(`${e.as_of}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.as_of)) || Number.isNaN(d.getTime())) errors.push(`${at}: as_of must be YYYY-MM-DD`);
      else {
        const cutoff = new Date(today);
        cutoff.setUTCMonth(cutoff.getUTCMonth() - staleMonths);
        if (d < cutoff) warnings.push(`${at}: as_of ${e.as_of} is older than ${staleMonths} months`);
      }
    }
  });
  return { errors, warnings };
}
