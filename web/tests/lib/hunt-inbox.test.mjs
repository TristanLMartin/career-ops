// hunt: Inbox classification (Needs my reply / Waiting on them / Done), lib/hunt-inbox.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { atsActionAsk, classifyInbox, inboxSections, meetingTime, needsYouFromInbox, rowActions } from "../../src/lib/hunt-inbox.mjs";
import { buildOpportunities } from "../../src/lib/hunt-followups.mjs";

const NOW = Date.parse("2026-11-21T18:00:00");
const iso = (s) => new Date(Date.parse(s)).toISOString();
const thread = (o) => ({ id: o.id ?? "t1", name: "Jordan Lee", date: iso("2026-11-20T10:00:00"), snippet: "", lastFromMe: false, href: "https://mail.google.com/x", linkedin: false, answeredVia: null, kind: "recruiter", automated: false, meeting: false, subject: "", archived: false, ...o });
const opp = (o) => ({ key: "k1", title: "Acme", company: "Acme", rows: [], people: [{ name: "Jordan Lee", role: "Recruiter" }], threads: [], mark: null, call: null, cadenceDue: null, ...o });
const one = (o) => classifyInbox([opp(o)], { now: NOW })[0];

test("last message from them needs a reply, with how long it has waited", () => {
  const i = one({ threads: [thread({ date: iso("2026-11-19T18:00:00") })] });
  assert.equal(i.section, "needs");
  assert.equal(i.action, "Reply to Jordan");
  assert.equal(i.when, "waiting 2d");
});

test("last message from me waits on them, with a check-back date", () => {
  const i = one({ threads: [thread({ lastFromMe: true, date: iso("2026-11-20T10:00:00") })] });
  assert.equal(i.section, "waiting");
  assert.equal(i.action, "Waiting on Jordan");
  assert.equal(i.when, "check Nov 25");
});

test("a calendar invite with a time is scheduled, not a reply owed", () => {
  const i = one({ threads: [thread({ meeting: true, subject: "Invitation: Alex Doe and Jordan Lee @ Mon Nov 23, 2026 10:30am - 11am (PST)" })] });
  assert.equal(i.section, "waiting");
  assert.equal(i.action, "Call Mon 10:30 AM");
  assert.equal(i.when, "Nov 23");
});

test("an interview invite reads as an interview", () => {
  const i = one({ threads: [thread({ meeting: true, subject: "Invitation from an unknown sender: Interview with Whatnot @ Mon Nov 23, 2026 12:30pm - 1pm (PST)" })] });
  assert.equal(i.action, "Interview Mon 12:30 PM");
});

test("a call scheduled in the tracker notes is waiting, sorted before plain waiting rows", () => {
  const items = inboxSections([
    opp({ key: "w", title: "Waiting Co", threads: [thread({ lastFromMe: true })] }),
    opp({ key: "c2", title: "Later Call", call: { label: "Tue 11/24 1:00 PM", day: "2026-11-24" }, rows: [{ n: "2", company: "Later Call", role: "SWE", status: "Interview", next: "Call Tue" }] }),
    opp({ key: "c1", title: "Soon Call", call: { label: "Mon 11/23 10:30 AM", day: "2026-11-23" }, rows: [{ n: "1", company: "Soon Call", role: "SWE", status: "Responded", next: "Call Mon" }] }),
  ], { now: NOW });
  assert.deepEqual(items.waiting.map((i) => i.key), ["c1", "c2", "w"]);
  assert.equal(items.waiting[0].action, "Call Mon 10:30 AM");
});

test("a passed check-back date moves the row to needs as a nudge", () => {
  const i = one({ threads: [thread({ lastFromMe: true, date: iso("2026-11-10T10:00:00") })] });
  assert.equal(i.section, "needs");
  assert.equal(i.action, "Nudge Jordan");
  assert.match(i.when, /^\d+d overdue$/);
});

test("a cadence date that has passed is a nudge even with no thread", () => {
  const i = one({ people: [], rows: [{ n: "5", company: "Acme", role: "SWE", status: "Applied", next: "" }], cadenceDue: "2026-11-18" });
  assert.equal(i.section, "needs");
  assert.equal(i.action, "Nudge Acme");
  assert.equal(i.when, "3d overdue");
});

test("a tracker next step he owns that is due is in needs", () => {
  const i = one({ rows: [{ n: "7", company: "Acme", role: "SWE", status: "Responded", next: "Send portfolio Nov 21" }], threads: [thread({ lastFromMe: true })] });
  assert.equal(i.section, "needs");
  assert.equal(i.action, "Send portfolio Nov 21");
  assert.equal(i.when, "due today");
});

