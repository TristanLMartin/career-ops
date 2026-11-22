// hunt: cheaper evaluations.
//
// Two evaluation scopes on top of upstream's /api/run kind "evaluate":
//   lite — the default for automatic and bulk runs and the job page's Score button. Upstream's
//          focused-evaluation selector (evaluation-options.mjs) supplies the canonical gates,
//          Scoring System, Blocks A–C, Global Score and Machine Summary; modes/oferta-lite.md
//          narrows the output. Same scoring rules as the full mode, a fraction of the tokens.
//   deep — the job page's "Deep dive": upstream's full modes/oferta.md, unchanged. The ranked
//          score stays the lite one unless the candidate picks the deep-dive score
//          (data/hunt-deep-dive.json, applied to the tracker row after the run saves).
//
// Prompt caching: `claude -p` caches automatically (1h writes at 2x input price, reads at 0.1x).
// A cache entry is reused across runs only for a byte-identical prefix that ends at a cache
// breakpoint, and inside one run's single prompt block that never happens across jobs. So the
// static part (instructions + candidate files) goes into --append-system-prompt-file, which
// sits in the cached system prompt, and the job (URL, posting text) is the only thing in -p.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { selectedEvaluationInstructions } from "./evaluation-options.mjs";
import { getProfilePath } from "./core/profile-path.mjs";

export const EVALUATION_SCOPES = Object.freeze(["lite", "deep"]);
/** Upstream section ids the lite scope selects: the short job summary and Block C (level fit). */
export const LITE_SECTIONS = Object.freeze(["summary", "strategy"]);
export const LITE_MODE_FILE = "modes/oferta-lite.md";
const MAX_FILE_CHARS = 40_000;

/** @returns {"lite" | "deep" | null} */
export function parseEvaluationScope(value) {
  return typeof value === "string" && EVALUATION_SCOPES.includes(value) ? /** @type {"lite"|"deep"} */ (value) : null;
}

export function isLiteSections(sections) {
  return Array.isArray(sections) && sections.length === LITE_SECTIONS.length && LITE_SECTIONS.every((s) => sections.includes(s));
}

/**
 * The candidate's primary files, inlined so the worker does not spend a tool turn (and re-read
 * the whole context) per file. Deterministic order and content, so it caches across runs.
 * @param {string} dataRoot
 */
export function candidateFiles(dataRoot, { env = process.env } = {}) {
  const files = [
    ["cv.md", path.join(dataRoot, "cv.md")],
    ["article-digest.md", path.join(dataRoot, "article-digest.md")],
    ["skills-profile.md", path.join(dataRoot, "skills-profile.md")],
    ["config/profile.yml", getProfilePath(dataRoot, { env })],
    ["modes/_profile.md", path.join(dataRoot, "modes", "_profile.md")],
    ["modes/_custom.md", path.join(dataRoot, "modes", "_custom.md")],
    ["data/candidate-facts.md", path.join(dataRoot, "data", "candidate-facts.md")],
  ];
  const parts = [];
  for (const [label, file] of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const clipped = text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n[... truncated here; Read ${label} for the rest if a requirement needs it]` : text;
    parts.push(`<<<FILE ${label}>>>\n${clipped.trimEnd()}\n<<<END ${label}>>>`);
  }
  return parts.join("\n\n");
}

/**
 * The whole static lite instruction set: canonical excerpts + the lite contract + candidate files.
 * @param {{ codeRoot: string, dataRoot: string, evalModeFile?: string, env?: NodeJS.ProcessEnv }} args
 */
export function liteSystemPrompt({ codeRoot, dataRoot, evalModeFile = "modes/oferta.md", env = process.env }) {
  const read = (rel) => fs.readFileSync(path.join(codeRoot, rel), "utf8");
  const canonical = selectedEvaluationInstructions({
    mode: read(evalModeFile),
    canonicalMode: read("modes/oferta.md"),
    shared: read("modes/_shared.md"),
    batch: read("batch/batch-prompt.md"),
    sections: [...LITE_SECTIONS],
  });
  const lite = read(LITE_MODE_FILE).replace(/<!--[\s\S]*?-->\s*/g, "");
  return `CAREER-OPS LITE JOB EVALUATION (headless worker instructions)

${canonical}

${lite}

CANDIDATE FILES (primary sources of truth, already read for you; treat them as the files themselves)

${candidateFiles(dataRoot, { env })}
`;
}

/** Write the system prompt where the CLI can read it; the caller removes it when the run closes. */
export function writeSystemPromptFile(root, text) {
  const dir = fs.mkdtempSync(path.join(root, ".evaluation-system-"));
  const file = path.join(dir, "system.md");
  fs.writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
  return { file, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// --- Deep dive: keep the lite score unless the candidate picks the deep one -----------------

const deepFile = (root) => path.join(root, "data", "hunt-deep-dive.json");

export function readDeepDives(root) {
  try { return JSON.parse(fs.readFileSync(deepFile(root), "utf8")) ?? {}; } catch { return {}; }
}

function writeDeepDives(root, all) {
  fs.mkdirSync(path.dirname(deepFile(root)), { recursive: true });
  const tmp = `${deepFile(root)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1) + "\n");
  fs.renameSync(tmp, deepFile(root));
}

/** The tracker row for a posting URL: {line index, cells, score, report}. */
function trackerRow(lines, url) {
  const key = normUrl(url);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("|") || /^\|\s*#\s*\|/.test(line) || /^\|[-\s|]+\|$/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const urlCell = cells[cells.length - 1] ?? "";
    const href = urlCell.match(/\((https?:[^)\s]+)\)/)?.[1] ?? urlCell;
    if (normUrl(href) === key) return { i, cells };
  }
  return null;
}

