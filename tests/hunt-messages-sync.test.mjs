// Tests for scripts/hunt-messages-sync.mjs against a loopback
// server that answers like Apps Script: a 302 from /exec to a second path.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncMessages, toRow, parseFrom, guessCompany, trackedCompanies, needsReply } from "../scripts/hunt-messages-sync.mjs";

const KEY = "k3y-Very-Long-Secret-0123456789abcdef";
const NOW = Date.parse("2026-11-21T02:00:00Z");
const FEED = {
  ok: true,
  generatedAt: "2026-11-21T01:59:00Z",
  labels: ["Job Hunt/LinkedIn messages", "Job Hunt/Applications", "Job Hunt/Recruiters"],
  missingLabels: ["Job Hunt/Recruiters"],
  days: 60,
  threads: [
    { threadId: "19a8b4f0c0000001", labels: ["Job Hunt/Applications"], subject: "Radar: next steps", from: "Jordan Lee <jordan@stripe.com>", lastFrom: "Jordan Lee <jordan@stripe.com>", lastFromMe: false, to: "me@example.com", messageCount: 1, firstDate: "2026-11-17T18:20:00Z", lastDate: "2026-11-17T18:20:00Z", snippet: "Could you share a few times next week?", link: "https://mail.google.com/mail/u/0/#all/19a8b4f0c0000001" },
    { threadId: "19a8b4f0c0000002", labels: ["Job Hunt/Applications"], subject: "FDE, Seattle", from: "OpenAI Talent <talent@openai.com>", lastFrom: "Me <me@example.com>", lastFromMe: true, to: "talent@openai.com", messageCount: 3, firstDate: "2026-11-18T10:00:00Z", lastDate: "2026-11-19T22:05:00Z", snippet: "Sounds good, talk Thursday.", link: "https://mail.google.com/mail/u/0/#all/19a8b4f0c0000002" },
    { threadId: "19a8b4f0c0000003", labels: ["Job Hunt/LinkedIn messages"], subject: "Senior payments role", from: "Sam via LinkedIn <inmail-hit-reply@linkedin.com>", lastFrom: "Sam via LinkedIn <inmail-hit-reply@linkedin.com>", lastFromMe: false, to: "me@example.com", messageCount: 1, firstDate: "2026-11-21T01:00:00Z", lastDate: "2026-11-21T01:00:00Z", snippet: "Hi, a payments role at Affirm...", link: "https://mail.google.com/mail/u/0/#all/19a8b4f0c0000003" },
  ],
};

