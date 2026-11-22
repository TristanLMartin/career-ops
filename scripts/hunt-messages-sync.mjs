#!/usr/bin/env node
// hunt-messages-sync: Job Hunt mail feed -> data/hunt-messages.jsonl.
//
// The feed is a Google Apps Script web app in your own Google account. It reads only
// the "Job Hunt/*" labels with gmail.readonly and serves JSON to holders of a long
// key. No Google credential lives on this machine.
//
//   GET ${JOBHUNT_FEED_URL}?key=${JOBHUNT_FEED_KEY}
//   -> 302 to script.googleusercontent.com -> { ok, generatedAt, threads: [...] }
//   A bad key answers HTTP 200 with { ok: false, error: "forbidden" }.
//
// On success the JSONL file /messages reads is replaced atomically. On any failure
// the last good file is kept and the reason is logged. The key is read from .env
// only, sent only in the request URL from inside this process, and scrubbed from
// every message this script prints. Message content is untrusted data: stored, never
// acted on.
//
// Usage: node scripts/hunt-messages-sync.mjs [--timeout-ms 30000]
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

export const TAG = "hunt-messages-sync";

export function readEnvFile(file) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** company slug -> display name from portals.yml `- name:` lines (regex is enough). */
export function trackedCompanies(root) {
  const map = new Map();
  let text = "";
  try { text = fs.readFileSync(path.join(root, "portals.yml"), "utf8"); } catch { return map; }
  for (const m of text.matchAll(/^\s*-\s*name:\s*(.+)$/gm)) {
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (slug) map.set(slug, name);
  }
  return map;
}

/** "Jordan Lee <jordan@stripe.com>" -> { name, address } */
export function parseFrom(s) {
  const str = String(s ?? "").trim();
  const m = str.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  if (str.includes("@")) return { name: "", address: str.toLowerCase() };
  return { name: str, address: "" };
}

const GENERIC = new Set(["com", "io", "co", "ai", "net", "org", "us", "mail", "email", "e", "careers", "jobs", "hire", "talent", "recruiting", "notifications", "greenhouse", "lever", "ashbyhq", "myworkday", "linkedin", "gmail", "googlemail", "outlook", "hotmail", "yahoo", "icloud"]);