test("an interview with no time set needs him", () => {
  const i = one({ people: [], rows: [{ n: "8", company: "Acme", role: "SWE", status: "Interview", next: "" }] });
  assert.equal(i.section, "needs");
  assert.equal(i.action, "Set the interview time");
});

test("Done / Ignore, other mail and automated-only threads go to done", () => {
  assert.equal(one({ mark: { mark: "done", at: "", lastDate: "" }, threads: [thread({})] }).section, "done");
  assert.equal(one({ mark: { mark: "wont", at: "", lastDate: "" }, threads: [thread({})] }).action, "Ignored");
  assert.equal(one({ other: true, threads: [thread({ kind: "other" })] }).section, "done");
  assert.equal(one({ threads: [thread({ automated: true })] }).section, "done");
  // a thread he marked one by one no longer counts as owed
  assert.equal(one({ threads: [thread({ archived: true })] }).section, "done");
});

test("needs sorts most overdue first", () => {
  const s = inboxSections([
    opp({ key: "new", title: "New", threads: [thread({ date: iso("2026-11-21T09:00:00") })] }),
    opp({ key: "old", title: "Old", threads: [thread({ date: iso("2026-11-15T09:00:00") })] }),
    opp({ key: "mid", title: "Mid", threads: [thread({ lastFromMe: true, date: iso("2026-11-12T09:00:00") })] }),
  ], { now: NOW });
  assert.deepEqual(s.needs.map((i) => i.key), ["old", "mid", "new"]);
});

test("no item is in two sections, and every item is in one", () => {
  const opps = [
    opp({ key: "a", threads: [thread({})] }),
    opp({ key: "b", threads: [thread({ lastFromMe: true })] }),
    opp({ key: "c", threads: [thread({ meeting: true, subject: "Invitation: X @ Mon Nov 23, 2026 1pm - 2pm (PST)" })] }),
    opp({ key: "d", mark: { mark: "done", at: "", lastDate: "" } }),
    opp({ key: "e", rows: [{ n: "1", company: "E", role: "R", status: "Interview", next: "" }], people: [] }),
    opp({ key: "f", threads: [thread({ lastFromMe: true, date: iso("2026-11-01T00:00:00") })] }),
  ];
  const s = inboxSections(opps, { now: NOW });
  const keys = [...s.needs, ...s.waiting, ...s.done].map((i) => i.key);
  assert.equal(keys.length, opps.length);
  assert.equal(new Set(keys).size, opps.length);
});

test("end to end from buildOpportunities: the same person's threads make one item", () => {
  const threads = [
    { id: "g1", from: "jordan@integra.com", name: "Jordan Lee", company: "Integra", date: iso("2026-11-20T10:00:00"), lastFromMe: false, owe: false, kind: "recruiter", snippet: "Can you share times?", href: "https://mail.google.com/1", meeting: false, subject: "Next steps" },
    { id: "g2", from: "jordan@integra.com", name: "Jordan Lee", company: "Integra", date: iso("2026-11-18T10:00:00"), lastFromMe: true, owe: false, kind: "recruiter", snippet: "Thanks!", href: "https://mail.google.com/2", meeting: false, subject: "Intro" },
    { id: "o1", from: "pal@friends.com", name: "Pal", company: null, date: iso("2026-11-20T10:00:00"), lastFromMe: false, owe: true, kind: "other", snippet: "lunch?", href: "https://mail.google.com/3" },
  ];
  const opps = buildOpportunities({ threads, now: NOW, keepAll: true });
  const s = inboxSections(opps, { now: NOW });
  assert.equal(s.needs.length, 1);
  assert.equal(s.needs[0].action, "Reply to Jordan");
  assert.equal(s.done.length, 1); // the friend's mail
  assert.equal(s.waiting.length, 0);
});

test("meetingTime parses calendar subjects", () => {
  assert.deepEqual(meetingTime("Invitation: A @ Tue Nov 24, 2026 1pm - 1:20pm (PST)"), { day: "2026-11-24", label: "Tue 1:00 PM", at: "2026-11-24T13:00" });
  assert.equal(meetingTime("Meeting scheduled for Alex Doe <> Jordan Lee"), null);
});

test("Home needs rows keep the needsYou shape and point at the Inbox detail page", () => {
  const [n] = needsYouFromInbox([{ key: "pcasey", title: "Integra", action: "Reply to Jordan", when: "waiting 2d" }]);
  assert.deepEqual(Object.keys(n).sort(), ["action", "detail", "href", "id", "label", "sort"]);
  assert.equal(n.href, "/inbox/pcasey");
  assert.equal(n.detail, "Reply to Jordan · waiting 2d");
});

