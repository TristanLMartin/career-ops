// Tests for the web additions: sort pref, messages grouping, Today summary.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_HUNT_SORT, orderByRank, parseHuntSort, readHuntSort, writeHuntSort, readRankKey } from "../../src/lib/hunt-sort-pref.mjs";
import { dedupeLinkedInPeople, groupMessages, needsReply, normCompany, orderReplies } from "../../src/lib/hunt-messages-view.mjs";
import { ageLabel, newRolesSince, notScoredYet, statusCounts, topPicks } from "../../src/lib/hunt-home.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-21T01:00:00Z");

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("Rank is the default sort and unknown values fall back to it", () => {
  assert.equal(DEFAULT_HUNT_SORT, "rank");
  assert.equal(parseHuntSort("newest"), "newest");
  assert.equal(parseHuntSort("bogus"), "rank");
  assert.equal(readHuntSort(null), "rank");
  const s = memoryStorage();
  assert.equal(writeHuntSort(s, "fit"), true);
  assert.equal(readHuntSort(s), "fit");
  assert.equal(writeHuntSort(s, "bogus"), false);
  assert.equal(readRankKey(memoryStorage({ "hunt:inbox-rank-key": "pay" })), "pay");
  assert.equal(readRankKey(memoryStorage({ "hunt:inbox-rank-key": "level" })), "level");
  assert.equal(readRankKey(memoryStorage({ "hunt:inbox-rank-key": "x" })), "true"); // True rank is the default on purpose
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readHuntSort(throwing), "rank");
  assert.equal(writeHuntSort(throwing, "fit"), false);
});

test("orderByRank: highest first, unranked keep incoming order at the end", () => {
  const rows = [{ id: "a", v: null }, { id: "b", v: 50 }, { id: "c", v: 90 }, { id: "d", v: null }, { id: "e", v: 50 }];
  assert.deepEqual(orderByRank(rows, (r) => r.v).map((r) => r.id), ["c", "b", "e", "a", "d"]);
});

const fixture = readFileSync(join(here, "..", "fixtures", "hunt-messages.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("needsReply: not from me and older than 24h", () => {
  const byId = Object.fromEntries(fixture.map((m) => [m.threadId.slice(-1), m]));
  assert.equal(needsReply(byId["1"], NOW), true, "Stripe recruiter, 3 days old");
  assert.equal(needsReply(byId["2"], NOW), false, "last message is mine");
  assert.equal(needsReply(byId["4"], NOW), false, "only 2 hours old");
  assert.equal(needsReply({ ...byId["1"], automated: true }, NOW), false, "automated senders never need a reply");
});

test("groupMessages: by company, needs-reply first, linked to tracker and inbox", () => {
  const apps = [{ n: "2", company: "Stripe", role: "Backend / API Engineer, Radar", status: "Evaluated" }, { n: "1", company: "OpenAI", role: "FDE", status: "Evaluated" }];
  const inbox = [{ company: "Stripe" }, { company: "Stripe" }, { company: "Affirm" }];
  const groups = groupMessages(fixture, apps, inbox, NOW);
  assert.deepEqual(groups.map((g) => g.company), ["Stripe", "Unknown company", "Affirm", "OpenAI"]);
  const stripe = groups[0];
  assert.equal(stripe.needsReply, 1);
  assert.deepEqual(stripe.tracker.map((a) => a.n), ["2"]);
  assert.equal(stripe.inboxRoles, 2);
  assert.equal(normCompany("Stripe, Inc."), "stripe");
});