let server;
let base;
const seenKeys = [];
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/exec")) {
      seenKeys.push(u.searchParams.get("key"));
      const mode = u.pathname.split("/")[1];
      if (mode === "slow") return; // never answers: the client must time out
      res.writeHead(302, { Location: `/echo/${mode}?key=${encodeURIComponent(u.searchParams.get("key") ?? "")}` });
      return res.end();
    }
    if (u.pathname.startsWith("/echo/")) {
      const mode = u.pathname.split("/")[2];
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mode === "ok" && u.searchParams.get("key") === KEY) return res.end(JSON.stringify(FEED));
      return res.end(JSON.stringify({ ok: false, error: "forbidden" }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

function tmpRoot({ url, key = KEY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-msg-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "portals.yml"), "tracked_companies:\n  - name: Stripe\n  - name: OpenAI\n  - name: Affirm\n");
  fs.writeFileSync(path.join(root, ".env"), url === undefined ? "JOBHUNT_FEED_URL=\nJOBHUNT_FEED_KEY=\n" : `JOBHUNT_FEED_URL=${url}\nJOBHUNT_FEED_KEY=${key}\n`);
  return root;
}
const readLog = (root) => { try { return fs.readFileSync(path.join(root, "data", "hunt-messages-sync.log"), "utf8"); } catch { return ""; } };

test("not configured: exits cleanly and writes nothing", async () => {
  const root = tmpRoot();
  const r = await syncMessages({ root, now: NOW });
  assert.equal(r.status, "not-configured");
  assert.equal(r.message, "feed not configured yet");
  assert.equal(fs.existsSync(path.join(root, "data", "hunt-messages.jsonl")), false);
});

test("ok feed through a 302: rows written in the /messages format", async () => {
  const root = tmpRoot({ url: `${base}/ok/exec` });
  const r = await syncMessages({ root, now: NOW });
  assert.equal(r.status, "ok", r.message);
  assert.match(r.message, /3 threads, 3 new, 0 cleared, feed v1; missing labels: Job Hunt\/Recruiters/);
  const rows = fs.readFileSync(path.join(root, "data", "hunt-messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.threadId), ["19a8b4f0c0000003", "19a8b4f0c0000002", "19a8b4f0c0000001"]);
  const stripe = rows.find((x) => x.threadId.endsWith("1"));
  assert.equal(stripe.company, "Stripe");
  assert.equal(stripe.from, "jordan@stripe.com");
  assert.equal(stripe.fromName, "Jordan Lee");
  assert.equal(stripe.date, "2026-11-17T18:20:00Z");
  assert.equal(stripe.label, "Job Hunt/Applications");
  assert.equal(needsReply(stripe, NOW), true);
  const openai = rows.find((x) => x.threadId.endsWith("2"));
  assert.equal(openai.company, "OpenAI");
  assert.equal(openai.from, "talent@openai.com", "the other party, not me");
  assert.equal(openai.lastFromMe, true);
  assert.equal(needsReply(openai, NOW), false);
  const linkedin = rows.find((x) => x.threadId.endsWith("3"));
  assert.equal(linkedin.company, null, "linkedin.com is not a company; the subject names none");
  assert.equal(needsReply(linkedin, NOW), false, "under 24h old");
  assert.equal((fs.statSync(path.join(root, "data", "hunt-messages.jsonl")).mode & 0o777), 0o600);
  assert.ok(!readLog(root).includes(KEY), "key never logged");
});

test("ok:false (bad key): last good file kept, reason logged, key scrubbed", async () => {
  const root = tmpRoot({ url: `${base}/ok/exec` });
  assert.equal((await syncMessages({ root, now: NOW })).status, "ok");
  const good = fs.readFileSync(path.join(root, "data", "hunt-messages.jsonl"), "utf8");
  fs.writeFileSync(path.join(root, ".env"), `JOBHUNT_FEED_URL=${base}/ok/exec\nJOBHUNT_FEED_KEY=wrong-key-but-also-secret\n`);
  const r = await syncMessages({ root, now: NOW });
  assert.equal(r.status, "error");
  assert.match(r.message, /ok:false \(forbidden\)/);
  assert.equal(fs.readFileSync(path.join(root, "data", "hunt-messages.jsonl"), "utf8"), good);
  const log = readLog(root);
  assert.match(log, /error: feed said ok:false/);
  assert.ok(!log.includes("wrong-key-but-also-secret") && !log.includes(KEY));
});

test("timeout: last good file kept and the reason says so", async () => {
  const root = tmpRoot({ url: `${base}/slow/exec` });
  fs.writeFileSync(path.join(root, "data", "hunt-messages.jsonl"), '{"threadId":"old"}\n');
  const r = await syncMessages({ root, now: NOW, timeoutMs: 300 });
  assert.equal(r.status, "error");
  assert.match(r.message, /timed out after 300 ms/);
  assert.equal(fs.readFileSync(path.join(root, "data", "hunt-messages.jsonl"), "utf8"), '{"threadId":"old"}\n');
});

test("non-https feed URLs are refused (loopback excepted for tests)", async () => {
  const root = tmpRoot({ url: "http://example.com/exec" });
  const r = await syncMessages({ root, now: NOW });
  assert.equal(r.status, "error");
  assert.match(r.message, /must be https/);
});

test("CLI: key stays out of stdout, stderr and argv", async () => {
  const root = tmpRoot({ url: `${base}/nope/exec` });
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "hunt-messages-sync.mjs");
  // Async spawn: a sync spawn would block this process's loopback server.
  const p = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "--timeout-ms", "5000"], { env: { ...process.env, CAREER_OPS_ROOT: root } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr, args: child.spawnargs }));
  });
  assert.ok(!p.args.join(" ").includes(KEY));
  assert.equal(p.status, 1);
  assert.match(p.stdout, /feed said ok:false/);
  assert.ok(!p.stdout.includes(KEY) && !p.stderr.includes(KEY));
});

