#!/usr/bin/env node
// hunt-set-score: set the Score cell of the tracker row for one posting URL, under the shared
// tracker lock (tracker-utils.mjs openTrackerTransaction, the lock merge-tracker.mjs and
// set-status.mjs use) with an atomic replace. Nothing else in the row changes.
//
// Used by the job page's Deep dive (web/src/lib/hunt-lite-eval.mjs): a deep dive saves the
// full report, then the ranked score goes back to the lite one unless the candidate picks the
// deep-dive score.
//
// Usage: node scripts/hunt-set-score.mjs --url <posting url> --score 4.2
// Exit 0 updated · 1 no row for that URL · 2 usage · 4 lock busy.
import { getCareerOpsRoot, resolveTrackerPathForWrite } from "../path-resolver.mjs";
import { openTrackerTransaction } from "../tracker-utils.mjs";
import { resolveColumns, extractCellUrl } from "../tracker-parse.mjs";
import { normalizeUrl } from "../url-key.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

/**
 * Pure: the tracker text with that URL's Score cell replaced, or null when no row matches.
 * @param {string} text
 * @param {string} url
 * @param {number} score
 */
export function withScore(text, url, score) {
  const lines = text.split("\n");
  const cols = resolveColumns(lines);
  const key = normalizeUrl(url);
  if (!key || !Number.isInteger(cols.score)) return null;
  let hit = false;
  const out = lines.map((line) => {
    if (hit || !line.startsWith("|")) return line;
    const cells = line.split("|");
    const urlIdx = Number.isInteger(cols.url) ? cols.url : cells.length - 2;
    const href = extractCellUrl(cells[urlIdx] ?? "");
    if (!href || normalizeUrl(href) !== key) return line;
    hit = true;
    cells[cols.score] = ` ${score.toFixed(1)}/5 `;
    return cells.join("|");
  });
  return hit ? out.join("\n") : null;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const url = arg("--url");
  const score = Number(arg("--score"));
  if (!url || !Number.isFinite(score) || score < 0 || score > 5) {
    console.error("usage: hunt-set-score.mjs --url <posting url> --score <0-5>");
    process.exit(2);
  }
  const file = resolveTrackerPathForWrite(getCareerOpsRoot());
  let tx;
  try {
    tx = await openTrackerTransaction(file);
  } catch (err) {
    console.error(err?.message ?? String(err));
    process.exit(err?.code === "LOCK_TIMEOUT" ? 4 : 2);
  }
  try {
    const next = withScore(tx.read(), url, score);
    if (next === null) { console.error(`no tracker row for ${url}`); process.exitCode = 1; }
    else { tx.replace(next); console.log(`score set to ${score.toFixed(1)}/5`); }
  } finally {
    tx.close();
  }
}
