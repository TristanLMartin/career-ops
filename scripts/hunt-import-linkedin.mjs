#!/usr/bin/env node
// hunt-import-linkedin: data/linkedin-unanswered.json -> data/hunt-messages.linkedin-manual.jsonl
//. The output file is replaced entirely on every run, so a later
// LinkedIn scan can swap it cleanly. The hourly feed sync never touches it.
// Content is untrusted data: stored and shown, never acted on.
//
// Usage: node scripts/hunt-import-linkedin.mjs [input.json]
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

export const SOURCE = "linkedin-manual";
const PRIORITY = { high: 0, medium: 1, low: 2 };

/** "Hex (via Paraform)" -> { company: "Hex", via: "Paraform" }; "ex-Initech coworker" -> note. */
export function splitCompany(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { company: null, note: null, via: null };
  if (/\b(ex-|former|coworker|co-worker|colleague|friend)\b/i.test(s)) return { company: null, note: s, via: null };
  const m = s.match(/^(.*?)\s*\(via ([^)]+)\)\s*$/i);
  if (m) return { company: m[1].trim(), note: null, via: m[2].trim() };
  const paren = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) return { company: paren[1].trim(), note: paren[2].trim(), via: null };
  return { company: s, note: null, via: null };
}

function stableId(url, person) {
  const m = String(url ?? "").match(/\/messaging\/thread\/([^/?#]+)/);
  return `linkedin:${m ? m[1] : String(person ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function toRows(doc) {
  const list = Array.isArray(doc?.unanswered) ? doc.unanswered : [];
  return list
    .filter((x) => x && x.person)
    .map((x) => {
      const { company, note, via } = splitCompany(x.company);
      const day = String(x.last_msg ?? "").slice(0, 10);
      return {
        threadId: stableId(x.url, x.person),
        source: SOURCE,
        from: "",
        fromName: String(x.person),
        company,
        note: note ?? (via ? `via ${via}` : null),
        subtitle: x.role ?? null,
        subject: x.role ?? note ?? "LinkedIn conversation",
        snippet: String(x.summary ?? "").slice(0, 400),
        date: /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T12:00:00Z` : String(x.last_msg ?? ""),
        lastFromMe: false,
        needsReplyOverride: true,
        priority: Object.hasOwn(PRIORITY, x.priority) ? x.priority : "medium",
        replyVia: "linkedin",
        label: "LinkedIn (manual list)",
        link: String(x.url ?? "https://www.linkedin.com/messaging/"),
      };
    })
    .sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || String(a.date).localeCompare(String(b.date)));
}

export function importLinkedIn({ root = getCareerOpsRoot(), input } = {}) {
  const src = input ?? path.join(root, "data", "linkedin-unanswered.json");
  const doc = JSON.parse(fs.readFileSync(src, "utf8"));
  const rows = toRows(doc);
  const out = path.join(root, "data", `hunt-messages.${SOURCE}.jsonl`);
  const tmp = `${out}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), { mode: 0o600 });
  fs.renameSync(tmp, out);
  return { rows: rows.length, out, checkedAt: doc.checked_at ?? null };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const r = importLinkedIn({ input: process.argv[2] });
  console.log(`hunt-import-linkedin: ${r.rows} conversations -> ${path.basename(r.out)}${r.checkedAt ? ` (list checked ${r.checkedAt})` : ""}`);
}