test("helpers: from parsing and company guesses", () => {
  assert.deepEqual(parseFrom("Jordan Lee <Jordan@Stripe.com>"), { name: "Jordan Lee", address: "jordan@stripe.com" });
  assert.deepEqual(parseFrom("talent@openai.com"), { name: "", address: "talent@openai.com" });
  const companies = new Map([["stripe", "Stripe"], ["affirm", "Affirm"], ["openai", "OpenAI"]]);
  assert.equal(guessCompany("no-reply@us.greenhouse-mail.io", "Your application to Affirm", companies), "Affirm");
  assert.equal(guessCompany("x@mail.stripe.com", "", companies), "Stripe");
  assert.equal(guessCompany("salesforce@myworkday.com", "We've received your application", new Map([...companies, ["salesforce", "Salesforce"]])), "Salesforce");
  assert.equal(guessCompany("Alice via LinkedIn <messaging-digest-noreply@linkedin.com>", "Alice just messaged you", companies), null);
  const receipt = toRow({ threadId: "9", from: "salesforce@myworkday.com", lastFrom: "salesforce@myworkday.com", lastFromMe: false, lastDate: "2026-11-01T00:00:00Z" }, companies);
  assert.equal(receipt.automated, true);
  assert.equal(needsReply(receipt, NOW), false, "ATS receipts never need a reply");
  const li = toRow({ threadId: "11", subject: "Alice just messaged you", from: "Alice Kallaugher via LinkedIn <messaging-digest-noreply@linkedin.com>", lastFrom: "Alice Kallaugher via LinkedIn <messaging-digest-noreply@linkedin.com>", lastFromMe: false, lastDate: "2026-11-19T00:00:00Z" }, companies);
  assert.equal(li.automated, false, "a LinkedIn message stands in for a person");
  assert.equal(li.replyVia, "linkedin");
  assert.equal(li.fromName, "Alice Kallaugher");
  assert.equal(li.company, null);
  assert.equal(needsReply(li, NOW), true, "older than 24h");
  assert.equal(needsReply({ ...li, date: "2026-11-21T01:30:00Z" }, NOW), false, "under 24h");
  const inmail = toRow({ threadId: "12", subject: "InMail: senior payments role", from: "Sam Lee via LinkedIn <inmail-hit-reply@linkedin.com>", lastFromMe: false, lastDate: "2026-11-18T00:00:00Z" }, companies);
  assert.equal(inmail.replyVia, "linkedin");
  assert.equal(inmail.fromName, "Sam Lee");
  const jobAlert = toRow({ threadId: "13", subject: "30 new jobs for you", from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", lastFromMe: false, lastDate: "2026-11-18T00:00:00Z" }, companies);
  assert.equal(jobAlert.automated, true, "job alerts stay automated");
  assert.equal(jobAlert.replyVia, undefined);
  const human = toRow({ threadId: "10", from: "Jordan <jordan@stripe.com>", lastFrom: "Jordan <jordan@stripe.com>", lastFromMe: false, lastDate: "2026-11-01T00:00:00Z" }, companies);
  assert.equal(human.automated, false);
  assert.equal(needsReply(human, NOW), true);
  assert.equal(guessCompany("Recruiter <r@agency.example>", "A role", companies), null);
  assert.equal(toRow({ threadId: "1", from: "a@stripe.com", lastFromMe: false, lastDate: "2026-01-01T00:00:00Z" }, companies).link, "https://mail.google.com/mail/u/0/#all/1");
  assert.ok(trackedCompanies(os.tmpdir()) instanceof Map);
});

test("calendar invites: any 'Invitation …:' subject (incl. unknown sender) and 'Updated invitation' are meetings", () => {
  const co = new Map();
  const row = (subject, from = "Jordan Lee <jordan@example-recruiting.test>") =>
    toRow({ threadId: "t", from, lastFrom: from, subject, lastDate: "2026-11-21T19:22:32Z" }, co);
  for (const s of [
    "Invitation from an unknown sender: Alex Doe and Jordan Lee @ Mon Nov 23, 2026 10:30am - 11am (PST) (me@example.com)",
    "Invitation: Hex intro @ Tue Nov 24, 2026 1pm - 1:30pm (PST)",
    "Updated invitation: Hex intro @ Tue Nov 24, 2026 1pm - 1:30pm (PST)",
    "Updated invitation with note: Hex intro @ Tue Nov 24",
    "Fwd: Invitation: Coffee chat @ Wed",
  ]) {
    const r = row(s);
    assert.equal(r.meeting, true, s);
    assert.equal(needsReply(r, NOW), false, s);
  }
  for (const s of ["Your invitation to apply: Senior Engineer", "Quick chat about a role?", "Invitations are open for our webinar"]) {
    assert.equal(row(s).meeting, undefined, s);
  }
});
