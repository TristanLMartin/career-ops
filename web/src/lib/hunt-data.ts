// Server-side readers for the dashboard additions.
// Missing files are normal (the scripts have not run yet) and read as empty.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as yaml from "js-yaml";
import { careerOpsRoot, readApplications, readApplicationStatusLog, rootScript } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { coreProfileEnv } from "@/lib/core/profile-path.mjs";
import type { HuntEnrichment, HuntMessage } from "@/lib/hunt-types";
import { dedupeLinkedInPeople, needsReply } from "@/lib/hunt-messages-view.mjs";
import { autoClear, followupRows, markState, normalizeMarks, threadRows } from "@/lib/hunt-message-kinds.mjs";
import { buildOpportunities, domainWord, normCo } from "@/lib/hunt-followups.mjs";
import { atsActionAsk, inboxSections } from "@/lib/hunt-inbox.mjs";
import { rankSettings } from "@/lib/hunt-rank-order.mjs";
import { applySignals } from "@/lib/hunt-job-signals.mjs";
import { parseStatusLog, trackerRows } from "@/lib/hunt-tracker.mjs";

/** Profile-specific labels hunt-enrich writes next to the jobs (config/ranking.yml, person.yml). */
export type HuntDisplay = { baseFloor: number | null; currency: string; locationLabels: Record<string, string>; levelTarget: string | null; roleFamilies?: { name: string; words: string[] }[] | null };

export type HuntEnrichDoc = {
  generatedAt: string | null;
  weights: Record<string, number>;
  jobs: Record<string, HuntEnrichment>;
  display: HuntDisplay | null;
};

/** A small JSON signal file: missing reads as null; a malformed one is reported and ignored. */
function readSignalFile(file: string): Record<string, any> | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`${path.basename(file)}: ${(e as Error).message}`);
    return null;
  }
  try { return JSON.parse(text); } catch (e) { console.warn(`${path.basename(file)} is not valid JSON: ${(e as Error).message}`); return null; }
}

export function readHuntEnrichment(root: string = careerOpsRoot()): HuntEnrichDoc {
  const file = path.join(root, "data", "hunt-enrich.json");
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    // The user's ratings, posting liveness and posted age, layered on at read time.
    const jobs = applySignals(doc.jobs ?? {}, {
      ratings: readSignalFile(path.join(root, "data", "hunt-ratings.json"))?.ratings ?? {},
      liveness: readSignalFile(path.join(root, "data", "hunt-liveness.json"))?.checks ?? {},
    });
    return { generatedAt: doc.generatedAt ?? null, weights: doc.weights ?? {}, jobs, display: doc.display ?? null };
  } catch {
    return { generatedAt: null, weights: {}, jobs: {}, display: null };
  }
}

/** One JSON object per line; bad lines are skipped. Latest line per thread wins. */
export function parseHuntMessages(text: string): HuntMessage[] {
  const byThread = new Map<string, HuntMessage>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let m: HuntMessage;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || typeof m.threadId !== "string" || !m.threadId) continue;
    const prev = byThread.get(m.threadId);
    if (!prev || String(m.date) >= String(prev.date)) byThread.set(m.threadId, m);
  }
  return [...byThread.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/**
 * data/hunt-messages.jsonl (the hourly feed) plus every data/hunt-messages.<source>.jsonl
 * (manual or secondary lists, e.g. linkedin-manual). The same LinkedIn person in a manual
 * list and the feed is shown once, preferring the manual row (conversation URL + summary).
 */
export function readHuntMessages(root: string = careerOpsRoot()): { messages: HuntMessage[]; syncedAt: string | null; fixture: boolean } {
  const env = process.env.HUNT_MESSAGES_FILE;
  const dir = path.join(root, "data");
  const files = env
    ? [path.resolve(root, env)]
    : [path.join(dir, "hunt-messages.jsonl"), ...safeList(dir).filter((f) => /^hunt-messages\.[a-z0-9-]+\.jsonl$/.test(f)).map((f) => path.join(dir, f))];
  let text = "";
  let syncedAt: string | null = null;
  for (const file of files) {
    try {
      const body = fs.readFileSync(file, "utf8");
      text += (body.endsWith("\n") || !body ? body : body + "\n");
      if (file.endsWith("hunt-messages.jsonl") || env) syncedAt = fs.statSync(file).mtime.toISOString();
    } catch { /* missing file: nothing from that source */ }
  }
  return { messages: dedupeLinkedInPeople(parseHuntMessages(text)), syncedAt, fixture: !!env };
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** config/ranking.yml `top_picks`, or {} when missing/unreadable. */
export function readTopPicksConfig(root: string = careerOpsRoot()): Record<string, number> {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8")) as { top_picks?: Record<string, number> } | null;
    return doc?.top_picks ?? {};
  } catch {
    return {};
  }
}

export function readScanRuns(root: string = careerOpsRoot()): string {
  try { return fs.readFileSync(path.join(root, "data", "scan-runs.tsv"), "utf8"); } catch { return ""; }
}

// ── hunt: message kinds, Done / Won't respond marks, follow-up cadence ─────

export function messageMarksFile(root: string = careerOpsRoot()): string {
  return path.join(root, "data", "message-marks.json");
}

export function readMessageMarks(root: string = careerOpsRoot()) {
  try { return normalizeMarks(JSON.parse(fs.readFileSync(messageMarksFile(root), "utf8"))); } catch { return normalizeMarks({}); }
}

/** data/message-kinds.json: Haiku answers for threads the rules couldn't place. */
export function readMessageKindCache(root: string = careerOpsRoot()): Record<string, { kind: string; why: string; date: string }> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "data", "message-kinds.json"), "utf8")).threads ?? {}; } catch { return {}; }
}

