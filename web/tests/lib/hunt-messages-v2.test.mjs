// hunt: message kinds (rules), Done / Won't respond marks, follow-up rows and Home v2 helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyMarkOp, classifyByRules, dueChip, followupRows, isContentless, markState, needsHaiku,
  normalizeMarks, parseHaikuKinds, shortWhen, splitRows, threadKind, threadRows,
} from "../../src/lib/hunt-message-kinds.mjs";
import { dateInText, inFlight, lastScanAt, lastVisitFrom, needsYou, newSince, trueRank, weekCost, worthALook } from "../../src/lib/hunt-home-v2.mjs";

const msg = (o) => ({ threadId: "t1", from: "x@example.com", fromName: "", company: null, subject: "", snippet: "", date: "2026-11-20T10:00:00Z", lastFromMe: false, ...o });

test("rules: recruiter by title / headline, agency or recruiting domain", () => {
  assert.equal(classifyByRules(msg({ fromName: "Hannah", subtitle: "Senior SWE (recruiter InMail)" })).kind, "recruiter");
  assert.equal(classifyByRules(msg({ fromName: "Pat", subtitle: "Talent Partner at Acme" })).kind, "recruiter");
  assert.equal(classifyByRules(msg({ fromName: "Jo", note: "via Paraform" })).kind, "recruiter");
  assert.equal(classifyByRules(msg({ from: "jobs@acme.ashbyhq.com", subject: "Next steps" })).kind, "recruiter");
  assert.equal(classifyByRules(msg({ fromName: "Sam", subtitle: "Technical Sourcer" })).kind, "recruiter");
});

test("rules: job lead for hiring managers, referrals and a specific role", () => {
  assert.equal(classifyByRules(msg({ fromName: "Lee", snippet: "I'm the hiring manager for the payments team" })).kind, "job_lead");
  assert.equal(classifyByRules(msg({ fromName: "Kim", snippet: "Would love to refer you for this" })).kind, "job_lead");
  assert.equal(classifyByRules(msg({ fromName: "Ana", company: "Acme", snippet: "We have a senior backend position open, comp is strong" })).kind, "job_lead");
});

test("rules: coworkers, friends, congrats and receipts are other", () => {
  assert.equal(classifyByRules(msg({ fromName: "Leo", subtitle: "ex-Initech coworker" })).kind, "other");
  // a coworker asking about interviewing is still not a job lead
  assert.equal(classifyByRules(msg({ fromName: "Alice", subtitle: "ex-Initech coworker (now at a startup)", snippet: "Interviewing at small shops; what roles are you looking at?" })).kind, "other");
  assert.equal(classifyByRules(msg({ fromName: "Max", snippet: "Congrats on the new chapter!" })).kind, "other");
  assert.equal(classifyByRules(msg({ subject: "We've received your application", automated: true })).kind, "other");
});

test("rules: ambiguous threads return null; contentless LinkedIn digests are never sent to Haiku", () => {
  const vague = msg({ threadId: "v", fromName: "Chris", subject: "Quick question", snippet: "Got a minute this week?" });
  assert.equal(classifyByRules(vague), null);
  const digest = msg({ threadId: "d", fromName: "James", subject: "James just messaged you", snippet: "1 new message awaits your response" });
  assert.equal(isContentless(digest), true);
  assert.deepEqual(needsHaiku([vague, digest], {}, {}).map((m) => m.threadId), ["v"]);
  // cached for the same last-message date: not re-asked; a newer message re-asks
  assert.equal(needsHaiku([vague], { v: { kind: "other", date: vague.date } }).length, 0);
  assert.equal(needsHaiku([{ ...vague, date: "2026-11-21T00:00:00Z" }], { v: { kind: "other", date: vague.date } }).length, 1);
});

