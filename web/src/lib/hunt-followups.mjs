/**
 * hunt: Follow-ups as one row per opportunity (pure; testable).
 *
 * An opportunity is a tracker row (or an agency recruiter's group of rows) plus every thread and
 * person that belongs to it. Threads attach to a tracker row when:
 *   - the person's name appears in that row's notes ("Jordan Lee (Example Recruiting)"), or
 *   - the sender's domain or a known contact's company names the row's company (microsoft.com), or
 *   - the thread's company is the row's company.
 * The same person seen twice ("samrivera" and "Sam Rivera · LinkedIn") is one person.
 * One person linked to several rows (an agency recruiter) makes one row: "Example Staffing: Acme Health, Globex Foods".
 * Threads that attach to nothing stay their own row; kind "other" ones are hidden behind
 * "Show others".
 */

const DAY = 24 * 3600e3;
export const normName = (s) => String(s ?? "").toLowerCase().replace(/\s+via\s+linkedin$/, "").replace(/@.*$/, "").replace(/[^a-z]/g, "");
export const normCo = (s) => String(s ?? "").toLowerCase().replace(/\s*\(.*\)\s*/g, "").replace(/\b(inc|llc|ltd|corp|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "");
const first = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";

export function localDay(t) {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
}

/** "samrivera@examplestaffing.com" -> "examplestaffing"; "x@email.careers.microsoft.com" -> "microsoft". */
export function domainWord(email) {
  const host = String(email ?? "").split("@")[1] ?? "";
  const parts = host.split(".").filter((p) => !["com", "io", "co", "net", "org", "ai", "email", "careers", "mail", "us", "uk"].includes(p));
  return parts[parts.length - 1] ?? "";
}

/** "Waiting on James" from a thread person; names that are only an address read as their local part. */
function personName(t, contacts) {
  return contacts[String(t.from ?? "").toLowerCase()]?.name ?? t.name;
}

/** The scheduled call in a tracker row's notes: { label: "Mon 11/23 10:30 AM", day: "2026-11-23" } or null. */
export function scheduledCall(row, now = Date.now()) {
  const notes = `${row?.notes ?? ""} ${row?.next ?? ""}`;
  if (!/\b(call|screen|interview|meet)\b/i.test(row?.next ?? "") && !/\b(call|screen) scheduled\b/i.test(notes)) return null;
  const iso = notes.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(20\d\d)-(\d\d)-(\d\d)\b/);
  const md = notes.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+(\d{1,2})\/(\d{1,2})\b/);
  let wd, y, m, d;
  if (iso) [wd, y, m, d] = [iso[1], iso[2], iso[3], iso[4]];
  else if (md) [wd, y, m, d] = [md[1], String(new Date(now).getFullYear()), md[2].padStart(2, "0"), md[3].padStart(2, "0")];
  else return null;
  const time = notes.match(/\b(\d{1,2}:\d{2})(?:\s*[-–]\s*\d{1,2}:\d{2})?\s*(AM|PM)\b/i) ?? notes.match(/\b(\d{1,2}:\d{2})\b/);
  const label = `${wd} ${Number(m)}/${Number(d)}${time ? ` ${time[1]}${time[2] ? ` ${time[2].toUpperCase()}` : ""}` : ""}`;
  return { label, day: `${y}-${m}-${d}` };
}

/**
 * @param {{ entries: any[], tracker: any[], threads: any[], contacts?: Record<string, {name: string, role: string, company: string}>, now?: number, waitDays?: number }} input
 *   entries: followup-cadence entries; tracker: trackerRows(); threads: threadRows() (with `from`).
 */
