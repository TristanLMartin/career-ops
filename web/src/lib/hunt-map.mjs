/**
 * The Jobs "Map" view's pure helpers (fit × pay scatter).
 * No React, no fs: the page reads data/hunt-enrich.json and hands the jobs here.
 */

export const LOCATION_GROUPS = Object.freeze(["Home area", "Remote", "Secondary area", "Other"]);
export const ROLE_FAMILIES = Object.freeze(["Backend/Infra", "Full-stack", "FDE/Applied AI", "Payments/Fintech", "Other"]);
/** No floor is assumed; the page passes the profile's base_floor (hunt-enrich.json display.baseFloor). */
export const BASE_FLOOR = null;

const REMOTE = /\bremote\b/i;
const NON_US_REMOTE = /\b(canada|emea|europe|uk|united kingdom|germany|india|latam|apac|global|worldwide|anywhere)\b/i;

/**
 * Role families for the Map from the profile (hunt-enrich.json display.roleFamilies:
 * [{ name, words }], from config/ranking.yml map_families or person.yml target_roles).
 * Word entries match case-insensitively on word boundaries; "re:<regex>" is a raw pattern.
 * Returns [{ name, re }] (at most 4) or null, which means the built-in software families.
 */
export function familiesFrom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const esc = (w) => { const t = String(w).trim(); return t.startsWith("re:") ? `(?:${t.slice(3)})` : t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[- ]?"); };
  const out = [];
  for (const f of list) {
    const words = [].concat(f?.words ?? []).map(String).filter((w) => w.trim());
    if (!f?.name || !words.length || String(f.name) === "Other") continue;
    try { out.push({ name: String(f.name), re: new RegExp(`\\b(${words.map(esc).join("|")})\\b`, "i") }); } catch { /* bad pattern: skip */ }
    if (out.length === 4) break;
  }
  return out.length ? out : null;
}

/**
 * Location group from the enrichment's location tier (the profile's own home / secondary
 * metros, config/ranking.yml profile_rules.location), with the text as a fallback for remote.
 * @param {string | null | undefined} location
 * @param {number | null | undefined} [tier] 1 home · 2 remote US · 3 secondary · 4 other · 5 remote (global)
 */
export function locationGroup(location, tier) {
  const s = String(location ?? "");
  if (tier === 1) return "Home area";
  if (tier === 3) return "Secondary area";
  if (tier === 2) return "Remote";
  if (tier == null && /\banywhere\b[^a-z]*(in\s+the\s+)?(us|usa|united states)\b/i.test(s)) return "Remote";
  if (tier == null && REMOTE.test(s) && !NON_US_REMOTE.test(s.replace(/\b(us|usa|united states)\b.*$/i, ""))) return "Remote";
  return "Other";
}

const FDE = /forward[\s-]*deployed|\bfde\b|applied\s+(ai|ml)|\bsolutions?\s+(engineer|architect)|deployment\s+(lead|engineer|strategist)|\b(customer|field)\s+engineer|\bai\s+(engineer|agents?)\b|\bagent(s|ic)?\s+engineer/i;
const PAY = /payment|billing|fintech|ledger|treasury|banking|\blending|\bcredit\b|\bcards?\b|trading|financ|checkout|installment|money|\brisk\b|fraud|crypto|stablecoin/i;
const FULLSTACK = /full[\s-]*stack|front[\s-]*end|\bproduct\s+engineer|\bweb\s+engineer|\bui\s+engineer/i;
const BACKEND = /back[\s-]*end|infra|platform|distributed|\bsystems?\b|storage|\bstore\b|database|postgres|\bsre\b|reliability|devops|\bcloud\b|\bapi\b|data\s+engineer|kernel|compute|network|observability|search|runtime|developer\s+(experience|productivity)|\bdx\b|\bml\s+engineer|machine\s+learning/i;

/**
 * Role family from the title, then the enrichment's domain keywords when the title alone is generic.
 * Order matters: an "Applied AI, Payments" role is FDE/Applied AI; "Backend, Payments" is Payments.
 * @param {string | null | undefined} title
 * @param {string[] | null | undefined} [domains]
 */
export function roleFamily(title, domains, families = null) {
  const t = String(title ?? "");
  if (Array.isArray(families) && families.length) {
    const hit = families.find((f) => f.re.test(t));
    return hit ? hit.name : "Other";
  }
  if (FDE.test(t)) return "FDE/Applied AI";
  if (PAY.test(t)) return "Payments/Fintech";
  if (FULLSTACK.test(t)) return "Full-stack";
  if (BACKEND.test(t)) return "Backend/Infra";
  const d = Array.isArray(domains) ? domains : [];
  if (d[0] === "payments") return "Payments/Fintech";
  if (d.includes("fullstack") && !d.includes("platform")) return "Full-stack";
  if (d.includes("platform") || d.includes("observability")) return "Backend/Infra";
  return "Other";
}

/** FNV-1a → [0, 1). Same key, same jitter, on every render and machine. */
export function unitHash(key) {
  let h = 0x811c9dc5;
  const s = String(key);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h / 2 ** 32;
}

/** Fit (1–5): the full evaluation where there is one, else the quick score. */
export function fitOf(e) {
  if (typeof e?.fit === "number") return { value: e.fit, from: e.fitVia === "group" ? "group" : "full" };
  if (typeof e?.quick_score === "number") return { value: e.quick_score, from: "quick" };
  return null;
}