export type ThreadRow = {
  id: string; name: string; about: string; snippet: string; date: string; lastFromMe: boolean; owe: boolean; automated?: boolean;
  kind: string; kindBy?: string; why?: string; href: string; external: boolean; newReply?: boolean; archived?: boolean; answeredVia?: string | null;
  mark?: { mark: string; at: string; lastDate: string } | null; due?: string | null; status?: string;
};

/** Every message thread as a compact row (kind, marks applied), newest first. */
/** data/hunt-messages-meta.json, written by each sync (feed version, counts), or null. */
export function readFeedMeta(root: string = careerOpsRoot()): { version: number; syncedAt: string; threads: number; new: number; cleared: number } | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-messages-meta.json"), "utf8")); } catch { return null; }
}

export function readThreadRows(root: string = careerOpsRoot()): { rows: ThreadRow[]; syncedAt: string | null; feedVersion: number | null } {
  const { messages, syncedAt } = readHuntMessages(root);
  const { marks, kindOverrides } = readMessageMarks(root);
  const rows = threadRows(autoClear(messages), { marks, kindOverrides, cache: readMessageKindCache(root), needsReply }) as ThreadRow[];
  // A known contact, or a sender at a company in the tracker writing about scheduling / screens /
  // interviews, is a recruiter for that company (not "other"), unless he set the kind himself.
  const contacts = readContacts(root);
  const trackerCos = new Set(readApplications().map((a) => normCo(a.company)).filter((c) => c.length >= 3));
  // ATS / hiring-team mail from a tracked company asking him to act (questionnaire, assessment,
  // availability) is a job lead for that company that needs him, not an automated receipt.
  const trackedNames = readApplications().map((a) => a.company).filter(Boolean);
  for (const r of rows as Array<ThreadRow & { from?: string; subject?: string; company?: string | null; ask?: string | null }>) {
    if ((kindOverrides as Record<string, unknown>)[r.id] || r.archived) continue;
    const hit = atsActionAsk(r, trackedNames);
    if (!hit) continue;
    r.kind = "job_lead"; r.kindBy = "rules"; r.why = `asks for action, ${hit.company}`;
    r.company = hit.company; r.ask = hit.ask; r.automated = false;
  }
  for (const r of rows) {
    if ((kindOverrides as Record<string, unknown>)[r.id] || r.kind === "recruiter" || r.kind === "job_lead") continue;
    const from = String((r as ThreadRow & { from?: string }).from ?? "").toLowerCase();
    const known = contacts[from];
    const atTracked = trackerCos.has(domainWord(from)) && /\b(schedul\w*|screen\w*|interview\w*|loop|recruit\w*|availability|next steps?)\b/i.test(`${r.snippet} ${(r as ThreadRow & { subject?: string }).subject ?? ""}`);
    if (known || atTracked) { r.kind = "recruiter"; r.kindBy = "rules"; r.why = known ? `${known.role} at ${known.company}` : "sender at a company in the tracker"; }
  }
  return { rows, syncedAt, feedVersion: readFeedMeta(root)?.version ?? null };
}

