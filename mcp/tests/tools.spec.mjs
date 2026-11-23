import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkspace, startFakeDashboard, callTool, HOME_FIXTURE } from "./helpers.mjs";
import { jobId } from "../src/data.mjs";

let ws, dash, config;
before(async () => { ws = makeWorkspace(); dash = await startFakeDashboard(ws.root); config = ws.configFor(dash.port); });
after(async () => { await dash.close(); ws.cleanup(); });

const tracker = () => fs.readFileSync(path.join(ws.root, "data", "applications.md"), "utf8");
const row = (n) => tracker().split("\n").find((l) => l.startsWith(`| ${n} |`));

test("search_jobs: dedupe leaders only, true-rank order, compact fields", async () => {
  const { value, isError } = await callTool(config, "search_jobs", {});
  assert.equal(isError, false);
  assert.equal(value.total, 4); // globex/2b is a non-leader
  assert.deepEqual(value.jobs.map((j) => j.company), ["Acme Robotics", "Globex", "Hooli", "Vandelay Industries"]);
  const acme = value.jobs[0];
  assert.equal(acme.id, jobId("https://jobs.example.com/acme/1"));
  assert.equal(acme.true_rank, 1);
  assert.equal(acme.base, "$180k–$240k");
  assert.equal(acme.tc_est, "$310k (medium)");
  assert.equal(acme.status, "Interview");
  assert.equal(value.jobs[1].dupes, 1);
  assert.equal(value.jobs[2].status, "Inbox");
});

test("search_jobs: filters and sorts", async () => {
  let r = await callTool(config, "search_jobs", { query: "seattle", min_quick_score: 4 });
  assert.deepEqual(r.value.jobs.map((j) => j.company), ["Acme Robotics", "Hooli"]);
  r = await callTool(config, "search_jobs", { status: "inbox" });
  assert.deepEqual(r.value.jobs.map((j) => j.company).sort(), ["Hooli", "Vandelay Industries"]);
  r = await callTool(config, "search_jobs", { company: "globex", include_duplicates: true });
  assert.equal(r.value.total, 2);
  r = await callTool(config, "search_jobs", { sort: "newest", limit: 1 });
  assert.equal(r.value.jobs[0].company, "Vandelay Industries");
  r = await callTool(config, "search_jobs", { sort: "pay", limit: 1 });
  assert.equal(r.value.jobs[0].company, "Acme Robotics");
  r = await callTool(config, "search_jobs", { location: "new york" });
  assert.deepEqual(r.value.jobs.map((j) => j.company), ["Vandelay Industries"]);
});

test("search_jobs: limit is capped at 50 by the schema", async () => {
  await assert.rejects(callTool(config, "search_jobs", { limit: 51 }));
});