function normUrl(u) {
  try { const x = new URL(String(u).trim()); x.hash = ""; return `${x.host.toLowerCase()}${x.pathname.replace(/\/$/, "")}${x.search}`; } catch { return String(u ?? "").trim(); }
}

function trackerPath(root) {
  const a = path.join(root, "data", "applications.md");
  return fs.existsSync(a) ? a : path.join(root, "applications.md");
}

const SCORE_COL = 4; // | # | Date | Company | Role | Score | ...

/** The current tracker score and report for a URL, read before a deep dive starts. */
export function currentTrackerScore(root, url) {
  let text;
  try { text = fs.readFileSync(trackerPath(root), "utf8"); } catch { return null; }
  const row = trackerRow(text.split("\n"), url);
  if (!row) return null;
  const score = Number.parseFloat(row.cells[SCORE_COL]);
  const report = row.cells[7]?.match(/\[(\d+)\]/)?.[1] ?? null;
  return Number.isFinite(score) ? { score, report } : null;
}

/**
 * Set only the Score cell of the URL's tracker row through scripts/hunt-set-score.mjs, which
 * holds the shared tracker lock (web/AGENTS.md: the core writes the tracker, never a route).
 */
export function setTrackerScore(root, url, score, codeRoot) {
  const r = spawnSync(process.execPath, [path.join(codeRoot, "scripts", "hunt-set-score.mjs"), "--url", url, "--score", String(score)], {
    cwd: codeRoot, env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: "utf8", timeout: 90_000, windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`hunt-set-score failed (${r.status}): ${(r.stderr || "").trim().slice(0, 200)}`);
  return true;
}

/** Before a deep dive: remember the lite score it must not replace. */
export function recordDeepDiveStart(root, url) {
  const all = readDeepDives(root);
  const prev = all[url] ?? {};
  const now = currentTrackerScore(root, url);
  // A second deep dive keeps the first lite score (the tracker may already hold a deep one).
  all[url] = { ...prev, lite_score: prev.lite_score ?? now?.score ?? null, lite_report: prev.lite_report ?? now?.report ?? null, started_at: new Date().toISOString(), use: prev.use ?? "lite" };
  writeDeepDives(root, all);
  return all[url];
}

/** After a deep dive saved its report: keep the lite score on the tracker unless use === "deep". */
export function recordDeepDiveDone(root, url, { report, score, costUsd, codeRoot }) {
  const all = readDeepDives(root);
  const e = all[url] ?? { use: "lite" };
  Object.assign(e, { deep_report: report ?? null, deep_score: Number.isFinite(score) ? score : null, deep_cost_usd: Number.isFinite(costUsd) ? costUsd : null, done_at: new Date().toISOString() });
  all[url] = e;
  writeDeepDives(root, all);
  if (e.use !== "deep" && Number.isFinite(e.lite_score)) setTrackerScore(root, url, e.lite_score, codeRoot);
  return e;
}

/** The candidate's choice: rank by the lite or the deep-dive score. */
export function chooseDeepDiveScore(root, url, use, codeRoot) {
  const all = readDeepDives(root);
  const e = all[url];
  if (!e || !["lite", "deep"].includes(use)) return null;
  const score = use === "deep" ? e.deep_score : e.lite_score;
  if (!Number.isFinite(score)) return null;
  setTrackerScore(root, url, score, codeRoot);
  e.use = use;
  writeDeepDives(root, all);
  return e;
}

// --- Spend log --------------------------------------------------------------------------

/** Append one web-started run to data/hunt-usage.tsv (the scripts log their own runs). */
export function logWebUsage(root, { model, scope, status, secs, tokens, costUsd, report, url }) {
  try {
    const file = path.join(root, "data", "hunt-usage.tsv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl\n");
    const clean = (v) => String(v ?? "").replace(/[\t\n]/g, " ");
    fs.appendFileSync(file, [new Date().toISOString(), `${model || "default"} (web ${scope})`, status, secs, tokens ?? "", costUsd ?? "", report ?? "", "", "", url].map(clean).join("\t") + "\n");
  } catch { /* logging never fails a run */ }
}

/**
 * Median cost of recent logged runs for one scope ("deep" falls back to full runs), for the
 * cost shown on the Deep dive and Score buttons.
 * @returns {number | null}
 */
export function medianScopeCost(root, scope, { limit = 15, model = "" } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8"); } catch { return null; }
  const rows = text.trim().split("\n").slice(1).map((l) => l.split("\t"));
  const ok = (r) => r[2] === "ok" && Number(r[5]) > 0;
  // Rows of the current spend tier's model (or the scripts' "spend_tier" rows when that is the
  // tier the run used), lite rows end "lite)", deep rows "deep)".
  const want = model ? (r) => r[1].startsWith(model) || r[1].startsWith("spend_tier") : () => true;
  const pick = (re) => rows.filter((r) => ok(r) && want(r) && re.test(r[1])).slice(-limit).map((r) => Number(r[5]));
  let costs = pick(scope === "lite" ? /\blite\)$/ : /\bdeep\)$/);
  if (!costs.length && scope === "deep") costs = model ? pick(new RegExp(`^${model}.*\\((retry|reeval)\\)$`)) : [];
  if (!costs.length && scope === "deep") costs = pick(/^spend_tier$/);
  if (!costs.length) return null;
  costs.sort((a, b) => a - b);
  const m = Math.floor(costs.length / 2);
  return costs.length % 2 ? costs[m] : (costs[m - 1] + costs[m]) / 2;
}