export function buildOpportunities({ entries = [], tracker = [], threads = [], contacts = {}, now = Date.now(), waitDays = 5 } = {}) {
  const today = localDay(now);
  const rowsByN = new Map(tracker.map((r) => [String(r.n), r]));
  const cadence = new Map(entries.map((e) => [String(e.num), e]));
  const inFlight = tracker.filter((r) => ["Applied", "Responded", "Assessment", "Interview", "Offer", "Speculative"].includes(r.status));
  // candidate rows: everything in flight plus anything the cadence calculator names
  const candidates = new Map(inFlight.map((r) => [String(r.n), r]));
  for (const n of cadence.keys()) if (rowsByN.has(n)) candidates.set(n, rowsByN.get(n));

  // 1. people: merge threads of the same person (normalized name / address local part)
  const people = new Map();
  for (const t of threads) {
    if (t.archived) continue;
    const c = contacts[String(t.from ?? "").toLowerCase()];
    const key = normName(c?.name ?? t.name) || normName(t.from);
    if (!key) continue;
    if (!people.has(key)) people.set(key, { key, name: c?.name ?? t.name, role: c?.role ?? (t.kind === "recruiter" ? "Recruiter" : ""), company: c?.company ?? null, threads: [] });
    const p = people.get(key);
    p.threads.push(t);
    // prefer a real "First Last" over an address local part
    if (/\s/.test(t.name ?? "") && !/\s/.test(p.name ?? "")) p.name = t.name;
    if (!p.company && t.company) p.company = t.company;
  }

  // 1b. a person known only by an address ("jordan") whose thread names someone in full
  //     ("Invitation: Alex Doe and Jordan Lee") is that person
  for (const [k, p] of [...people]) {
    if (/\s/.test(p.name ?? "")) continue;
    const text = normName(p.threads.map((t) => t.snippet).join(" "));
    const owner = [...people.values()].find((q) => q !== p && /\s/.test(q.name ?? "") && normName(q.name).length >= 6 && text.includes(normName(q.name)));
    if (owner) { owner.threads.push(...p.threads); people.delete(k); }
  }

  // 2. attach each person to tracker rows
  const attach = (p) => {
    const hits = new Set();
    const pn = normName(p.name);
    for (const r of candidates.values()) {
      const notes = normName(`${r.notes ?? ""}`) ;
      if (pn.length >= 6 && notes.includes(pn)) hits.add(String(r.n));
    }
    if (!hits.size) {
      const cos = new Set([normCo(p.company), ...p.threads.map((t) => normCo(t.company)), ...p.threads.map((t) => domainWord(t.from))].filter((x) => x && x.length >= 3));
      for (const r of candidates.values()) if (cos.has(normCo(r.company))) hits.add(String(r.n));
    }
    return [...hits];
  };

  const opps = new Map(); // key -> opportunity
  const ensure = (key, init) => { if (!opps.has(key)) opps.set(key, { key, rows: [], people: [], threads: [], ...init }); return opps.get(key); };
  for (const [n, r] of candidates) ensure(`t${n}`, { title: r.company, company: r.company }).rows.push(r);

  const loose = [];
  for (const p of people.values()) {
    const hits = attach(p);
    if (hits.length === 1) {
      const o = opps.get(`t${hits[0]}`);
      o.people.push(p); o.threads.push(...p.threads);
    } else if (hits.length > 1) {
      // an agency recruiter covering several roles: one row under the person
      const agency = (rowsByN.get(hits[0])?.notes ?? "").match(new RegExp(`${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(([^)]+)\\)`, "i"))?.[1] ?? p.name;
      const companies = hits.map((n) => rowsByN.get(n).company);
      const o = ensure(`p${p.key}`, { title: `${agency}: ${companies.join(", ")}`, company: companies.join(", ") });
      o.people.push(p); o.threads.push(...p.threads);
      for (const n of hits) { o.rows.push(...opps.get(`t${n}`).rows); opps.delete(`t${n}`); }
    } else {
      loose.push(p);
    }
  }
  for (const p of loose) {
    const o = ensure(`p${p.key}`, { title: p.company || p.name, company: p.company || "" });
    o.people.push(p); o.threads.push(...p.threads);
  }

  // 3. next step, when, state
  const out = [];
  for (const o of opps.values()) {
    o.threads.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const last = o.threads[0] ?? null;
    // A row with a next step set has its next action decided; older owed threads don't override it.
    const owe = o.rows.some((r) => r.next) ? null : o.threads.find((t) => t.owe && !t.automated);
    const call = o.rows.map((r) => scheduledCall(r, now)).find(Boolean) ?? null;
    const due = o.rows.map((r) => cadence.get(String(r.n))?.nextFollowupDate).filter(Boolean).sort()[0] ?? null;
    const nextText = o.rows.map((r) => r.next).find(Boolean) ?? "";
    const who = o.people.find((p) => /recruit/i.test(p.role)) ?? o.people[0] ?? null;
    let line2, when, state;
    if (call && call.day >= today) {
      line2 = `Call · ${call.label}`; when = call.day; state = "scheduled";
    } else if (owe) {
      const since = localDay(Date.parse(owe.date) + DAY);
      const who1 = first(personName(owe, contacts));
      line2 = `Reply to ${!who1 || normCo(who1) === normCo(o.company) ? "recruiter" : who1}`; when = since; state = since < today ? "overdue" : since === today ? "today" : "upcoming";
    } else {
      const waitFrom = last && last.lastFromMe ? localDay(Date.parse(last.date) + waitDays * DAY) : null;
      when = due && waitFrom ? (due > waitFrom ? due : waitFrom) : due ?? waitFrom;
      line2 = nextText || (who ? `Waiting on ${first(who.name)}` : o.rows.length ? "Follow up" : "Waiting on them");
      state = !when ? "upcoming" : when < today ? "overdue" : when === today ? "today" : "upcoming";
    }
    const kinds = new Set(o.threads.map((t) => t.kind));
    const other = !o.rows.length && o.threads.length > 0 && [...kinds].every((k) => k === "other");
    // only rows that need a follow-up: tracker rows the cadence names or that carry threads,
    // scheduled calls, or threads waiting / owed
    const relevant = o.rows.some((r) => cadence.has(String(r.n))) || o.threads.some((t) => t.lastFromMe || t.owe) || !!call;
    if (!relevant) continue;
    out.push({
      key: o.key, title: o.title, company: o.company, line2, when, state, other,
      rows: o.rows.map((r) => ({ n: String(r.n), company: r.company, role: r.role, status: r.status, url: r.url ?? "" })),
      // automated senders (donotreply, ATS receipts) keep their messages but are not people
      people: o.people.filter((p) => p.threads.some((t) => !t.automated) && !/^(do-?not-?reply|no-?reply|notifications?)$/i.test(p.name)).map((p) => ({ name: p.name, role: p.role })),
      threads: o.threads.map((t) => ({ id: t.id, name: contacts[String(t.from ?? "").toLowerCase()]?.name ?? t.name, date: t.date, snippet: t.snippet, lastFromMe: t.lastFromMe, href: t.href, linkedin: /linkedin\.com/.test(t.href ?? "") || t.about === "LinkedIn", answeredVia: t.answeredVia ?? null })),
    });
  }
  const rank = { overdue: 0, today: 1, scheduled: 2, upcoming: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || String(a.when ?? "9").localeCompare(String(b.when ?? "9")) || a.title.localeCompare(b.title));
}

/** "overdue since Nov 14" / "today" / "check Nov 26" for line 2 (scheduled calls already carry their time). */
export function whenLabel(o, now = Date.now()) {
  if (!o.when || o.state === "scheduled") return "";
  const t = Date.parse(`${o.when}T12:00:00`);
  const md = Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : o.when;
  return o.state === "overdue" ? `overdue since ${md}` : o.state === "today" ? "today" : `check ${md}`;
}
