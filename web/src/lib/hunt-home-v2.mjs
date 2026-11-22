/**
 * hunt: pure helpers for the condensed Home (Needs you · In flight · Today's study ·
 * New since you last looked · footer). No I/O; the page reads files and passes them in.
 */

const CLOSED = new Set(["Rejected", "Discarded", "SKIP", "Hired"]);
const PAST_EVALUATED = new Set(["Speculative", "Applied", "Responded", "Assessment", "Interview", "Offer"]);
const DAY = 24 * 3600e3;

/** Local YYYY-MM-DD for a time. */
export function localDay(t = Date.now()) {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** First date written in a next-step note ("call 2026-11-24", "Nov 24", "11/24"), as YYYY-MM-DD, or null. */
export function dateInText(text, now = Date.now()) {
  const s = String(text ?? "");
  const iso = s.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const year = new Date(now).getFullYear();
  const pad = (n) => String(n).padStart(2, "0");
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  if (named) return `${year}-${pad(MONTHS.indexOf(named[1].toLowerCase()) + 1)}-${pad(named[2])}`;
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (us && +us[1] >= 1 && +us[1] <= 12 && +us[2] >= 1 && +us[2] <= 31) return `${year}-${pad(us[1])}-${pad(us[2])}`;
  return null;
}

export function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}