export function guessCompany(from, subject, companies) {
  const { name, address } = parseFrom(from);
  const domain = address.split("@")[1] ?? "";
  for (const part of domain.split(/[.-]/)) {
    if (!part || GENERIC.has(part)) continue;
    const hit = companies.get(part.replace(/[^a-z0-9]/g, ""));
    if (hit) return hit;
  }
  // ATS senders often put the employer in the local part: salesforce@myworkday.com.
  if (/(^|\.)(myworkday|workday|greenhouse(-mail)?|lever|ashbyhq|icims|smartrecruiters)\./.test(domain)) {
    const hit = companies.get((address.split("@")[0] ?? "").replace(/[^a-z0-9]/g, ""));
    if (hit) return hit;
  }
  const hay = `${name} ${subject ?? ""}`.toLowerCase();
  for (const [slug, display] of companies) {
    if (slug.length < 4) continue;
    const re = new RegExp(`\\b${display.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(hay)) return display;
  }
  return null;
}

// Automated senders (ATS receipts, no-reply mail): shown, but never "needs reply".
export const AUTOMATED_SENDER_RE = /(no-?reply|do-?not-?reply|notifications?@|mailer-daemon|@([a-z0-9-]+\.)*(myworkday|workday|greenhouse(-mail)?|lever|ashbyhq|icims|smartrecruiters|successfactors|taleo|jobvite|workablemail)\.(com|io|co|net)\b|@([a-z0-9-]+\.)*careers\.microsoft\.com|^careers@)/i;
// Application auto-acknowledgements by subject (any sender): never "needs reply".
export const RECEIPT_SUBJECT_RE = /\b(received your application|thank(s| you) for (applying|your application|your interest)|application (received|confirmation|submitted)|we('|’)ve received|your application (to|for|has been))\b/i;
// Scheduled-meeting mail (Calendly, Paraform, calendar invites): proof a conversation moved on.
// Google Calendar invite subjects: "Invitation: …", "Updated invitation: …",
// "Invitation from an unknown sender: …" (any "Invitation …:" lead-in at the start of the subject).
export const INVITE_SUBJECT_RE = /^\s*(?:(?:re|fwd?):\s*)*(?:updated\s+)?invitation(?:\s+[^:]{1,60})?:|\binvitation:|\bupdated invitation\b/i;
export const MEETING_RE = new RegExp(`${INVITE_SUBJECT_RE.source}|\\b(accepted:|new event:|scheduled\\b|confirmed:|meeting confirmed|calendly|paraform)`, "i");
// Calendar-invite style subjects that just pair two names: "Ann Lee and Bo Park", "Ann Lee / Bo", "Ann Lee <> Acme".
export const NAME_PAIR_RE = /^\s*[A-Z][\w'-]+(?: [A-Z][\w'-]+){0,2}\s+(?:and|&|\/|<>|x)\s+[A-Z][\w'-]+(?: [A-Z][\w'-]+){0,3}\s*$/;
export const MEETING_SENDER_RE = /@([a-z0-9-]+\.)*(calendly\.com|paraform\.com|google\.com)\b|calendar-notification/i;
// LinkedIn message notifications stand in for a real person's message: not automated.
export const LINKEDIN_MESSAGE_RE = /\bjust messaged you\b|\bsent you a (new )?message\b|\binmail\b|\bnew message from\b/i;

/** A LinkedIn notification for a person's message -> that person's name, else null. */
export function linkedInPerson(from, subject) {
  const { name, address } = parseFrom(from);
  if (!/@([a-z0-9-]+\.)*linkedin\.com$/.test(address)) return null;
  const isMessage = /messaging|inmail|hit-reply/.test(address) || LINKEDIN_MESSAGE_RE.test(String(subject ?? ""));
  if (!isMessage) return null;
  const m = name.match(/^(.*?)\s+via\s+LinkedIn$/i);
  return { person: (m ? m[1] : name).trim() || null };
}

/** Feed thread -> the JSONL row /messages reads (see web/src/lib/hunt-types.ts). */
export function toRow(t, companies) {
  const other = parseFrom(t.lastFromMe ? t.from : t.lastFrom || t.from);
  const first = parseFrom(t.from);
  // A thread you started and wrote last (from == lastFrom == you): the other person is in `to`.
  const to = t.lastFromMe && t.to && (!t.lastFrom || t.lastFrom === t.from) ? parseFrom(String(t.to).split(",")[0]) : null;
  const pick = to?.address ? to : first.address && !t.lastFromMe ? other : first;
  const row = {
    threadId: String(t.threadId),
    from: pick.address || other.address,
    fromName: pick.name || other.name,
    company: guessCompany(t.from, t.subject, companies) ?? guessCompany(t.lastFrom, t.subject, companies),
    subject: String(t.subject ?? ""),
    snippet: String(t.snippet ?? "").slice(0, 400),
    date: String(t.lastDate ?? t.firstDate ?? ""),
    lastFromMe: !!t.lastFromMe,
    label: Array.isArray(t.labels) && t.labels.length ? t.labels.join(", ") : undefined,
    link: String(t.link ?? `https://mail.google.com/mail/u/0/#all/${t.threadId}`),
    messageCount: Number.isFinite(t.messageCount) ? t.messageCount : undefined,
    automated: AUTOMATED_SENDER_RE.test(String(t.lastFromMe ? t.from : t.lastFrom || t.from)) || RECEIPT_SUBJECT_RE.test(String(t.subject ?? "")),
  };
  const subj = String(t.subject ?? "");
  if ((MEETING_RE.test(subj) && (MEETING_SENDER_RE.test(`${t.from ?? ""} ${t.lastFrom ?? ""}`) || /calendly|paraform|scheduled/i.test(subj) || INVITE_SUBJECT_RE.test(subj))) || NAME_PAIR_RE.test(subj)) row.meeting = true;
  if (Array.isArray(t.labels) && t.labels.includes("search:recruiting")) row.search = true;
  const li = linkedInPerson(t.lastFromMe ? t.from : t.lastFrom || t.from, t.subject) ?? linkedInPerson(t.from, t.subject);
  if (li) {
    row.automated = false;
    row.replyVia = "linkedin";
    if (li.person) row.fromName = li.person;
    row.company = null;
  }
  return row;
}

export function needsReply(row, now = Date.now()) {
  if (row.lastFromMe || row.automated || row.meeting) return false; // an invite is not a message to answer
  const t = Date.parse(row.date);
  return Number.isFinite(t) && now - t > 24 * 3600 * 1000;
}

/** v1: body.threads. v2 adds body.searchThreads (inbox-wide recruiting search). Deduped by thread id. */
export function feedThreads(body) {
  if (!Array.isArray(body?.threads) && !Array.isArray(body?.searchThreads)) return null;
  const byId = new Map();
  for (const t of [...(body.threads ?? []), ...(Array.isArray(body.searchThreads) ? body.searchThreads : [])]) {
    if (!t || !t.threadId) continue;
    const prev = byId.get(t.threadId);
    if (prev) {
      // keep the newest copy, but merge labels so a labeled thread found by search stays labeled
      const newer = String(t.lastDate ?? "") > String(prev.lastDate ?? "") ? t : prev;
      byId.set(t.threadId, { ...newer, labels: [...new Set([...(prev.labels ?? []), ...(t.labels ?? [])])] });
    } else byId.set(t.threadId, t);
  }
  return [...byId.values()];
}

/** data/gmail-snapshot-*.json: one-time read-only pulls in the v2 feed shape (stopgap). */
export function readSnapshots(root) {
  const dir = path.join(root, "data");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^gmail-snapshot-[\w-]+\.json$/.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    try { out.push(...(feedThreads(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) ?? [])); } catch { /* bad file: skipped */ }
  }
  return out;
}