test("kind precedence: your override > rules > cached Haiku > unclear", () => {
  const m = msg({ threadId: "a", fromName: "Leo", subtitle: "ex-Initech coworker" });
  assert.equal(threadKind(m).kind, "other");
  assert.equal(threadKind(m, { overrides: { a: { kind: "job_lead" } } }).kind, "job_lead");
  const v = msg({ threadId: "v", snippet: "Got a minute?" });
  assert.equal(threadKind(v).kind, "unclear");
  assert.equal(threadKind(v, { cache: { v: { kind: "recruiter", why: "x" } } }).kind, "recruiter");
});

test("Haiku answers are parsed as JSON only, known ids and kinds, why capped at 10 words", () => {
  const out = parseHaikuKinds('noise [{"id":"a","kind":"recruiter","why":"one two three four five six seven eight nine ten eleven"},{"id":"zz","kind":"other"},{"id":"b","kind":"boss"}]', ["a", "b"]);
  assert.deepEqual(Object.keys(out), ["a"]);
  assert.equal(out.a.why.split(" ").length, 10);
  assert.deepEqual(parseHaikuKinds("not json", ["a"]), {});
});

test("marks: done / won't respond, undo, and Done comes back on a newer reply from them", () => {
  let s = normalizeMarks({});
  s = applyMarkOp(s, { op: "mark", id: "t1", mark: "done", lastDate: "2026-11-20T10:00:00Z" }, new Date("2026-11-20T12:00:00Z"));
  assert.equal(s.marks.t1.mark, "done");
  assert.equal(markState({ id: "t1", date: "2026-11-20T10:00:00Z", lastFromMe: false }, s.marks).archived, true);
  const back = markState({ id: "t1", date: "2026-11-21T09:00:00Z", lastFromMe: false }, s.marks);
  assert.deepEqual([back.archived, back.newReply], [false, true]);
  // his own later message does not bring it back
  assert.equal(markState({ id: "t1", date: "2026-11-21T09:00:00Z", lastFromMe: true }, s.marks).archived, true);
  s = applyMarkOp(s, { op: "mark", id: "t2", mark: "wont", lastDate: "2026-11-20T10:00:00Z" });
  assert.equal(markState({ id: "t2", date: "2026-11-25T00:00:00Z", lastFromMe: false }, s.marks).archived, true, "won't respond stays hidden");
  s = applyMarkOp(s, { op: "mark", id: "t2", mark: null });
  assert.equal(s.marks.t2, undefined);
  assert.equal(applyMarkOp(s, { op: "mark", id: "t3", mark: "maybe" }), null);
  assert.equal(applyMarkOp(s, { op: "kind", id: "t3", kind: "job_lead" }).kindOverrides.t3.kind, "job_lead");
});

test("thread rows: newest first; other and archived split out", () => {
  const rows = threadRows([
    msg({ threadId: "old", fromName: "Rec", subtitle: "recruiter", date: "2026-11-01T00:00:00Z" }),
    msg({ threadId: "new", fromName: "Rec2", subtitle: "recruiter", date: "2026-11-19T00:00:00Z" }),
    msg({ threadId: "co", fromName: "Leo", subtitle: "ex-Acme coworker", date: "2026-11-18T00:00:00Z" }),
  ], { marks: { old: { mark: "wont", at: "2026-11-02T00:00:00Z", lastDate: "2026-11-01T00:00:00Z" } } });
  assert.deepEqual(rows.map((r) => r.id), ["new", "co", "old"]);
  const { main, other, archived } = splitRows(rows);
  assert.deepEqual([main.map((r) => r.id), other.map((r) => r.id), archived.map((r) => r.id)], [["new"], ["co"], ["old"]]);
});

