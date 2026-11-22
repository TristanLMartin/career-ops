/**
 * hunt: the Tracker page's pure helpers — every tracker row past Evaluated.
 * Source of truth stays data/applications.md (+ data/status-log.tsv for dates); writes go through
 * /api/status → set-status.mjs. "Next step" is a "Next: …" note in the row's Notes cell.
 */

/** Statuses that are not "in flight": before applying, or dropped by the candidate. */
const NOT_IN_FLIGHT = new Set(["evaluated", "discarded", "skip", ""]);

export const TRACKER_STATUSES = Object.freeze(["Speculative", "Applied", "Responded", "Assessment", "Interview", "Offer", "Hired", "Rejected"]);

export function isInFlight(status) {
  return !NOT_IN_FLIGHT.has(String(status ?? "").trim().toLowerCase());
}

/** data/status-log.tsv → [{n, date, from, to, source, note}]; a header or junk line is skipped. */
export function parseStatusLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const c = line.split("\t");
    if (c.length < 4 || !/^\d+$/.test(c[0].trim()) || !/^\d{4}-\d{2}-\d{2}/.test(c[1])) continue;
    out.push({ n: c[0].trim(), date: c[1].slice(0, 10), from: c[2], to: c[3], source: c[4] ?? "", note: c[5] ?? "" });
  }
  return out;
}

const DATE = /\b(20\d{2}-\d{2}-\d{2})\b/g;

/** The Notes cell split at "; " the way set-status.mjs splits it. */
export function noteParts(notes) {
  return String(notes ?? "").split(/;\s+/).map((s) => s.trim()).filter(Boolean);
}

/** The latest "Next: …" note, or "" — and the exact note text, for --replace-note. */
export function nextStep(notes) {
  const parts = noteParts(notes).filter((p) => /^next:\s*/i.test(p));
  const raw = parts.length ? parts[parts.length - 1] : "";
  return { text: raw.replace(/^next:\s*/i, ""), raw };
}

/**
 * Applied date: the ledger's move into Applied, else "applied YYYY-MM-DD" in the notes,
 * else the tracker Date column (marked approximate).
 */
export function appliedDate(app, log) {
  const moved = log.filter((l) => l.n === String(app.n) && /^applied$/i.test(l.to)).map((l) => l.date).sort()[0];
  if (moved) return { date: moved, approx: false };
  const m = String(app.notes ?? "").match(/\bapplied(?:\s+on)?\s+(20\d{2}-\d{2}-\d{2})/i);
  if (m) return { date: m[1], approx: false };
  return app.date ? { date: app.date, approx: true } : { date: "", approx: true };
}

/** Local YYYY-MM-DD for a time. */
function localDay(t) {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
}

/**
 * Last update: the newest of the ledger, past dates written in the notes, and the Date column,
 * never later than today. A date in the notes can be a future event ("call Tue 2026-11-24"), not
 * a change, so note dates after today are ignored; with nothing else it is the Date column.
 */
export function lastUpdate(app, log, now = Date.now()) {
  const today = localDay(now);
  const noteDates = (String(app.notes ?? "").match(DATE) ?? []).filter((d) => d <= today);
  const dates = [...log.filter((l) => l.n === String(app.n)).map((l) => l.date), ...noteDates].filter((d) => d && d <= today);
  const best = dates.sort().at(-1) ?? "";
  const raw = String(app.date ?? "").slice(0, 10);
  const own = raw && raw > today ? today : raw;
  return own > best ? own : best;
}

/** A markdown link cell "[label](url)" or a bare URL → the URL, else "". */
export function cellUrl(cell) {
  const s = String(cell ?? "").trim();
  const m = s.match(/\]\((https?:[^)\s]+)\)/);
  if (m) return m[1];
  return /^https?:\/\//.test(s) ? s.split(/\s/)[0] : "";
}

/**
 * Tracker rows → table rows.
 * @param {Array<{n:string,date:string,company:string,role:string,status:string,notes:string,url:string,location?:string,score?:string}>} apps
 * @param {ReturnType<typeof parseStatusLog>} log
 * @param {Record<string, any>} enrich  url -> data/hunt-enrich.json job
 */
export function trackerRows(apps, log, enrich = {}, now = Date.now()) {
  const byTracker = new Map();
  for (const [url, e] of Object.entries(enrich ?? {})) if (e?.report?.tracker) byTracker.set(String(e.report.tracker), { url, e });
  return apps.filter((a) => isInFlight(a.status)).map((a) => {
    const url = cellUrl(a.url);
    const hit = (url && enrich[url] ? { url, e: enrich[url] } : null) ?? byTracker.get(String(a.n)) ?? null;
    const e = hit?.e ?? null;
    const pay = e?.pay && e.pay.currency === "USD" ? [e.pay.annualMin, e.pay.annualMax] : null;
    const applied = appliedDate(a, log);
    const next = nextStep(a.notes);
    const location = a.location || e?.location || (String(a.notes ?? "").match(/Location:\s*([^;]+)/)?.[1] ?? "").trim();
    return {
      n: String(a.n),
      company: a.company,
      role: a.role,
      status: a.status.trim(),
      applied: applied.date,
      appliedApprox: applied.approx,
      updated: lastUpdate(a, log, now),
      next: next.text,
      nextRaw: next.raw,
      base: pay,
      tc: e?.tc_est?.usd ?? null,
      location,
      url: url || hit?.url || "",
      score: a.score ?? "",
      notes: a.notes ?? "",
    };
  });
}

const STATUS_ORDER = ["Offer", "Hired", "Interview", "Assessment", "Responded", "Applied", "Speculative", "Rejected"];

/** Sort by a column; text columns compare case-insensitively, empties always last. */
export function sortRows(rows, key, dir = "asc") {
  const sign = dir === "desc" ? -1 : 1;
  const val = (r) => {
    if (key === "status") { const i = STATUS_ORDER.indexOf(r.status); return i < 0 ? 99 : i; }
    if (key === "pay") return r.tc ?? (r.base ? (r.base[0] + r.base[1]) / 2 : null);
    if (key === "n") return Number(r.n);
    const v = r[key];
    return v == null || v === "" ? null : typeof v === "string" ? v.toLowerCase() : v;
  };
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

const k = (n) => `$${Math.round(n / 1000)}k`;
export function payLabel(r) {
  const base = r.base ? (r.base[0] === r.base[1] ? k(r.base[0]) : `${k(r.base[0])}–${k(r.base[1])}`) : "";
  const tc = r.tc ? `TC ~${k(r.tc)}` : "";
  return [base, tc].filter(Boolean).join(" · ");
}

function csvCell(v) {
  const s = String(v ?? "");
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function trackerCsvText(rows) {
  const head = ["#", "Company", "Role", "Status", "Applied", "Last update", "Next step", "Base/TC", "Location", "Link"];
  const lines = [head, ...rows.map((r) => [r.n, r.company, r.role, r.status, r.applied, r.updated, r.next, payLabel(r), r.location, r.url])];
  return lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