/** Live feed threads win; snapshot threads fill in, unless older than `maxDays` (the stopgap fades out). */
export function withSnapshots(live, snapshot, now = Date.now(), maxDays = 14) {
  const ids = new Set(live.map((t) => t.threadId));
  const fresh = snapshot.filter((t) => t?.threadId && !ids.has(t.threadId) && now - Date.parse(t.lastDate ?? t.firstDate ?? "") <= maxDays * 24 * 3600e3);
  return [...live, ...fresh];
}

/** New thread ids and threads that went from "you owe" to not owed since the last sync. */
export function syncDelta(before, after, now = Date.now()) {
  const prev = new Map(before.map((r) => [r.threadId, r]));
  let added = 0, cleared = 0;
  for (const r of after) {
    const p = prev.get(r.threadId);
    if (!p) { added++; continue; }
    if (needsReply(p, now) && !needsReply(r, now)) cleared++;
  }
  return { added, cleared };
}

function scrub(text, secrets) {
  let s = String(text ?? "");
  for (const v of secrets) if (v) s = s.split(v).join("<redacted>").split(encodeURIComponent(v)).join("<redacted>");
  return s;
}

/**
 * @returns {Promise<{status: "ok"|"not-configured"|"error", message: string, threads?: number}>}
 */
export async function syncMessages({ root = getCareerOpsRoot(), timeoutMs = 30000, fetchImpl = fetch, now = Date.now() } = {}) {
  const env = { ...readEnvFile(path.join(root, ".env")) };
  const url = (env.JOBHUNT_FEED_URL ?? "").trim();
  const key = (env.JOBHUNT_FEED_KEY ?? "").trim();
  const out = path.join(root, "data", "hunt-messages.jsonl");
  const log = path.join(root, "data", "hunt-messages-sync.log");
  const secrets = [key, url];
  const note = (status, message, extra = {}) => {
    const line = `${new Date(now).toISOString()} ${status}: ${scrub(message, secrets)}`;
    try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, line + "\n"); } catch {}
    return { status, message: scrub(message, secrets), ...extra };
  };
  if (!url || !key) return { status: "not-configured", message: "feed not configured yet" };

  let target;
  try {
    target = new URL(url);
    if (target.protocol !== "https:" && !(target.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))) {
      return note("error", "JOBHUNT_FEED_URL must be https");
    }
    target.searchParams.set("key", key);
  } catch {
    return note("error", "JOBHUNT_FEED_URL is not a valid URL");
  }

  let body;
  try {
    const res = await fetchImpl(target, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    if (!res.ok) return note("error", `feed answered HTTP ${res.status}; kept the last good file`);
    const text = await res.text();
    try { body = JSON.parse(text); } catch { return note("error", "feed did not return JSON; kept the last good file"); }
  } catch (e) {
    const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${timeoutMs} ms` : (e?.cause?.code || e?.message || "fetch failed");
    return note("error", `feed request failed (${why}); kept the last good file`);
  }
  if (!body || body.ok !== true) return note("error", `feed said ok:false (${typeof body?.error === "string" ? body.error.slice(0, 80) : "no reason"}); kept the last good file`);
  const live = feedThreads(body);
  if (!live) return note("error", "feed has no threads array; kept the last good file");
  const all = withSnapshots(live, readSnapshots(root), now);
  const version = body.version === 2 ? 2 : 1;

  const companies = trackedCompanies(root);
  const rows = all.map((t) => toRow(t, companies)).sort((a, b) => b.date.localeCompare(a.date));
  let before = [];
  try { before = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* first sync */ }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(tmp, out);
  const missing = version === 1 && Array.isArray(body.missingLabels) && body.missingLabels.length ? `; missing labels: ${body.missingLabels.join(", ")}` : "";
  const { added, cleared } = syncDelta(before, rows, now);
  const meta = { version, syncedAt: new Date(now).toISOString(), threads: rows.length, new: added, cleared };
  try {
    const mf = path.join(root, "data", "hunt-messages-meta.json");
    fs.writeFileSync(`${mf}.tmp`, JSON.stringify(meta));
    fs.renameSync(`${mf}.tmp`, mf);
  } catch { /* meta is cosmetic */ }
  return note("ok", `${rows.length} threads, ${added} new, ${cleared} cleared, feed v${version}${missing}`, { threads: rows.length, version, added, cleared });
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const i = process.argv.indexOf("--timeout-ms");
  const timeoutMs = i > 0 ? Number(process.argv[i + 1]) || 30000 : 30000;
  const r = await syncMessages({ timeoutMs });
  console.log(`${TAG}: ${r.message}`);
  process.exitCode = r.status === "error" ? 1 : 0;
}