/** Pay (USD/yr): the TC estimate where there is one (estimated: hollow), else the posted base midpoint. */
export function payOf(e) {
  if (e?.tc_est && typeof e.tc_est.usd === "number" && e.tc_est.usd > 0) return { value: e.tc_est.usd, estimated: true };
  const p = e?.pay;
  if (p && p.currency === "USD" && p.annualMin > 0) return { value: Math.round((p.annualMin + (p.annualMax || p.annualMin)) / 2), estimated: false };
  return null;
}

/**
 * Chart points. `opts.scope` "default" keeps the Shortlist plus the head-to-head top 100;
 * "all" keeps one job per duplicate group (the leader). Below-floor jobs only with `opts.belowFloor`.
 * @param {Record<string, any>} jobs  url -> enrichment
 * @param {{ trueRank?: (url: string) => number | null, families?: { name: string, re: RegExp }[] | null }} [opts]
 * @returns {{ points: object[], noPay: number }}
 */
export function mapPoints(jobs, opts = {}) {
  const points = [];
  let noPay = 0;
  for (const [url, e] of Object.entries(jobs ?? {})) {
    if (!e) continue;
    const fit = fitOf(e);
    if (!fit) continue;
    const pay = payOf(e);
    const inDefault = !!e.shortlist || (e.h2h_rank != null && e.h2hVia !== "group" && e.h2h_rank <= 100);
    const inAll = e.groupLeader !== false;
    if (!inDefault && !inAll) continue;
    if (!pay) { noPay++; continue; }
    const j = unitHash(url);
    points.push({
      url,
      x: Math.min(5.2, Math.max(0.8, fit.value + (j - 0.5) * 0.28)),
      y: pay.value,
      fit: fit.value,
      fitFrom: fit.from,
      estimated: pay.estimated,
      loc: locationGroup(e.location, e.locationTier),
      family: roleFamily(e.displayRole || e.role, e.domains, opts.families),
      company: e.company ?? "",
      title: e.displayRole || e.role || "",
      location: e.location ?? "",
      base: e.pay && e.pay.currency === "USD" ? [e.pay.annualMin, e.pay.annualMax] : null,
      // posted hourly rate ($/hr), kept so the chart can say "hourly" next to the annualized figure
      hourly: e.pay && e.pay.currency === "USD" && e.pay.period === "hour" ? [e.pay.min, e.pay.max] : null,
      basis: e.pay?.basis ?? null,
      tc: e.tc_est?.usd ?? null,
      tcConfidence: e.tc_est?.confidence ?? null,
      rank: opts.trueRank ? opts.trueRank(url) : null,
      why: e.quick_why || e.report?.why || e.h2hWhy || "",
      status: e.status || "New",
      tracker: e.report?.tracker ?? null,
      belowFloor: !!e.belowFloor,
      inDefault,
    });
  }
  return { points, noPay };
}

/** Points the current toggles show. */
export function visiblePoints(points, { all = false, belowFloor = false, hiddenLoc = [], hiddenFamily = [] } = {}) {
  const hl = new Set(hiddenLoc), hf = new Set(hiddenFamily);
  return points.filter((p) => (all || p.inDefault) && (belowFloor || !p.belowFloor) && !hl.has(p.loc) && !hf.has(p.family));
}

/** Round pay-axis ticks every $50k (or $100k when the range is wide), covering [min, max]. */
export function payTicks(min, max) {
  const step = max - min > 450_000 ? 100_000 : 50_000;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

/**
 * Value at quantile q (0-1) of an ascending array, nearest rank rounded toward the middle, so a
 * lone outlier at either end is never interpolated into the domain.
 */
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  return sorted[q > 0.5 ? Math.floor(i) : Math.ceil(i)];
}

/**
 * A robust axis domain: about the 2nd-98th percentile of the values, padded by `pad` of the
 * span (at least `minPad`), widened to include `include` (e.g. the pay floor), and clamped to
 * [hardMin, hardMax]. Values outside it are drawn at the edge with an off-scale marker, so one
 * bad parse ($832k "hourly") can't squash every other point.
 * @param {number[]} values
 * @param {{ lo?: number, hi?: number, pad?: number, minPad?: number, include?: (number|null|undefined)[], hardMin?: number, hardMax?: number, fallback?: [number, number] }} [opts]
 * @returns {[number, number]}
 */
export function robustDomain(values, { lo = 0.02, hi = 0.98, pad = 0.08, minPad = 0, include = [], hardMin = -Infinity, hardMax = Infinity, fallback = [0, 1] } = {}) {
  const v = (values ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const extra = (include ?? []).filter((x) => Number.isFinite(x));
  if (!v.length && !extra.length) return fallback;
  // Small samples: percentiles of a handful of points are just the extremes.
  let a = v.length >= 10 ? quantile(v, lo) : (v[0] ?? extra[0]);
  let b = v.length >= 10 ? quantile(v, hi) : (v[v.length - 1] ?? extra[0]);
  for (const x of extra) { a = Math.min(a, x); b = Math.max(b, x); }
  const p = Math.max((b - a) * pad, minPad);
  return [Math.max(hardMin, a - p), Math.min(hardMax, b + p)];
}

/** "low" / "high" when a value is outside the domain (drawn pinned to that edge), else null. */
export function offScale(v, [a, b]) {
  return v < a ? "low" : v > b ? "high" : null;
}