test("follow-up rows: due date first, then newest; social threads excluded", () => {
  const threads = threadRows([
    msg({ threadId: "w", fromName: "Rec", subtitle: "recruiter", lastFromMe: true, date: "2026-11-10T00:00:00Z" }),
    msg({ threadId: "s", fromName: "Leo", subtitle: "coworker", lastFromMe: true, date: "2026-11-19T00:00:00Z" }),
  ]);
  const rows = followupRows([{ num: 5, company: "Acme", role: "SWE", urgency: "overdue", nextFollowupDate: "2026-11-14", appliedDate: "2026-11-07", followupCount: 0 }], threads);
  assert.deepEqual(rows.map((r) => r.id), ["app:5", "w"]);
  assert.equal(rows[1].due, "2026-11-15");
  assert.equal(rows[0].href, "/pipeline/5");
  assert.equal(dueChip("2026-11-14", new Date("2026-11-20T12:00:00")).overdue, true);
  assert.equal(dueChip("2026-11-30", new Date("2026-11-20T12:00:00")).label, "due Nov 30");
});

test("shortWhen: minutes, hours, weekday, then month day", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  assert.equal(shortWhen("2026-11-21T11:30:00Z", now), "30m");
  assert.equal(shortWhen("2026-11-21T10:00:00Z", now), "2h");
  assert.match(shortWhen("2026-11-01T10:00:00Z", now), /^Nov 1$/);
});

test("Home: next-step dates, in flight, Needs you", () => {
  const now = Date.parse("2026-11-21T12:00:00");
  assert.equal(dateInText("call 2026-11-24", now), "2026-11-24");
  assert.equal(dateInText("recruiter screen Nov 3", now), "2026-11-03");
  assert.equal(dateInText("send thank-you", now), null);
  const tracker = [
    { n: "1", company: "A", role: "R", status: "Interview", updated: "2026-11-20", next: "" },
    { n: "2", company: "B", role: "R", status: "Applied", updated: "2026-11-19", next: "call 2026-11-20" },
    { n: "3", company: "C", role: "R", status: "Evaluated", updated: "2026-11-21", next: "" },
    { n: "4", company: "D", role: "R", status: "Rejected", updated: "2026-11-21", next: "" },
  ];
  assert.deepEqual(inFlight(tracker).map((r) => r.n), ["1", "2"]);
  const threads = [{ id: "t", name: "Rec", about: "Acme", owe: true, kind: "recruiter", href: "https://mail/t" }, { id: "o", name: "Leo", owe: true, kind: "other", href: "x" }, { id: "z", name: "Z", owe: true, kind: "recruiter", archived: true, href: "z" }];
  const items = needsYou({ tracker, threads, followups: [{ id: "app:9", name: "E", due: "2026-11-14" }], now });
  assert.deepEqual(items.map((i) => i.id), ["next:2", "nonext:1", "msg:t", "fu:app:9"]);
  assert.deepEqual(needsYou({ now }), []);
});

test("Home: true rank, worth a look, new since the last visit (first_seen_at)", () => {
  const jobs = {
    a: { company: "A", composite: 50, h2h_rank: 2 },
    b: { company: "B", composite: 90 },
    c: { company: "C", composite: 95, h2h_rank: 1 },
    d: { company: "D", composite: 10, quick_score: 4 },
    e: { company: "E", composite: 99, status: "Rejected" },
  };
  assert.deepEqual(trueRank(jobs).map((e) => e.url), ["d", "c", "a", "b"]); // unevaluated: quick score first; head-to-head only breaks ties
  assert.deepEqual(worthALook(jobs, 2).map((e) => e.url), ["d", "c"]);
  // "new" = first seen after the last visit, and worth a look; re-ranking never makes an old job new
  const worth = worthALook(jobs, 2);
  const firstSeen = { c: "2026-11-01T00:00:00Z", a: "2026-11-21T10:00:00Z", d: "2026-11-21T13:00:00Z" };
  assert.deepEqual(newSince(worth, firstSeen, "2026-11-21T12:00:00Z").map((e) => e.url), ["d"]);
  assert.deepEqual(newSince(worth, firstSeen, null), [], "no recorded visit: nothing flagged");
  assert.deepEqual(newSince(worth, {}, "2026-11-01T00:00:00Z"), [], "no first-seen time: not new");
  assert.equal(lastVisitFrom({ lastVisit: "2026-11-21T12:00:00Z" }), "2026-11-21T12:00:00Z");
  assert.equal(lastVisitFrom({ current: { at: "2026-11-21T11:00:00Z", urls: [] } }), "2026-11-21T11:00:00Z", "old file shape");
  assert.equal(lastVisitFrom(null), null);
});