test("a future meeting keeps a Done-marked item in Waiting until the meeting time passes", () => {
  const o = { mark: { mark: "done", at: "", lastDate: "" }, call: { label: "Mon 11/23 10:30 AM", day: "2026-11-23" }, rows: [{ n: "151", company: "ShopMy", role: "SWE", status: "Interview", next: "" }] };
  const before = classifyInbox([opp(o)], { now: NOW })[0];
  assert.equal(before.section, "waiting");
  assert.equal(before.action, "Call Mon 10:30 AM");
  const after = classifyInbox([opp(o)], { now: Date.parse("2026-11-23T10:31:00") })[0];
  assert.equal(after.section, "done");
  // a calendar invite counts too
  const inv = one({ mark: { mark: "done", at: "", lastDate: "" }, threads: [thread({ meeting: true, subject: "Invitation: Alex Doe and Jordan Lee @ Mon Nov 23, 2026 10:30am - 11am (PST)" })] });
  assert.equal(inv.section, "waiting");
});

test("hiring-team mail from a tracked company asking for action is a job lead with an ask", () => {
  const t = { from: "no-reply@ashbyhq.com", name: "Whatnot Hiring Team", subject: "Whatnot Application Questionnaire", snippet: "please take two minutes to fill out the below application questionnaire", company: null };
  assert.deepEqual(atsActionAsk(t, ["Microsoft", "Whatnot", "ShopMy"]), { company: "Whatnot", ask: "Fill out Whatnot questionnaire" });
  // receipts ask nothing; untracked companies are left alone
  assert.equal(atsActionAsk({ ...t, subject: "Thank you for applying to Whatnot", snippet: "We received your application." }, ["Whatnot"]), null);
  assert.equal(atsActionAsk(t, ["Microsoft"]), null);
});

test("the ask joins the company's item and puts it in Needs, ahead of its interview", () => {
  const threads = [
    { id: "w1", from: "no-reply@ashbyhq.com", name: "Whatnot Hiring Team", company: "Whatnot", date: iso("2026-11-21T17:37:00"), lastFromMe: false, owe: false, kind: "job_lead", automated: false, ask: "Fill out Whatnot questionnaire", snippet: "fill out the questionnaire", href: "https://mail.google.com/w1" },
    { id: "w2", from: "alex.kim@whatnot.com", name: "Alex Kim", company: "Whatnot", date: iso("2026-11-21T17:36:00"), lastFromMe: false, owe: false, kind: "recruiter", meeting: true, subject: "Invitation: Interview with Whatnot @ Mon Nov 23, 2026 12:30pm - 1pm (PST)", snippet: "", href: "https://mail.google.com/w2" },
  ];
  const s = inboxSections(buildOpportunities({ threads, now: NOW, keepAll: true }), { now: NOW });
  assert.equal(s.needs.length, 1);
  assert.equal(s.waiting.length, 0);
  assert.equal(s.needs[0].action, "Fill out Whatnot questionnaire");
  assert.equal(s.needs[0].when, "before Mon interview");
  assert.equal(s.needs[0].scheduled.label, "Interview Mon 12:30 PM");
  assert.equal(s.needs[0].threads.length, 2);
});

test("a tracker next step set after their last message waits on that step", () => {
  const i = one({
    rows: [{ n: "55", company: "Microsoft", role: "SWE", status: "Interview", next: "Waiting on loop scheduling, nudge Brittany", updated: "2026-11-14" }],
    threads: [thread({ name: "Riley Chen", date: iso("2026-11-13T17:47:00") })],
  });
  assert.equal(i.section, "waiting");
  assert.equal(i.action, "Waiting on loop scheduling");
});

test("row buttons: Reply on Needs rows with a Gmail / LinkedIn thread, Job only when there is one", () => {
  const needs = { section: "needs", rows: [{ n: "55", url: "https://jobs/x" }], threads: [thread({ href: "https://mail.google.com/a" })] };
  assert.deepEqual(rowActions(needs), { reply: { href: "https://mail.google.com/a", label: "Reply" }, job: { href: "/pipeline/55", external: false } });
  const li = rowActions({ section: "needs", rows: [], threads: [thread({ href: "https://www.linkedin.com/messaging/thread/1", linkedin: true })] });
  assert.equal(li.reply.label, "Reply on LinkedIn");
  assert.equal(li.job, null);
  // Waiting rows get no Reply; a row with no thread link gets none either
  assert.equal(rowActions({ ...needs, section: "waiting" }).reply, null);
  assert.equal(rowActions({ section: "needs", rows: [], threads: [thread({ href: "" })] }).reply, null);
  // their message is the one to answer, not his own
  const both = rowActions({ section: "needs", rows: [], threads: [thread({ id: "m", lastFromMe: true, href: "https://mail.google.com/mine" }), thread({ id: "t", href: "https://mail.google.com/theirs" })] });
  assert.equal(both.reply.href, "https://mail.google.com/theirs");
});