/** Applications the core cadence calculator says to nudge (followup-cadence.mjs --json), or []. */
export function readFollowupEntries(root: string = careerOpsRoot()): Array<Record<string, unknown> & { num: number; company: string; role: string; urgency: string; nextFollowupDate?: string }> {
  const script = rootScript("followup-cadence");
  if (!fs.existsSync(script)) return [];
  try {
    const out = execFileSync(process.execPath, [script, "--json"], { cwd: resolveCodeRoot(process.cwd(), process.env), env: coreProfileEnv(root), timeout: 12_000, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const j = JSON.parse(out.slice(out.indexOf("{")));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

/** Follow-up rows (applications + waiting-on-them recruiter threads), marks applied. */
export function readFollowupRows(root: string = careerOpsRoot(), threadRowList?: ThreadRow[]): ThreadRow[] {
  const { marks } = readMessageMarks(root);
  const threads = threadRowList ?? readThreadRows(root).rows;
  return (followupRows(readFollowupEntries(root), threads) as ThreadRow[]).map((r) => {
    if (!r.id.startsWith("app:")) return r;
    const st = markState({ id: r.id, date: r.date, lastFromMe: true }, marks);
    return { ...r, archived: st.archived, mark: st.mark };
  });
}

// ── hunt: Follow-ups as one row per opportunity ──────────────────────────

export type Opportunity = {
  key: string; title: string; company: string; line2: string; when: string | null; state: "overdue" | "today" | "scheduled" | "upcoming"; other: boolean;
  rows: { n: string; company: string; role: string; status: string; url: string; next?: string; updated?: string }[];
  people: { name: string; role: string }[];
  threads: { id: string; name: string; date: string; snippet: string; lastFromMe: boolean; href: string; linkedin: boolean; answeredVia: string | null }[];
  mark?: { mark: string; at: string; lastDate: string } | null;
  call?: { label: string; day: string } | null; cadenceDue?: string | null;
};

/** An Inbox row: an opportunity in exactly one section, with its action and when text. */
export type InboxItem = Opportunity & { section: "needs" | "waiting" | "done"; action: string; when: string; sort: string; scheduled?: { at: string; label: string; day: string } };

/** data/hunt-contacts.json: email -> { name, role, company } for people behind threads. */
export function readContacts(root: string = careerOpsRoot()): Record<string, { name: string; role: string; company: string }> {
  try { return JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-contacts.json"), "utf8")).contacts ?? {}; } catch { return {}; }
}

/** Follow-up opportunities (marks applied: Done / Ignore hide them, keyed "opp:<key>"). */
export function readOpportunities(root: string = careerOpsRoot(), { keepAll = false }: { keepAll?: boolean } = {}): Opportunity[] {
  let log = "";
  try { log = readApplicationStatusLog() ?? ""; } catch { /* dates fall back */ }
  const tracker = trackerRows(readApplications(), parseStatusLog(log), readHuntEnrichment(root).jobs);
  const { rows: threads } = readThreadRows(root);
  const { marks } = readMessageMarks(root);
  const opps = buildOpportunities({ entries: readFollowupEntries(root), tracker, threads, contacts: readContacts(root), keepAll }) as Opportunity[];
  return opps.map((o) => {
    const m = (marks as Record<string, { mark: string; at: string; lastDate: string }>)[`opp:${o.key}`];
    const latest = o.threads[0]?.date ?? "";
    // Done comes back when a newer inbound message arrives; Ignore stays hidden.
    const back = m?.mark === "done" && latest && m.lastDate && latest > m.lastDate && !o.threads[0]?.lastFromMe;
    return { ...o, mark: m && !back ? m : null };
  });
}

// ── hunt: Inbox (Messages + Follow-ups in one page) ──────────────────────

const inboxCache = new Map<string, { at: number; value: { needs: InboxItem[]; waiting: InboxItem[]; done: InboxItem[] } }>();

/**
 * The Inbox's three sections for this profile. Cached for 20 s per data root, because the nav
 * badge reads it on every page and the cadence calculator is a child process.
 */
export function readInbox(root: string = careerOpsRoot(), { fresh = false }: { fresh?: boolean } = {}): { needs: InboxItem[]; waiting: InboxItem[]; done: InboxItem[] } {
  const hit = inboxCache.get(root);
  if (!fresh && hit && Date.now() - hit.at < 20_000) return hit.value;
  const value = inboxSections(readOpportunities(root, { keepAll: true })) as { needs: InboxItem[]; waiting: InboxItem[]; done: InboxItem[] };
  inboxCache.set(root, { at: Date.now(), value });
  return value;
}

/** The "Needs my reply" count for the nav badge, or 0 when anything fails. */
export function readInboxNeedsCount(root: string = careerOpsRoot()): number {
  try { return readInbox(root).needs.length; } catch { return 0; }
}

/** The profile's base pay floor from config/ranking.yml (base_floor), or null when unset. */
export function readBaseFloor(root: string = careerOpsRoot()): number | null {
  let text: string;
  try { text = fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const cfg = (yaml.load(text) ?? {}) as { base_floor?: unknown };
  const n = Number(cfg.base_floor);
  return cfg.base_floor != null && Number.isFinite(n) && n > 0 ? n : null;
}

/** The profile's Best overall rank settings (rank_weights, pay band, floor, location scores). */
export function readRankSettings(root: string = careerOpsRoot()): ReturnType<typeof rankSettings> {
  let text = "";
  try { text = fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return rankSettings(text ? (yaml.load(text) ?? {}) : {});
}