test("Home footer: week cost and last scan", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const tsv = "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\n2026-11-20T00:00:00Z\tm\tok\t1\t1\t0.25\n2026-11-01T00:00:00Z\tm\tok\t1\t1\t9\n2026-11-21T00:00:00Z\tm\tok\t1\t1\t0.10\n";
  assert.equal(weekCost(tsv, now), 0.35);
  assert.equal(weekCost("", now), 0);
  assert.equal(lastScanAt("timestamp\tnew_added\n2026-11-20T01:00:00Z\t3\n2026-11-21T01:00:00Z\t1\n"), "2026-11-21T01:00:00Z");
  assert.equal(lastScanAt(""), null);
});

// ── v2 feed + auto-clear ──────────────────────────────────────────────────────
import { autoClear, samePersonOrCompany } from "../../src/lib/hunt-message-kinds.mjs";
import { feedThreads, syncDelta, toRow } from "../../../scripts/hunt-messages-sync.mjs";
import { needsReply as webNeedsReply } from "../../src/lib/hunt-messages-view.mjs";

const li = (o) => ({ threadId: "li", fromName: "Jordan Lee", company: "Brightloop", replyVia: "linkedin", source: "linkedin-manual", needsReplyOverride: true, lastFromMe: false, date: "2026-11-18T00:00:00Z", subject: "", snippet: "", ...o });

test("auto-clear: a later Gmail reply or meeting with the same person or company answers a LinkedIn item", () => {
  const meeting = { threadId: "g1", fromName: "Calendly", from: "notifications@calendly.com", subject: "Invitation: Jordan Lee and Alex Doe", snippet: "", company: null, lastFromMe: false, meeting: true, date: "2026-11-20T00:00:00Z" };
  const [cleared] = autoClear([li(), meeting]);
  assert.deepEqual([cleared.lastFromMe, cleared.answeredVia], [true, "meeting"]);
  assert.equal(webNeedsReply(cleared, Date.parse("2026-11-21T00:00:00Z")), false, "no longer owed");
  // his own email reply, matched by company
  const reply = { threadId: "g2", fromName: "Steve", from: "steve@example-startup.test", subject: "Re: role", snippet: "", company: "Example Startup", lastFromMe: true, date: "2026-11-21T00:00:00Z" };
  assert.equal(autoClear([li({ fromName: "Steve DeBear", company: "Example Startup" }), reply])[0].answeredVia, "email");
});

test("auto-clear: older mail, their (not his) last message, or a different person does not clear", () => {
  const old = { threadId: "g", fromName: "Jordan Lee", subject: "x", company: null, lastFromMe: true, date: "2026-11-01T00:00:00Z" };
  assert.equal(autoClear([li(), old])[0].lastFromMe, false);
  const theirs = { ...old, date: "2026-11-20T00:00:00Z", lastFromMe: false };
  assert.equal(autoClear([li(), theirs])[0].lastFromMe, false);
  const other = { ...old, fromName: "Jenna Smith", date: "2026-11-20T00:00:00Z" };
  assert.equal(samePersonOrCompany(li(), other), false, "first name alone is not enough");
  assert.equal(autoClear([li(), other])[0].lastFromMe, false);
});

