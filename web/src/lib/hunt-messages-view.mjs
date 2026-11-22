/**
 * Pure grouping for the /messages page, testable without React.
 * Groups threads by company, flags "needs reply", and links each company to its
 * tracker rows (by exact or normalized company name) and to inbox postings.
 */

export function normCompany(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|technologies|labs)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

const PRIORITY = { high: 0, medium: 1, low: 2 };

/** Replies owed: high priority first, then oldest first. */
export function orderReplies(messages, now = Date.now()) {
  return messages
    .filter((m) => needsReply(m, now))
    .sort((a, b) => (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1) || String(a.date).localeCompare(String(b.date)));
}

export function needsReply(m, now = Date.now()) {
  if (m?.needsReplyOverride === true && !m.lastFromMe) return true; // manual unanswered lists
  if (!m || m.lastFromMe || m.automated || m.meeting) return false; // automated: ATS receipts, digests; meeting: calendar invites
  const t = Date.parse(m.date);
  return Number.isFinite(t) && now - t > 24 * 3600 * 1000;
}

/**
 * @param {Array<{company: string|null, date: string, lastFromMe: boolean}>} messages
 * @param {Array<{n: string, company: string, role: string, status: string}>} applications
 * @param {Array<{company: string}>} inbox
 */
export function groupMessages(messages, applications = [], inbox = [], now = Date.now()) {
  const apps = new Map();
  for (const a of applications) {
    const k = normCompany(a.company);
    if (!k) continue;
    if (!apps.has(k)) apps.set(k, []);
    apps.get(k).push({ n: a.n, role: a.role, status: a.status });
  }
  const inboxCount = new Map();
  for (const j of inbox) {
    const k = normCompany(j.company);
    if (k) inboxCount.set(k, (inboxCount.get(k) ?? 0) + 1);
  }
  const groups = new Map();
  for (const m of messages) {
    const name = m.company || "Unknown company";
    const k = m.company ? normCompany(m.company) : "~unknown";
    if (!groups.has(k)) groups.set(k, { key: k, company: name, threads: [], tracker: apps.get(k) ?? [], inboxRoles: inboxCount.get(k) ?? 0, needsReply: 0, latest: "" });
    const g = groups.get(k);
    const nr = needsReply(m, now);
    g.threads.push({ ...m, needsReply: nr });
    if (nr) g.needsReply++;
    if (String(m.date) > g.latest) g.latest = String(m.date);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, threads: g.threads.sort((a, b) => String(b.date).localeCompare(String(a.date))) }))
    .sort((a, b) => (b.needsReply > 0) - (a.needsReply > 0) || b.latest.localeCompare(a.latest));
}

const personKey = (s) => String(s ?? "").toLowerCase().replace(/\s+via\s+linkedin$/, "").replace(/[^a-z]/g, "");

/**
 * The same LinkedIn person in a manual list (row has `source`) and in the Gmail
 * feed is shown once, keeping the manual row (it has the conversation URL).
 */
export function dedupeLinkedInPeople(messages) {
  const manual = new Set(messages.filter((m) => m.source && m.replyVia === "linkedin").map((m) => personKey(m.fromName)));
  return messages.filter((m) => m.source || m.replyVia !== "linkedin" || !manual.has(personKey(m.fromName)));
}
