/**
 * hunt: the Inbox (Messages + Follow-ups merged), pure and testable.
 *
 * Every opportunity from buildOpportunities({ keepAll: true }) lands in exactly one section:
 *   needs   "Needs my reply": the last live message is from them (not a calendar invite, not an
 *           automated receipt), an interview has no time set, a tracker next step is due or
 *           overdue, or a check-back date has passed ("Nudge X"). Most overdue first.
 *   waiting "Waiting on them": he wrote last, or something is scheduled (a call in the tracker
 *           notes, a calendar invite with a time). Scheduled items first by time, then by
 *           check-back date.
 *   done    marked Done / Ignore, coworker and other mail, automated-only threads, and threads
 *           he marked one by one. Shown collapsed.
 */

const DAY = 24 * 3600e3;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");

export function localDay(t) {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
}

const first = (name) => String(name ?? "").trim().split(/\s+/)[0] ?? "";

/** First date in a next-step note ("2026-11-24", "Nov 24", "11/24") as YYYY-MM-DD, or null. */
export function dateInNote(text, now = Date.now()) {
  const s = String(text ?? "");
  const iso = s.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const year = new Date(now).getFullYear();
  const named = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i);
  if (named) return `${year}-${pad(MONTHS.indexOf(named[1].toLowerCase()) + 1)}-${pad(named[2])}`;
  const us = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (us && +us[1] >= 1 && +us[1] <= 12 && +us[2] >= 1 && +us[2] <= 31) return `${year}-${pad(us[1])}-${pad(us[2])}`;
  return null;
}

/**
 * The time in a calendar invite subject ("Invitation: Interview with Whatnot @ Mon Nov 23, 2026
 * 12:30pm - 1pm (PST)"): { day: "2026-11-23", label: "Mon 12:30 PM", at: "2026-11-23T12:30" }, or null.
 */
export function meetingTime(subject) {
  const m = String(subject ?? "").match(/@\s*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2}),?\s+(20\d\d)(?:\s+(\d{1,2})(?::(\d\d))?\s*(am|pm))?/i);
  if (!m) return null;
  const day = `${m[4]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[3])}`;
  let at = `${day}T00:00`, time = "";
  if (m[5]) {
    let h = Number(m[5]) % 12;
    if (/pm/i.test(m[7])) h += 12;
    at = `${day}T${pad(h)}:${m[6] ?? "00"}`;
    time = ` ${Number(m[5])}:${m[6] ?? "00"} ${m[7].toUpperCase()}`;
  }
  return { day, label: `${m[1]}${time}`, at };
}

/** "Mon 11/23 10:30 AM" (tracker notes) -> sortable "2026-11-23T10:30". */
function callAt(call) {
  const t = String(call.label).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!t) return `${call.day}T00:00`;
  let h = Number(t[1]);
  if (t[3]) h = (h % 12) + (/pm/i.test(t[3]) ? 12 : 0);
  return `${call.day}T${pad(h)}:${t[2]}`;
}