test("v2 feed: search threads merge with labeled ones; receipts are automated; meetings flagged", () => {
  const body = { ok: true, version: 2, threads: [{ threadId: "a", lastDate: "2026-11-20", labels: ["Job Hunt/Recruiters"] }], searchThreads: [{ threadId: "a", lastDate: "2026-11-21", labels: ["search:recruiting"] }, { threadId: "b", lastDate: "2026-11-19", labels: ["search:recruiting"] }] };
  const all = feedThreads(body);
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((t) => t.threadId === "a").labels.sort(), ["Job Hunt/Recruiters", "search:recruiting"]);
  assert.equal(feedThreads({ ok: true }), null);
  const co = new Map();
  assert.equal(toRow({ threadId: "r", from: "Microsoft Careers <careers@careers.microsoft.com>", subject: "Thank you for applying", lastDate: "2026-11-20" }, co).automated, true);
  assert.equal(toRow({ threadId: "r2", from: "Jo <jo@acme.com>", subject: "We've received your application to Acme", lastDate: "2026-11-20" }, co).automated, true);
  const m = toRow({ threadId: "m", from: "Calendly <notifications@calendly.com>", subject: "New Event: Alex Doe - 30 Minute Meeting", lastDate: "2026-11-20", labels: ["search:recruiting"] }, co);
  assert.deepEqual([m.meeting, m.search], [true, true]);
  assert.equal(toRow({ threadId: "p", from: "Pat <pat@acme.com>", subject: "Quick chat about a role?", lastDate: "2026-11-20" }, co).meeting, undefined);
});

test("sync summary: new threads and threads cleared from 'you owe'", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const before = [{ threadId: "x", lastFromMe: false, date: "2026-11-18T00:00:00Z" }];
  const after = [{ threadId: "x", lastFromMe: true, date: "2026-11-21T00:00:00Z" }, { threadId: "y", lastFromMe: false, date: "2026-11-21T00:00:00Z" }];
  assert.deepEqual(syncDelta(before, after, now), { added: 1, cleared: 1 });
});

test("calendar invites (meeting threads) are never 'you owe'; name-pair subjects count as invites", async () => {
  const { NAME_PAIR_RE, readSnapshots, withSnapshots } = await import("../../../scripts/hunt-messages-sync.mjs");
  assert.equal(NAME_PAIR_RE.test("Alex Doe and Sam Rivera"), true);
  assert.equal(NAME_PAIR_RE.test("Ann Lee <> Acme"), true);
  assert.equal(NAME_PAIR_RE.test("Quick question about the role"), false);
  const row = toRow({ threadId: "i", from: "jordan@example-recruiting.test", subject: "Invitation: Alex Doe and Jordan Lee @ Mon Nov 23", lastDate: "2026-11-10T00:00:00Z", messageCount: null, snippet: "" }, new Map());
  assert.equal(row.meeting, true);
  assert.equal(row.messageCount, undefined, "null messageCount is dropped, not shown");
  assert.equal(webNeedsReply(row, Date.parse("2026-11-21T00:00:00Z")), false);
  // snapshots: live wins; older than 14 days fades out
  const now = Date.parse("2026-11-21T12:00:00Z");
  const merged = withSnapshots([{ threadId: "a", lastDate: "2026-11-21", subject: "live" }], [{ threadId: "a", lastDate: "2026-11-21", subject: "snap" }, { threadId: "b", lastDate: "2026-11-20" }, { threadId: "c", lastDate: "2026-10-01" }], now);
  assert.deepEqual(merged.map((t) => `${t.threadId}:${t.subject ?? ""}`), ["a:live", "b:"]);
  assert.deepEqual(readSnapshots("/nonexistent-root"), []);
});

test("rules: state paid-leave / unemployment mail is other, even when it says application", () => {
  assert.equal(classifyByRules(msg({ from: "NoReply-PaidLeave@paidleave.example.gov", fromName: "noreplypaidleave", subject: "Your Paid Leave benefit application status has changed" })).kind, "other");
  assert.equal(classifyByRules(msg({ from: "notices@paidleave.example.gov", subject: "Interview scheduled for your claim" })).kind, "other");
  assert.equal(classifyByRules(msg({ fromName: "Pat", subtitle: "Talent Partner at Acme", subject: "Paid leave policy at Acme" })).kind, "recruiter");
});
