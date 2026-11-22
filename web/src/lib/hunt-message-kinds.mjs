/**
 * hunt: who is this thread from, and does it matter for the job search?
 *   recruiter — agency or in-house recruiter / sourcer / talent person
 *   job_lead  — someone offering or referring a specific role, or a hiring manager
 *   other     — coworkers, friends, congrats, social, automated receipts
 * Deterministic rules first; a thread the rules can't place returns null and goes to
 * Haiku (scripts/hunt-message-kinds.mjs), whose answer is cached per thread.
 * Plus Done / Won't respond marks (data/message-marks.json). Pure; no I/O.
 */

export const KINDS = Object.freeze(["recruiter", "job_lead", "other"]);
export const MARKS = Object.freeze(["done", "wont"]);

const RECRUITER_RE = /\b(recruit(?:er|ers|ing|ment)?|talent(?:\s+(?:partner|acquisition|lead|team))?|sourcer|sourcing|head\s*hunter|headhunter|staffing|t\.?a\.?\s+(?:partner|lead|team)|inmail)\b/i;
const HIRING_MANAGER_RE = /\b(hiring\s+manager|i(?:'|’)m\s+hiring|we(?:'|’)re\s+hiring|my\s+team\s+is\s+hiring|refer(?:ral|red|ring)?\s+(?:you|for)|would\s+love\s+to\s+refer)\b/i;
const JOB_RE = /\b(role|roles|position|opening|opportunit(?:y|ies)|interview(?:s|ing)?|comp(?:ensation)?|salary|job\s+description|\bJD\b|calendly|ashby|greenhouse|lever\.co|workday|apply|application|req(?:uisition)?\b|offer|onsite|phone\s+screen|tech(?:nical)?\s+screen)\b/i;
const SOCIAL_RE = /\b(co-?worker|colleague|teammate|friend|congrat(?:s|ulations)?|happy\s+birthday|catch\s+up|laid\s+off|layoff|keep\s+in\s+touch|long\s+time|how\s+are\s+you|ex-[a-z]+)\b/i;
// Recruiting agencies / marketplaces seen in real threads (company or "via X" notes).
const AGENCY_RE = /\b(paraform|integra\s+advisors|hired\.com|triplebyte|wellfound|toptal|robert\s+half|hays|kforce|teksystems|insight\s+global|cybercoders)\b/i;
const RECEIPT_RE = /\b(received\s+your\s+application|thank(?:s| you)\s+for\s+(?:applying|your\s+application|your\s+interest)|application\s+(?:received|confirmation)|we(?:'|’)ve\s+received)\b/i;
const RECRUITING_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*(?:greenhouse\.io|ashbyhq\.com|lever\.co|myworkday(?:jobs)?\.com|smartrecruiters\.com|icims\.com|paraform\.com|gem\.com|workablemail\.com|hire\.lever\.co)\b/i;

// Government benefits mail (paid leave / unemployment claims, from a *.gov benefits sender): never a
// job thread, even when it says "application".
const GOV_BENEFITS_RE = /@(?:[a-z0-9-]+\.)*[a-z0-9-]*(?:paidleave|unemployment|uibenefits)[a-z0-9-]*\.(?:[a-z0-9-]+\.)*gov\b|\bnoreply-?paidleave\b|\b(?:paid\s+(?:family\s+)?leave|unemployment(?:\s+insurance)?)\s+(?:benefit|claim|application)s?\b/i;

const s = (v) => String(v ?? "");

/** Rule-based kind, or null when the rules can't tell (send it to Haiku). */
export function classifyByRules(m) {
  if (!m) return null;
  const who = [m.fromName, m.subtitle, m.note].map(s).join(" · ");
  const body = [m.subject, m.snippet].map(s).join(" · ");
  const all = `${who} · ${body}`;
  if (GOV_BENEFITS_RE.test(`${s(m.from)} · ${all}`)) return { kind: "other", why: "state benefits mail (paid leave / unemployment)" };
  if (m.automated || RECEIPT_RE.test(body)) return { kind: "other", why: "automated or application receipt" };
  if (RECRUITER_RE.test(who) || AGENCY_RE.test(all) || RECRUITING_DOMAIN_RE.test(s(m.from))) {
    return { kind: "recruiter", why: "recruiter / talent / agency signal" };
  }
  if (HIRING_MANAGER_RE.test(all)) return { kind: "job_lead", why: "hiring manager or referral" };
  // A social sender line ("ex-Initech coworker") wins over job words in the body:
  // a coworker asking about interviewing is not a job lead.
  if (SOCIAL_RE.test(who)) return { kind: "other", why: "coworker / friend / social" };
  if (JOB_RE.test(all) && (m.company || /https?:\/\//.test(body))) return { kind: "job_lead", why: "mentions a specific role" };
  if (SOCIAL_RE.test(body)) return { kind: "other", why: "social message" };
  return null;
}

/**
 * Final kind for one thread: manual override > rules > cached Haiku answer > "unclear".
 * "unclear" stays in the main list (never hide a possible recruiter by guessing).
 */
export function threadKind(m, { overrides = {}, cache = {} } = {}) {
  const o = overrides[m.threadId];
  if (o && KINDS.includes(o.kind)) return { kind: o.kind, why: "set by you", by: "you" };
  const r = classifyByRules(m);
  if (r) return { ...r, by: "rules" };
  const c = cache[m.threadId];
  if (c && (KINDS.includes(c.kind) || c.kind === "unclear")) return { kind: c.kind, why: s(c.why), by: "haiku" };
  return { kind: "unclear", why: "not classified yet", by: "none" };
}

export const countsInMainList = (kind) => kind !== "other";

/**
 * A LinkedIn digest ("James just messaged you" / "1 new message awaits your response") carries
 * no content to classify: Haiku would only answer "unclear", so it is never sent.
 */
export function isContentless(m) {
  const body = cleanSnippet(`${s(m?.subject)} ${s(m?.snippet)}`);
  return /just messaged you|new message awaits your response|sent you a message/i.test(body) && !m?.subtitle && !m?.note;
}

/** Threads the rules can't place and Haiku hasn't seen (or the thread changed since). */
export function needsHaiku(messages, cache = {}, overrides = {}) {
  return messages.filter((m) => !overrides[m.threadId] && !classifyByRules(m) && !isContentless(m) && cache[m.threadId]?.date !== m.date);
}

/** Parse one Haiku reply: a JSON array of {id, kind, why}. Bad rows are dropped. */
export function parseHaikuKinds(text, ids) {
  const want = new Set(ids);
  const t = s(text);
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end < start) return {};
  let rows;
  try { rows = JSON.parse(t.slice(start, end + 1)); } catch { return {}; }
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = s(r?.id);
    const kind = s(r?.kind);
    if (!want.has(id) || !(KINDS.includes(kind) || kind === "unclear")) continue;
    out[id] = { kind, why: s(r?.why).split(/\s+/).slice(0, 10).join(" ") };
  }
  return out;
}

// ── Done / Won't respond marks ───────────────────────────────────────────────

export function normalizeMarks(doc) {
  const marks = {};
  const kindOverrides = {};
  for (const [id, v] of Object.entries(doc?.marks ?? {})) {
    if (id && v && MARKS.includes(v.mark)) marks[id] = { mark: v.mark, at: s(v.at), lastDate: s(v.lastDate) };
  }
  for (const [id, v] of Object.entries(doc?.kindOverrides ?? {})) {
    if (id && v && KINDS.includes(v.kind)) kindOverrides[id] = { kind: v.kind, at: s(v.at) };
  }
  return { marks, kindOverrides, updatedAt: s(doc?.updatedAt) || null };
}

/** op: {op:"mark", id, mark: "done"|"wont"|null, lastDate} | {op:"kind", id, kind: KIND|null}. Returns null on a bad op. */
export function applyMarkOp(state, op, now = new Date()) {
  const id = s(op?.id).slice(0, 300);
  if (!id) return null;
  const next = { marks: { ...state.marks }, kindOverrides: { ...state.kindOverrides }, updatedAt: now.toISOString() };
  if (op.op === "mark") {
    if (op.mark == null) delete next.marks[id];
    else if (MARKS.includes(op.mark)) next.marks[id] = { mark: op.mark, at: now.toISOString(), lastDate: s(op.lastDate) };
    else return null;
    return next;
  }
  if (op.op === "kind") {
    if (op.kind == null) delete next.kindOverrides[id];
    else if (KINDS.includes(op.kind)) next.kindOverrides[id] = { kind: op.kind, at: now.toISOString() };
    else return null;
    return next;
  }
  return null;
}

/**
 * Where a row goes given its mark. A Done thread comes back (with "new reply") when a
 * newer message from them arrives after it was marked; Won't respond stays archived.
 * item: {id, date, lastFromMe}.
 */
export function markState(item, marks = {}) {
  const m = marks[item.id];
  if (!m) return { archived: false, newReply: false, mark: null };
  if (m.mark === "done" && !item.lastFromMe && item.date && m.lastDate && String(item.date) > String(m.lastDate)) {
    return { archived: false, newReply: true, mark: null };
  }
  return { archived: true, newReply: false, mark: m };
}

// ── compact row helpers ──────────────────────────────────────────────────────

/** "2h", "Tue", "Nov 3" — short relative date for list rows. */
export function shortWhen(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now.getTime() - t;
  if (diff < 0) return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (diff < 3600e3) return `${Math.max(1, Math.round(diff / 60e3))}m`;
  if (diff < 24 * 3600e3) return `${Math.round(diff / 3600e3)}h`;
  if (diff < 6 * 24 * 3600e3) return new Date(t).toLocaleDateString("en-US", { weekday: "short" });
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Strip LinkedIn digest padding (U+034F etc.) and collapse whitespace. */
export function cleanSnippet(text) {
  return s(text).replace(/[͏​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
}

// ── rows for Messages / Follow-ups / Home ────────────────────────────────────

const DAY = 24 * 3600e3;

/**
 * One compact row per thread. `needsReply` is the existing rule (their message, > 24h, not
 * automated), passed in so this module stays free of the messages-view import cycle.
 */
/**
 * @param {any[]} messages
 * @param {{ marks?: Record<string, any>, kindOverrides?: Record<string, any>, cache?: Record<string, any>, needsReply?: (m: any, now: number) => boolean, now?: number }} [opts]
 */
export function threadRows(messages, { marks = {}, kindOverrides = {}, cache = {}, needsReply = () => false, now = Date.now() } = {}) {
  return messages
    .map((m) => {
      const k = threadKind(m, { overrides: kindOverrides, cache });
      const item = { id: m.threadId, date: s(m.date), lastFromMe: !!m.lastFromMe };
      const st = markState(item, marks);
      const name = s(m.fromName) || s(m.company) || s(m.from).replace(/@.*/, "");
      const about = [m.company && m.company !== name ? m.company : "", m.subtitle && !RECRUITER_RE.test(s(m.subtitle)) ? m.subtitle : ""].filter(Boolean).join(" · ");
      return {
        id: m.threadId,
        from: s(m.from),
        company: m.company ?? null,
        name,
        about: about || (m.replyVia === "linkedin" ? "LinkedIn" : ""),
        snippet: cleanSnippet(m.snippet || m.note || m.subject),
        date: s(m.date),
        lastFromMe: !!m.lastFromMe,
        owe: needsReply(m, now) || st.newReply,
        automated: !!m.automated,
        meeting: !!m.meeting,
        subject: s(m.subject),
        kind: k.kind,
        kindBy: k.by,
        why: k.why,
        href: s(m.link),
        external: true,
        newReply: st.newReply,
        answeredVia: m.answeredVia ?? null,
        archived: st.archived,
        mark: st.mark,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Split rows into the main list, the collapsed "Other" group and the collapsed archive. */
export function splitRows(rows) {
  const main = [], other = [], archived = [];
  for (const r of rows) {
    if (r.archived) archived.push(r);
    else if (r.kind === "other") other.push(r);
    else main.push(r);
  }
  archived.sort((a, b) => String(b.mark?.at).localeCompare(String(a.mark?.at)));
  return { main, other, archived };
}

/**
 * Follow-up rows: tracker applications the cadence calculator says to nudge (id "app:<num>",
 * due = its next follow-up date) plus recruiter / job-lead threads where the last word was
 * yours (waiting on them; due 5 days after your message). Due date first, then newest.
 */
export function followupRows(entries, threadRowsList, { waitDays = 5, now = Date.now() } = {}) {
  const apps = (entries ?? []).map((e) => ({
    id: `app:${e.num}`,
    name: s(e.company),
    about: s(e.role),
    snippet: e.followupCount ? `${e.followupCount} follow-up${e.followupCount === 1 ? "" : "s"} sent · applied ${s(e.appliedDate || e.date)}` : `Applied ${s(e.appliedDate || e.date)} · no follow-up yet`,
    date: s(e.appliedDate || e.date),
    lastFromMe: true,
    owe: false, // the due chip says it; "you owe a reply" is for messages
    kind: "application",
    due: s(e.nextFollowupDate) || null,
    href: `/pipeline/${encodeURIComponent(String(e.num))}`,
    external: false,
    status: s(e.status),
  }));
  const threads = (threadRowsList ?? [])
    .filter((r) => r.kind !== "other" && r.lastFromMe && !r.automated)
    .map((r) => ({ ...r, owe: false, due: new Date(Date.parse(r.date) + waitDays * DAY).toISOString().slice(0, 10) }));
  return [...apps, ...threads].sort((a, b) => {
    if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return String(b.date).localeCompare(String(a.date));
  });
}

/** "Nov 14" chip text, and whether it's due (today or past). */
export function dueChip(due, now = new Date()) {
  if (!due) return null;
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
  const t = Date.parse(`${due}T12:00:00`);
  const label = Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : due;
  return { label: due < today ? `overdue · ${label}` : due === today ? "due today" : `due ${label}`, overdue: due <= today };
}

// ── auto-clear: replies and meetings found in Gmail answer LinkedIn items ────

const personTokens = (name) => cleanSnippet(name).toLowerCase().replace(/\s+via\s+linkedin$/, "").replace(/\([^)]*\)/g, " ").split(/[^a-z]+/).filter((w) => w.length >= 2);
const normCo = (s) => s ? String(s).toLowerCase().replace(/\b(inc|llc|ltd|corp|co)\b\.?/g, "").replace(/[^a-z0-9]/g, "") : "";

/** Does Gmail thread `g` concern the same person (full name) or company as LinkedIn item `li`? */
export function samePersonOrCompany(li, g) {
  const tokens = personTokens(li.fromName);
  const hay = cleanSnippet(`${g.fromName ?? ""} ${g.from ?? ""} ${g.subject ?? ""} ${g.snippet ?? ""}`).toLowerCase();
  if (tokens.length >= 2 && tokens.every((t) => new RegExp(`\\b${t}\\b`).test(hay))) return true;
  // "samrivera@examplestaffing.com": the full name run together in an address
  if (tokens.length >= 2 && hay.replace(/[^a-z@]/g, "").includes(tokens.join(""))) return true;
  const a = normCo(li.company), b = normCo(g.company);
  return !!a && a === b;
}

/**
 * LinkedIn items (the manual snapshot or LinkedIn notification mail) count as answered when a
 * Gmail thread with the same person or company shows his reply (last message his) or a
 * scheduled meeting, newer than the LinkedIn message. Answered items get lastFromMe: true and
 * answeredVia: "email" | "meeting". Pure; returns new message objects.
 */
export function autoClear(messages) {
  const gmail = messages.filter((m) => m.replyVia !== "linkedin" && !m.source);
  return messages.map((m) => {
    if (m.replyVia !== "linkedin" || m.lastFromMe) return m;
    const hit = gmail
      .filter((g) => String(g.date) > String(m.date) && (g.lastFromMe || g.meeting) && samePersonOrCompany(m, g))
      .sort((a, b) => (b.meeting ? 1 : 0) - (a.meeting ? 1 : 0))[0];
    return hit ? { ...m, lastFromMe: true, answeredVia: hit.meeting ? "meeting" : "email", answeredAt: hit.date } : m;
  });
}