test("get_job: by id, by URL and by tracker number", async () => {
  const id = jobId("https://jobs.example.com/acme/1");
  const { value } = await callTool(config, "get_job", { id });
  assert.equal(value.company, "Acme Robotics");
  assert.equal(value.pay.tc_est.confidence, "medium");
  assert.equal(value.pay.tc_est.source, "levels.fyi-style estimate");
  assert.equal(value.scores.quick_score, 5);
  assert.equal(value.evaluation.decision, "Apply");
  assert.equal(value.tracker.n, "1");
  assert.equal(value.tracker.next_step, "recruiter call 2026-11-20");
  const byUrl = await callTool(config, "get_job", { id: "https://boards.example.com/globex/2" });
  assert.equal(byUrl.value.dedupe_group.members.length, 1);
  assert.equal(byUrl.value.dedupe_group.members[0].title, "Staff Platform Engineer (Infra)");
  const byN = await callTool(config, "get_job", { id: "#2" });
  assert.equal(byN.value.company, "Globex");
  const missing = await callTool(config, "get_job", { id: "jnothere" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /No job/);
});

test("list_tracker: rows past Evaluated with next step, next date and interview dates", async () => {
  const { value } = await callTool(config, "list_tracker", {});
  assert.deepEqual(value.entries.map((e) => e.n).sort(), ["1", "2", "4"]);
  const acme = value.entries.find((e) => e.n === "1");
  assert.equal(acme.status, "Interview");
  assert.equal(acme.next_step, "recruiter call 2026-11-20");
  assert.equal(acme.next_date, "2026-11-20");
  assert.equal(acme.applied, "2026-11-02");
  const only = await callTool(config, "list_tracker", { status: "applied" });
  assert.deepEqual(only.value.entries.map((e) => e.n), ["2"]);
});

test("update_tracker: rejects statuses the dashboard does not know, before writing", async () => {
  const before = tracker();
  const n = dash.calls.length;
  const r = await callTool(config, "update_tracker", { id: "2", status: "Ghosted" });
  assert.equal(r.isError, true);
  assert.match(r.text, /not a dashboard status.*Applied.*Interview/);
  assert.equal(dash.calls.length, n);
  assert.equal(tracker(), before);
});

test("update_tracker: validation errors for dates, notes and empty updates", async () => {
  for (const [args, re] of [
    [{ id: "2", next_date: "2026-13-01" }, /next_date/],
    [{ id: "2", interview_date: "tomorrow" }, /interview_date/],
    [{ id: "2", append_note: "a | b" }, /can't contain \|/],
    [{ id: "2" }, /Nothing to update/],
    [{ id: "3x", status: "Applied" }, /not a tracker row/],
  ]) {
    const r = await callTool(config, "update_tracker", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re);
  }
});

test("update_tracker: status alias goes through /api/status and is canonicalized", async () => {
  const r = await callTool(config, "update_tracker", { id: "2", status: "screening" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.value.entry.status, "Assessment");
  assert.match(row(2), /\| Assessment \|/);
  assert.deepEqual(dash.calls.at(-1).body, { n: "2", status: "Assessment" });
});

test("update_tracker: append_note adds a dated note and keeps the old notes", async () => {
  const r = await callTool(config, "update_tracker", { id: "2", append_note: "Sent thank-you\nnote" });
  assert.equal(r.isError, false, r.text);
  assert.match(row(2), /applied 2026-11-04; \d{4}-\d{2}-\d{2}: Sent thank-you note \|/);
});

test("update_tracker: next_step replaces the old Next note; next_date and interview_date", async () => {
  let r = await callTool(config, "update_tracker", { id: "1", next_step: "send availability", next_date: "2026-11-24" });
  assert.equal(r.isError, false, r.text);
  assert.ok(row(1).includes("Next: send availability 2026-11-24"));
  assert.ok(!row(1).includes("recruiter call 2026-11-20"));
  assert.ok(row(1).includes("applied 2026-11-02"));
  r = await callTool(config, "update_tracker", { id: "1", next_date: "2026-11-25" });
  assert.ok(row(1).includes("Next: send availability 2026-11-25"), row(1));
  r = await callTool(config, "update_tracker", { id: "1", interview_date: "2026-11-23 10:30" });
  assert.ok(row(1).includes("Interview: Mon 2026-11-23 10:30"), row(1));
  const list = await callTool(config, "list_tracker", {});
  const acme = list.value.entries.find((e) => e.n === "1");
  assert.equal(acme.next_date, "2026-11-25");
  assert.deepEqual(acme.interview_dates, ["Interview: Mon 2026-11-23 10:30"]);
  assert.match(row(1), /\| Interview \|/); // status untouched
});

test("list_followups and mark_followup round-trip through /api/profile/marks", async () => {
  const { value } = await callTool(config, "list_followups", {});
  assert.ok(value.needing_action >= 1, JSON.stringify(value));
  const first = value.followups[0];
  assert.ok(first.id && first.title);
  const r = await callTool(config, "mark_followup", { id: first.id, mark: "ignored" });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(dash.calls.at(-1).body.mark, "wont");
  const marks = JSON.parse(fs.readFileSync(path.join(ws.root, "data", "message-marks.json"), "utf8"));
  assert.equal(marks.marks[`opp:${first.id}`].mark, "wont");
  const after = await callTool(config, "list_followups", {});
  assert.ok(!after.value.followups.some((f) => f.id === first.id));
  const all = await callTool(config, "list_followups", { include_done: true });
  assert.equal(all.value.followups.find((f) => f.id === first.id).mark, "ignored");
  await callTool(config, "mark_followup", { id: first.id, mark: "clear" });
  const back = await callTool(config, "list_followups", {});
  assert.ok(back.value.followups.some((f) => f.id === first.id));
  const bad = await callTool(config, "mark_followup", { id: "nope", mark: "done" });
  assert.equal(bad.isError, true);
});

test("get_study_today and complete_study_task", async () => {
  const { value } = await callTool(config, "get_study_today", {});
  assert.equal(value.day.n, 1);
  assert.equal(value.tasks.length, 3);
  assert.ok(value.tasks.every((t) => t.done === false));
  for (const t of value.tasks) {
    const r = await callTool(config, "complete_study_task", { id: t.id });
    assert.equal(r.isError, false, r.text);
  }
  const next = await callTool(config, "get_study_today", {});
  assert.equal(next.value.day.n, 2); // day 1 done, day 2 is today
  assert.equal(next.value.progress, "1 of 2 days done");
  const undo = await callTool(config, "complete_study_task", { id: value.tasks[0].id, done: false });
  assert.equal(undo.value.today.day.n, 1);
  const bad = await callTool(config, "complete_study_task", { id: "zzzz" });
  assert.equal(bad.isError, true);
});

test("add_job_by_url: new, matched and need_details", async () => {
  let r = await callTool(config, "add_job_by_url", { url: "https://jobs.example.com/newco/10" });
  assert.equal(r.value.result, "new");
  assert.equal(r.value.id, jobId("https://jobs.example.com/newco/10"));
  r = await callTool(config, "add_job_by_url", { url: "https://jobs.example.com/acme/1" });
  assert.equal(r.value.result, "matched");
  assert.equal(r.value.existing.company, "Acme Robotics");
  assert.equal(r.value.existing.id, jobId("https://jobs.example.com/acme/1"));
  r = await callTool(config, "add_job_by_url", { url: "https://www.linkedin.com/jobs/view/1" });
  assert.equal(r.value.result, "need_details");
  await assert.rejects(callTool(config, "add_job_by_url", { url: "not a url" }));
});

test("get_summary: needs / in flight / new come from the dashboard's /api/profile/home", async () => {
  const before = dash.calls.length;
  const { text, isError } = await callTool(config, "get_summary", {});
  assert.equal(isError, false);
  const homeCalls = dash.calls.slice(before);
  assert.deepEqual(homeCalls.map((c) => `${c.method} ${c.url}`), ["GET /api/profile/home"]);
  assert.match(text, /^Needs you \(2\):\n- Acme Robotics · Senior Backend Engineer — Interview with no next step set\n- Sam Sample · Globex — You owe a reply\n/);
  assert.match(text, /\nIn flight \(2\): Interview 1, Applied 1\n/);
  assert.match(text, /- #1 Acme Robotics · Senior Backend Engineer \(Interview; next: Acme onsite \(via Paraform\) Tue 11\/24 1:00 PM PT\)/);
  assert.match(text, /- #2 Globex · Platform Engineer \(Applied\)\n/);
  assert.match(text, /Today's study: /); // still read locally
  assert.match(text, new RegExp(`New since last look \\(1\\):\\n- #3 Hooli · Staff Engineer \\[${jobId("https://jobs.example.com/hooli/3")}\\]`));
  assert.match(text, /· 1 in inbox · \$0\.00 AI usage, last 7 days/);
  assert.ok(text.split("\n").length <= 30);
});

test("get_summary: an empty Home reads as nothing right now", async () => {
  dash.setHome({ needs: [], inFlight: [], opportunities: [] });
  try {
    const { text, isError } = await callTool(config, "get_summary", {});
    assert.equal(isError, false);
    assert.match(text, /^Needs you \(0\): nothing right now\nIn flight \(0\)\n/);
    assert.match(text, /New since last look \(0\)\n/);
  } finally { dash.setHome({ ...HOME_FIXTURE }); }
});

test("get_summary: a failing /api/profile/home is a clear error, with no fallback", async () => {
  try {
    dash.setHome({ status: 500, body: "boom" });
    let r = await callTool(config, "get_summary", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /me dashboard's \/api\/profile\/home failed: HTTP 500, not JSON/);
    assert.ok(!/Needs you/.test(r.text));
    dash.setHome({ needs: "nope" });
    r = await callTool(config, "get_summary", {});
    assert.equal(r.isError, true);
    assert.match(r.text, /unexpected shape/);
  } finally { dash.setHome({ ...HOME_FIXTURE }); }
  const down = await callTool(ws.configFor(1), "get_summary", {});
  assert.equal(down.isError, true);
  assert.match(down.text, /me dashboard \(http:\/\/127\.0\.0\.1:1\) is not answering \(GET \/api\/profile\/home\)/);
});

test("profile errors surface as tool errors", async () => {
  const r = await callTool(config, "search_jobs", { profile: "partner" });
  assert.equal(r.isError, true);
  assert.match(r.text, /inactive/);
  const u = await callTool(config, "get_summary", { profile: "zed" });
  assert.match(u.text, /Unknown profile/);
});

test("writes fail cleanly when the dashboard is down", async () => {
  const down = ws.configFor(1); // nothing listens on port 1
  const r = await callTool(down, "complete_study_task", { id: (await callTool(config, "get_study_today", {})).value.tasks[0].id });
  assert.equal(r.isError, true);
  assert.match(r.text, /not answering; nothing was changed/);
});