test("topPicks: scored only, fit >= 3.8, level >= 0.7 unless fit >= 4.0, skip/closed out, 3 per company", () => {
  const j = (company, fit, composite, extra = {}) => ({ company, fit, composite, level: { factor: 1 }, ...extra });
  const jobs = {
    a1: j("A", 4.5, 90), a2: j("A", 4.4, 89), a3: j("A", 4.3, 88), a4: j("A", 4.2, 87),
    b1: j("B", 3.7, 99), c1: j("C", 4.6, 95, { level: { factor: 0.45 } }), d1: j("D", null, 100),
    e1: j("E", 4.0, 70), f1: j("F", 4.1, 80, { status: "Rejected" }), g1: j("G", 4.1, 79, { report: { decision: "Skip" } }),
  };
  assert.deepEqual(topPicks(jobs).map((p) => p.url), ["c1", "a1", "a2", "a3", "e1"]); // c1: level 0.45 but fit 4.6 always shows
  assert.deepEqual(topPicks(jobs, { per_company: 1 }).map((p) => p.url), ["c1", "a1", "e1"]);
  assert.deepEqual(topPicks({ s: j("S", 3.9, 99, { level: { factor: 0.45 } }) }), [], "below 4.0 the level gate still applies");
  assert.deepEqual(notScoredYet({ x: { fit: null, source: "inbox", composite: 50 }, y: { fit: null, source: "inbox", composite: 70 }, z: { fit: 4, source: "inbox", composite: 99 } }).map((p) => p.url), ["y", "x"]);
});

test("statusCounts, newRolesSince (backfill excluded), ageLabel", () => {
  assert.deepEqual(statusCounts([{ status: "Applied" }, { status: "Evaluated" }, { status: "Evaluated" }]), [["Evaluated", 2], ["Applied", 1]]);
  const tsv = "timestamp\tstatus\tnew_added\n2026-11-21T00:41:47Z\tcompleted\t725\n2026-11-21T14:15:00Z\tcompleted\t6\n2026-11-20T10:00:00Z\tcompleted\t0\n";
  // the earliest run (2026-11-20T10:00) is the backfill, so 725 + 6 count when inside the window
  assert.deepEqual(newRolesSince(tsv, Date.parse("2026-11-21T15:00:00Z")), { newRoles: 731, backfillOnly: false });
  assert.deepEqual(newRolesSince("timestamp\tnew_added\n2026-11-21T00:41:47Z\t725\n", Date.parse("2026-11-21T02:00:00Z")), { newRoles: 0, backfillOnly: true });
  assert.equal(ageLabel("2026-11-19T01:00:00Z", NOW), "2 days ago");
});

test("orderReplies: manual unanswered rows always count; high priority first, then oldest", () => {
  const rows = [
    { threadId: "1", fromName: "Low", priority: "low", needsReplyOverride: true, lastFromMe: false, date: "2026-09-01T12:00:00Z" },
    { threadId: "2", fromName: "High new", priority: "high", needsReplyOverride: true, lastFromMe: false, date: "2026-11-20T23:00:00Z" },
    { threadId: "3", fromName: "High old", priority: "high", needsReplyOverride: true, lastFromMe: false, date: "2026-11-02T12:00:00Z" },
    { threadId: "4", fromName: "Feed", lastFromMe: false, date: "2026-11-10T12:00:00Z" },
    { threadId: "5", fromName: "Answered", lastFromMe: true, needsReplyOverride: true, date: "2026-11-10T12:00:00Z" },
  ];
  assert.deepEqual(orderReplies(rows, NOW).map((m) => m.fromName), ["High old", "High new", "Feed", "Low"]);
});

test("dedupeLinkedInPeople keeps the manual row when the feed has the same person", () => {
  const feed = { threadId: "g1", fromName: "Alice Kallaugher", replyVia: "linkedin", date: "2026-11-21T01:08:59Z" };
  const manual = { threadId: "linkedin:abc", source: "linkedin-manual", fromName: "Alice Kallaugher", replyVia: "linkedin", link: "https://www.linkedin.com/messaging/thread/abc/" };
  const other = { threadId: "g2", fromName: "Jordan", from: "jordan@stripe.com" };
  assert.deepEqual(dedupeLinkedInPeople([feed, manual, other]).map((m) => m.threadId), ["linkedin:abc", "g2"]);
  assert.deepEqual(dedupeLinkedInPeople([feed, other]).map((m) => m.threadId), ["g1", "g2"], "no manual row: feed row stays");
});
