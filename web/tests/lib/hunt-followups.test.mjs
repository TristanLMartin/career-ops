// hunt: Follow-ups merge (one row per opportunity), next step wording and ordering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpportunities, domainWord, normName, scheduledCall, whenLabel } from "../../src/lib/hunt-followups.mjs";

const now = Date.parse("2026-11-21T20:00:00Z");
const row = (n, company, status, notes = "", next = "") => ({ n: String(n), company, role: "Senior Engineer", status, notes, next, url: "", updated: "2026-11-20" });
const th = (o) => ({ id: o.id, name: o.name, from: o.from ?? "", company: o.company ?? null, date: o.date, lastFromMe: !!o.mine, owe: !!o.owe, kind: o.kind ?? "recruiter", href: o.href ?? `https://mail.google.com/mail/u/0/#all/${o.id}`, snippet: o.snippet ?? "", about: o.about ?? "", automated: false });

const tracker = [
  row(151, "Brightloop", "Interview", "Recruiter screen scheduled Mon 2026-11-23 10:30-11:00 AM PT by phone, agency recruiter Jordan Lee (Example Recruiting)", "Recruiter call Mon 11/23 10:30"),
  row(435, "Vectorly", "Interview", "Agency recruiter Morgan Ellis (Paraform), intro call scheduled Tue 2026-11-24 1:00-1:20 PM PT", "Intro call Tue 11/24 1:00, find out which company"),
  row(436, "Acme Health", "Responded", "Recruiter Sam Rivera (Example Staffing), intro pending", "Waiting on Sam for the intro"),
  row(437, "Globex Foods", "Responded", "Recruiter Sam Rivera (Example Staffing), intro pending", "Waiting on Sam for the intro"),
  row(55, "Contoso", "Interview", "Technical screen scheduled via recruiter", "Waiting on loop scheduling, nudge Blake"),
];
const threads = [
  th({ id: "li-jordan", name: "Jordan Lee", company: "Brightloop", date: "2026-11-18T00:00:00Z", mine: true, href: "https://www.linkedin.com/messaging/thread/x/", about: "LinkedIn" }),
  th({ id: "jordan-inv", name: "jordan", from: "jordan@example-recruiting.test", date: "2026-11-21T19:22:00Z", snippet: "Invitation: Alex Doe and Jordan Lee @ Mon Nov 23" }),
  th({ id: "li-jon", name: "Morgan Ellis", company: "Vectorly", date: "2026-11-19T00:00:00Z", mine: true }),
  th({ id: "gm", name: "samrivera", from: "samrivera@examplestaffing.com", date: "2026-11-21T19:13:48Z", mine: true }),
  th({ id: "li-sam", name: "Sam Rivera", date: "2026-11-21T16:46:31Z", mine: true, about: "LinkedIn" }),
  th({ id: "bj", name: "bnguyen", from: "bnguyen@contoso.com", date: "2026-11-13T16:30:45Z", mine: true }),
  th({ id: "ad", name: "v-priyadas", from: "v-priyadas@contoso.com", date: "2026-11-14T01:48:08Z", owe: true }),
  th({ id: "leo", name: "Chris Park", date: "2026-11-10T00:00:00Z", owe: true, kind: "other" }),
];
const contacts = { "bnguyen@contoso.com": { name: "Blake Nguyen", role: "Recruiter", company: "Contoso" }, "v-priyadas@contoso.com": { name: "Priya", role: "Scheduling coordinator", company: "Contoso" } };
const entries = [{ num: 55, nextFollowupDate: "2026-11-14" }];

test("names normalize: an address local part and a display name are one person", () => {
  assert.equal(normName("samrivera"), normName("Sam Rivera via LinkedIn"));
  assert.equal(domainWord("v-priyadas@email.careers.contoso.com"), "contoso");
  assert.equal(domainWord("samrivera@examplestaffing.com"), "examplestaffing");
});

test("one row per opportunity: people fold into their tracker rows; an agency recruiter's rows become one", () => {
  const opps = buildOpportunities({ entries, tracker, threads, contacts, now });
  const by = Object.fromEntries(opps.map((o) => [o.title, o]));
  assert.deepEqual(Object.keys(by).sort(), ["Example Staffing: Acme Health, Globex Foods", "Vectorly", "Chris Park", "Contoso", "Brightloop"].sort());
  assert.deepEqual(by.Brightloop.threads.map((t) => t.id).sort(), ["jordan-inv", "li-jordan"]);
  assert.deepEqual(by.Vectorly.people.map((p) => p.name), ["Morgan Ellis"]);
  assert.deepEqual(by["Example Staffing: Acme Health, Globex Foods"].rows.map((r) => r.n), ["436", "437"]);
  assert.equal(by["Example Staffing: Acme Health, Globex Foods"].threads.length, 2, "both Sam threads, one person");
  assert.deepEqual(by.Contoso.people.map((p) => `${p.name}/${p.role}`).sort(), ["Blake Nguyen/Recruiter", "Priya/Scheduling coordinator"]);
  assert.equal(by["Chris Park"].other, true, "non-job mail hides behind Show others");
});

test("next step wording: calls are scheduled (not overdue); a tracker next step beats an old owed thread", () => {
  const by = Object.fromEntries(buildOpportunities({ entries, tracker, threads, contacts, now }).map((o) => [o.title, o]));
  assert.equal(by.Brightloop.line2, "Call · Mon 11/23 10:30 AM");
  assert.equal(by.Brightloop.state, "scheduled");
  assert.equal(by.Vectorly.line2, "Call · Tue 11/24 1:00 PM");
  assert.equal(by.Contoso.line2, "Waiting on loop scheduling, nudge Blake");
  assert.equal(by.Contoso.state, "overdue");
  assert.equal(whenLabel(by.Contoso), "overdue since Nov 14");
  assert.equal(by["Example Staffing: Acme Health, Globex Foods"].line2, "Waiting on Sam for the intro");
  assert.equal(whenLabel(by["Example Staffing: Acme Health, Globex Foods"]), "check Nov 26");
});

test("order: overdue, then today, then scheduled calls, then upcoming", () => {
  const order = buildOpportunities({ entries, tracker, threads, contacts, now }).filter((o) => !o.other).map((o) => o.title);
  assert.deepEqual(order, ["Contoso", "Brightloop", "Vectorly", "Example Staffing: Acme Health, Globex Foods"]);
});

test("scheduledCall reads the date and time from the row notes", () => {
  assert.deepEqual(scheduledCall(tracker[0], now), { label: "Mon 11/23 10:30 AM", day: "2026-11-23" });
  assert.equal(scheduledCall(row(1, "X", "Applied", "applied via Workday", ""), now), null);
});