/** Tracker rows past Evaluated (not closed), most recently updated first. */
export function inFlight(rows) {
  return (rows ?? []).filter((r) => PAST_EVALUATED.has(r.status)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/**
 * "Needs you": only items needing action, one line each.
 * @param {{ tracker?: any[], threads?: any[], followups?: any[], newTop?: any[], now?: number }} [input]
 * @returns {{id: string, label: string, detail: string, action: string, href: string, external?: boolean, sort: number}[]}
 */
export function needsYou({ tracker = [], threads = [], followups = [], newTop = [], now = Date.now() } = {}) {
  const today = localDay(now);
  const out = [];
  for (const r of inFlight(tracker)) {
    const due = dateInText(r.next, now);
    if (due && due <= today) {
      out.push({ id: `next:${r.n}`, label: `${r.company} · ${r.role}`, detail: `Next step ${due < today ? "overdue" : "due today"}: ${r.next}`, action: "Open", href: `/pipeline/${encodeURIComponent(r.n)}`, sort: 0 });
    } else if (r.status === "Interview" && !String(r.next ?? "").trim()) {
      out.push({ id: `nonext:${r.n}`, label: `${r.company} · ${r.role}`, detail: "Interview with no next step set", action: "Set next step", href: "/tracker", sort: 1 });
    }
  }
  for (const t of threads) {
    if (t.archived || t.kind === "other" || !t.owe) continue;
    out.push({ id: `msg:${t.id}`, label: t.about ? `${t.name} · ${t.about}` : t.name, detail: t.newReply ? "New reply" : "You owe a reply", action: "Reply", href: t.href, external: true, sort: 2 });
  }
  for (const f of followups) {
    if (f.archived || !f.due || f.due > today) continue;
    out.push({ id: `fu:${f.id}`, label: f.about ? `${f.name} · ${f.about}` : f.name, detail: `Follow-up ${f.due < today ? "overdue" : "due today"}`, action: "Follow up", href: "/followups", sort: 3 });
  }
  for (const j of newTop) {
    out.push({ id: `new:${j.url}`, label: `${j.company} · ${j.displayRole ?? j.role}`, detail: `New #${j.rank} by True rank, not reviewed`, action: "Review", href: j.report?.tracker ? `/pipeline/${j.report.tracker}` : j.url, external: !j.report?.tracker, sort: 4 });
  }
  return out.sort((a, b) => a.sort - b.sort);
}

/** True rank over every open inbox posting: head-to-head order first, then composite. */
export function trueRank(jobs) {
  return Object.entries(jobs ?? {})
    .map(([url, e]) => ({ url, ...e }))
    .filter((e) => typeof e.composite === "number" && e.groupLeader !== false && !CLOSED.has(String(e.status ?? "")) && !e.belowFloor)
    .filter((e) => !/^(skip|discard)/i.test(String(e.report?.decision ?? "")))
    .sort((a, b) => (a.h2h_rank ?? 1e9) - (b.h2h_rank ?? 1e9) || b.composite - a.composite)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/** Postings worth a look: top `top` by True rank, or a fit / quick score of 4+. */
export function worthALook(jobs, top = 100) {
  return trueRank(jobs).filter((e) => e.rank <= top || (e.fit ?? e.quick_score ?? 0) >= 4);
}

/**
 * "New since you last looked": postings worth a look whose stable first_seen_at (set once at
 * first ingest, data/first-seen.json) is after the last visit. Jobs with no first-seen time yet
 * are not new. Newest first, then by True rank.
 */
export function newSince(worth, firstSeen, lastVisit) {
  if (!lastVisit) return [];
  return (worth ?? [])
    .filter((e) => firstSeen?.[e.url] && firstSeen[e.url] > lastVisit)
    .sort((a, b) => a.rank - b.rank);
}

/**
 * The last time he looked at Home, from data/home-last-visit.json: {lastVisit: ISO}. The old
 * shape ({current: {at}, previous}) reads as its current.at. Missing = null (nothing is new).
 */
export function lastVisitFrom(doc) {
  if (typeof doc?.lastVisit === "string") return doc.lastVisit;
  if (typeof doc?.current?.at === "string") return doc.current.at;
  return null;
}

/** Sum of cost_usd in data/hunt-usage.tsv over the last 7 days. */
export function weekCost(tsv, now = Date.now()) {
  const lines = String(tsv ?? "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return 0;
  const head = lines[0].split("\t");
  const di = head.indexOf("date"), ci = head.indexOf("cost_usd");
  let sum = 0;
  for (const l of lines.slice(1)) {
    const c = l.split("\t");
    const t = Date.parse(c[di]);
    if (Number.isFinite(t) && now - t <= 7 * DAY) sum += Number(c[ci]) || 0;
  }
  return Math.round(sum * 100) / 100;
}

/** Latest timestamp in data/scan-runs.tsv, or null. */
export function lastScanAt(tsv) {
  const lines = String(tsv ?? "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return null;
  const ti = lines[0].split("\t").indexOf("timestamp");
  let best = null;
  for (const l of lines.slice(1)) {
    const v = l.split("\t")[ti];
    if (v && (!best || v > best)) best = v;
  }
  return best;
}

/**
 * Everything Home's "Needs you", "In flight" and "New since you last looked" cards show, from
 * already-read inputs. Home (components/hunt/home.tsx) and GET /api/profile/home both call
 * this, so the API cannot drift from the page.
 * @param {{ tracker?: any[], threads?: any[], followups?: any[], jobs?: Record<string, any>, firstSeen?: Record<string, string>, lastVisit?: string | null, now?: number }} [input]
 */
export function homeSections({ tracker = [], threads = [], followups = [], jobs = {}, firstSeen = {}, lastVisit = null, now = Date.now() } = {}) {
  const flying = inFlight(tracker);
  const worth = worthALook(jobs, 100).filter((e) => e.source !== "tracker");
  const fresh = newSince(worth, firstSeen, lastVisit);
  const newTop = fresh.filter((e) => e.rank <= 20 && !e.report?.tracker);
  const needs = needsYou({ tracker, threads, followups, newTop, now });
  return { needs, flying, fresh, newTop };
}

/**
 * GET /api/profile/home body from homeSections(): { needs, inFlight, opportunities }.
 * @param {{ needs?: any[], flying?: any[], fresh?: any[] }} [sections]
 */
export function homeApiBody({ needs = [], flying = [], fresh = [] } = {}) {
  return {
    needs: needs.map(({ sort, ...n }) => n),
    inFlight: flying.map((r) => ({ n: r.n, company: r.company, role: r.role, status: r.status, updated: r.updated, next: r.next ?? "" })),
    opportunities: fresh.map((e) => ({ url: e.url, company: e.company, role: e.displayRole ?? e.role, rank: e.rank, fit: e.fit ?? e.quick_score ?? null, composite: e.composite ?? null, tracker: e.report?.tracker ?? null })),
  };
}
