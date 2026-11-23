// Which jobs an earlier evaluation already stopped at a gate, read from
// data/hunt-usage.tsv, so the daily picker and evaluation runs don't pay for them again:
//   - below the base floor, or an agency posting: never re-picked (the posting won't change);
//   - unreadable posting / employer unclear / site rate-limited: re-picked after 7 days
//     (a retry sometimes succeeds once a site stops rate-limiting).
// A later successful evaluation clears the record.
import fs from "node:fs";
import path from "node:path";

export const RETRY_UNREADABLE_DAYS = 7;
// Evaluation rows in the usage log: "<model> (reeval lite)", "(reeval)", "(auto lite)", and the
// older web runs logged as "spend_tier". Spot-checks never gate a job.
const EVAL_MODEL = /^spend_tier$|\((reeval|auto|web)[^)]*\)/i;

/** "permanent" | "unreadable" | null for one usage-log status. */
export function gateKind(status) {
  const s = String(status ?? "");
  if (!/gated:/i.test(s)) return null;
  if (/dealbreaker|agency/i.test(s)) return "permanent";
  return "unreadable";
}

/** Map<url, { kind, at }> of each job's latest evaluation outcome when it was a gate. */
export function gateHistory(usageTsv) {
  const lines = String(usageTsv ?? "").split("\n").filter((l) => l.trim());
  if (lines.length < 2) return new Map();
  const head = lines[0].split("\t");
  const col = (n) => head.indexOf(n);
  const [di, mi, si, ui] = [col("date"), col("model"), col("status"), col("url")];
  const latest = new Map();
  for (const l of lines.slice(1)) {
    const c = l.split("\t");
    const url = c[ui];
    if (!url || !EVAL_MODEL.test(c[mi] ?? "") || /spot-check/i.test(c[mi] ?? "")) continue;
    const prev = latest.get(url);
    if (!prev || c[di] > prev.at) latest.set(url, { at: c[di], status: c[si] ?? "" });
  }
  const out = new Map();
  for (const [url, { at, status }] of latest) {
    const kind = gateKind(status);
    if (kind) out.set(url, { kind, at });
  }
  return out;
}

/** True when the job should not be picked again (now = ms). */
export function skipForGate(entry, now = Date.now()) {
  if (!entry) return false;
  if (entry.kind === "permanent") return true;
  return now - Date.parse(entry.at) < RETRY_UNREADABLE_DAYS * 86400000;
}

/** Set of URLs to skip, from the profile's usage log. */
export function gatedUrls(root, now = Date.now()) {
  let tsv = "";
  try { tsv = fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8"); } catch {}
  const out = new Set();
  for (const [url, e] of gateHistory(tsv)) if (skipForGate(e, now)) out.add(url);
  return out;
}