/** "5h", "today", "3d" since a time. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, now - t);
  if (diff < DAY) return diff < 3600e3 ? "just now" : `${Math.round(diff / 3600e3)}h`;
  return `${Math.floor(diff / DAY)}d`;
}

const shortDay = (day) => {
  const t = Date.parse(`${day}T12:00:00`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : day;
};

/** "3d overdue" / "due today" for a YYYY-MM-DD that has come. */
function overdue(day, today) {
  if (day >= today) return "due today";
  const d = Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${day}T12:00:00`)) / DAY);
  return `${d}d overdue`;
}

const ATS_HOST = /@([a-z0-9-]+\.)*(ashbyhq|greenhouse|greenhouse-mail|lever|hire\.lever|myworkday|workday|icims|smartrecruiters|jobvite|workable|rippling|gem|bamboohr)\.(com|io|co)$/i;
const ASKS = [
  [/\bquestionnaire\b/i, (co) => `Fill out ${co} questionnaire`],
  [/\b(assessment|coding challenge|take[- ]home|hackerrank|codesignal)\b/i, (co) => `Complete ${co} assessment`],
  [/\b(availability|times? that work|pick a time|schedule (a|your) (call|time|interview))\b/i, (co) => `Send ${co} your availability`],
  [/\b(complete|finish|submit) your application\b|\bapplication (form|questions)\b/i, (co) => `Complete ${co} application`],
];

/**
 * ATS or hiring-team mail from a tracked company that asks him to do something ("please fill out
 * the application questionnaire"): { company, ask } or null. Receipts and digests ask nothing.
 * @param {{ from?: string, name?: string, subject?: string, snippet?: string, company?: string | null }} t
 * @param {string[]} trackedCompanies company names from the tracker (any status)
 */
export function atsActionAsk(t, trackedCompanies = []) {
  const from = String(t?.from ?? "").toLowerCase();
  const name = String(t?.name ?? "");
  const hiringTeam = /\b(hiring team|recruiting( team)?|talent( acquisition| team)?|careers)\b/i.test(name);
  if (!ATS_HOST.test(from) && !hiringTeam) return null;
  const text = `${t?.subject ?? ""} ${t?.snippet ?? ""}`;
  const ask = ASKS.find(([re]) => re.test(text));
  if (!ask) return null;
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hay = norm(`${name} ${t?.subject ?? ""} ${t?.company ?? ""} ${from.split("@")[1] ?? ""}`);
  const company = [...new Set(trackedCompanies)].filter((c) => norm(c).length >= 3 && hay.includes(norm(c))).sort((a, b) => norm(b).length - norm(a).length)[0];
  if (!company) return null;
  return { company, ask: ask[1](company) };
}

const SAY_RECRUITER = (name, o) => {
  const f = first(name);
  return !f || f.toLowerCase() === String(o.company ?? "").toLowerCase() || /@/.test(f) ? "recruiter" : f;
};

/**
 * One item per opportunity: { ...o, section: "needs"|"waiting"|"done", action, when, sort }.
 * `when` is the short "how long / when" text; `sort` orders rows within a section.
 * @param {any[]} opps buildOpportunities({ keepAll: true }) output, marks applied (o.mark)
 * @param {{ now?: number, waitDays?: number }} [opts]
 */
export function classifyInbox(opps, { now = Date.now(), waitDays = 5 } = {}) {
  const today = localDay(now);
  const nowAt = new Date(now - new Date(now).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  return (opps ?? []).map((o) => {
    const live = (o.threads ?? []).filter((t) => !t.archived);
    const human = live.filter((t) => !t.automated);
    const last = human[0] ?? null;
    const who = (o.people ?? []).find((p) => /recruit/i.test(p.role)) ?? o.people?.[0] ?? null;
    const base = { ...o };
    // What is scheduled: the tracker's call, or the newest calendar invite with a time to come.
    const scheduled = [];
    if (o.call && callAt(o.call) > nowAt) scheduled.push({ at: callAt(o.call), label: `Call ${o.call.label.replace(/\s\d{1,2}\/\d{1,2}\b/, "")}`, day: o.call.day });
    const pastMeetings = [];
    for (const t of live.filter((x) => x.meeting)) {
      const mt = meetingTime(t.subject);
      if (!mt) continue;
      const label = `${/interview/i.test(t.subject) ? "Interview" : "Call"} ${mt.label}`;
      if (mt.at > nowAt) scheduled.push({ at: mt.at, label, day: mt.day });
      else pastMeetings.push(mt.day);
    }
    scheduled.sort((a, b) => a.at.localeCompare(b.at));
    const next = scheduled[0] ?? null;
    if (next) base.scheduled = next;
    // A meeting still to come keeps the item in Waiting even when it was marked Done / Ignore,
    // until the meeting time passes.
    if (o.mark && next) return { ...base, section: "waiting", action: next.label, when: shortDay(next.day), sort: `0${next.at}` };
    // Done / ignored / not a job thread
    if (o.mark) return { ...base, section: "done", action: o.mark.mark === "done" ? "Marked done" : "Ignored", when: "", sort: "" };
    const onlyOther = !(o.rows ?? []).length && live.length > 0 && live.every((t) => t.kind === "other");
    if (o.other || onlyOther) return { ...base, section: "done", action: "Other mail", when: "", sort: "" };
    if (!(o.rows ?? []).length && human.length === 0) {
      return { ...base, section: "done", action: live.length ? "Automated mail" : "Marked done", when: "", sort: "" };
    }


    // A hiring team asking him to do something (questionnaire, assessment) since he last wrote.
    const lastMine = live.find((t) => t.lastFromMe)?.date ?? "";
    const askT = live.find((t) => t.ask && String(t.date) > String(lastMine));
    if (askT) {
      const before = next ? `before ${next.label.split(" ")[1]} ${next.label.split(" ")[0].toLowerCase()}` : `waiting ${ago(askT.date, now)}`;
      return { ...base, section: "needs", action: askT.ask, when: before, sort: String(askT.date) };
    }
    // A tracker next step he owns, with a date that has come.
    const nextNote = (o.rows ?? []).map((r) => ({ r, day: dateInNote(r.next, now) })).filter((x) => x.r.next && x.day).sort((a, b) => a.day.localeCompare(b.day))[0] ?? null;
    if (nextNote && nextNote.day <= today && !next) {
      return { ...base, section: "needs", action: String(nextNote.r.next).trim(), when: overdue(nextNote.day, today), sort: `${nextNote.day}T00:00` };
    }
    if (next) {
      return { ...base, section: "waiting", action: next.label, when: shortDay(next.day), sort: `0${next.at}` };
    }
    // A tracker row whose next step was set on or after their last message has decided what is
    // next ("Waiting on loop scheduling"), so that message is answered by the tracker.
    const decided = last && !last.lastFromMe && (o.rows ?? []).find((r) => String(r.next ?? "").trim() && !dateInNote(r.next, now) && r.updated && String(r.updated).slice(0, 10) >= localDay(Date.parse(last.date)));
    if (decided) {
      const dates = [o.cadenceDue].filter(Boolean);
      const checkBack = dates[0] ?? null;
      const action = String(decided.next).split(/[,;]/)[0].trim();
      if (checkBack && checkBack <= today) return { ...base, section: "needs", action: `Nudge ${first(who?.name) || o.company || o.title}`, when: overdue(checkBack, today), sort: `${checkBack}T00:00` };
      return { ...base, section: "waiting", action, when: checkBack ? `check ${shortDay(checkBack)}` : "", sort: checkBack ? `1${checkBack}` : "2" };
    }
    // The last live message is theirs (a calendar invite is scheduling, not a question).
    if (last && !last.lastFromMe && !last.meeting) {
      return { ...base, section: "needs", action: `Reply to ${SAY_RECRUITER(last.name, o)}`, when: `waiting ${ago(last.date, now)}`, sort: String(last.date) };
    }
    // An interview with no time set.
    const iv = (o.rows ?? []).find((r) => r.status === "Interview" && !String(r.next ?? "").trim());
    if (iv && !pastMeetings.length && !(last && last.lastFromMe)) {
      return { ...base, section: "needs", action: "Set the interview time", when: "", sort: "9" };
    }
    // Waiting: check back on the latest of the cadence date, his message + waitDays, the next
    // step's date, or the day after a past call + waitDays.
    const dates = [o.cadenceDue, last && last.lastFromMe ? localDay(Date.parse(last.date) + waitDays * DAY) : null, nextNote?.day, ...pastMeetings.map((d) => localDay(Date.parse(`${d}T12:00:00`) + waitDays * DAY))].filter(Boolean).sort();
    const checkBack = dates[dates.length - 1] ?? null;
    const name = first(who?.name) || "them";
    if (checkBack && checkBack <= today) {
      return { ...base, section: "needs", action: `Nudge ${name === "them" ? (o.company || o.title) : name}`, when: overdue(checkBack, today), sort: `${checkBack}T00:00` };
    }
    const nextText = (o.rows ?? []).map((r) => r.next).find(Boolean);
    return { ...base, section: "waiting", action: nextText || `Waiting on ${name}`, when: checkBack ? `check ${shortDay(checkBack)}` : "", sort: checkBack ? `1${checkBack}` : "2" };
  });
}

/** { needs, waiting, done }, each sorted; every opportunity in exactly one. */
export function inboxSections(opps, opts = {}) {
  const items = classifyInbox(opps, opts);
  const by = (s) => items.filter((i) => i.section === s);
  const needs = by("needs").sort((a, b) => a.sort.localeCompare(b.sort) || a.title.localeCompare(b.title));
  const waiting = by("waiting").sort((a, b) => a.sort.localeCompare(b.sort) || a.title.localeCompare(b.title));
  const done = by("done").sort((a, b) => String(b.threads?.[0]?.date ?? "").localeCompare(String(a.threads?.[0]?.date ?? "")));
  return { needs, waiting, done };
}

/** Home "Needs you" rows for the Inbox's Needs-my-reply items (same shape needsYou() returns). */
export function needsYouFromInbox(needs) {
  return (needs ?? []).map((i) => ({
    id: `inbox:${i.key}`,
    label: i.title,
    detail: i.when ? `${i.action} · ${i.when}` : i.action,
    action: "Open",
    href: `/inbox/${encodeURIComponent(i.key)}`,
    sort: 0,
  }));
}

/**
 * The buttons an Inbox row shows besides Done / Ignore / Details:
 *   reply: the newest live thread with a Gmail or LinkedIn link (theirs first), on Needs rows only
 *   job:   the tracker job (/pipeline/<n>), else the posting; null when the row has no job
 * @param {any} item an inboxSections() item
 */
export function rowActions(item) {
  const live = (item?.threads ?? []).filter((t) => !t.archived && /mail\.google\.com|linkedin\.com/.test(String(t.href ?? "")));
  const t = live.find((x) => !x.lastFromMe && !x.automated) ?? live[0] ?? null;
  const reply = item?.section === "needs" && t ? { href: t.href, label: t.linkedin || /linkedin\.com/.test(t.href) ? "Reply on LinkedIn" : "Reply" } : null;
  const r = (item?.rows ?? [])[0] ?? null;
  const job = r ? (r.n ? { href: `/pipeline/${encodeURIComponent(r.n)}`, external: false } : r.url ? { href: r.url, external: true } : null) : null;
  return { reply, job };
}
