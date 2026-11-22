// hunt: server side of the job page's "Tailor & apply" panel.
// The route (/api/profile/tailor) validates a request here, then starts
// scripts/hunt-tailor-run.mjs detached; that script runs the real upstream mode headless and
// writes data/hunt-tailor/{NNN}-{kind}.json, which GET reads back for the panel to poll.
// The tailored resume itself is upstream's own "Generate tailored CV" run (/api/run kind "pdf").
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const TAILOR_KINDS = ["cover", "answers"];
export const COVER_TONE_IDS = ["formal", "direct", "conversational", "mirror"];
export const STALE_MS = 20 * 60 * 1000;
const MAX_ANSWER = 1000;

export const pad = (n) => String(Number(n)).padStart(3, "0");

export function statePath(root, n, kind) {
  return path.join(root, "data", "hunt-tailor", `${pad(n)}-${kind}.json`);
}

/** One run's state, with a run that has said nothing for STALE_MS shown as failed. */
export function readOne(root, n, kind, now = Date.now()) {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(statePath(root, n, kind), "utf8"));
  } catch {
    return null;
  }
  if (s.state === "running" && now - Date.parse(s.updatedAt ?? s.startedAt ?? 0) > STALE_MS) {
    return { ...s, state: "failed", error: "The run stopped without finishing (the dashboard may have restarted). Run it again." };
  }
  return s;
}

export function readTailorState(root, n, now = Date.now()) {
  return { cover: readOne(root, n, "cover", now), answers: readOne(root, n, "answers", now) };
}

/** @returns {{ok: true, kind: string, report: string, brief: object|null} | {ok: false, error: string}} */
export function validateTailorRequest(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "bad request" };
  const kind = body.kind;
  if (!TAILOR_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${TAILOR_KINDS.join(", ")}` };
  const report = typeof body.report === "string" || typeof body.report === "number" ? String(body.report) : "";
  if (!/^\d{1,4}$/.test(report)) return { ok: false, error: "report must be a report number" };
  if (kind === "answers") return { ok: true, kind, report, brief: null };
  const b = body.brief && typeof body.brief === "object" ? body.brief : {};
  const brief = {};
  for (const k of ["why", "problem", "approach"]) {
    const v = typeof b[k] === "string" ? b[k].trim() : "";
    if (!v) return { ok: false, error: "Answer all four cover letter questions first." };
    if (v.length > MAX_ANSWER) return { ok: false, error: `Keep each answer to ${MAX_ANSWER} characters or fewer.` };
    brief[k] = v;
  }
  brief.tone = COVER_TONE_IDS.includes(b.tone) ? b.tone : "mirror";
  return { ok: true, kind, report, brief };
}

function cell(report, label) {
  const m = String(report).match(new RegExp(`^\\|\\s*${label}\\s*\\|\\s*(.+?)\\s*\\|\\s*$`, "mi"));
  return m ? m[1].replace(/\*\*/g, "").trim() : "";
}

/**
 * Starting points for modes/cover.md's Step 6 answers, read from the evaluation report (zero
 * tokens). They are suggestions the candidate edits before running, never sent unedited by default.
 */
export function coverSuggestions(report) {
  const text = String(report ?? "");
  const archetype = cell(text, "Archetype").replace(/\s*\(.*?\)/g, "").split(/[;,]/)[0].trim();
  const fn = cell(text, "Function");
  const domain = cell(text, "Domain");
  const reqs = [...text.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)]
    .filter((m) => /STAR|Story/i.test(text.slice(Math.max(0, m.index - 2000), m.index)) && !/^JD Requirement$/i.test(m[1].trim()))
    .slice(0, 2);
  // The report talks to the candidate in the second person, so only labels are reused, never its prose.
  const why = archetype ? `${archetype} is the kind of role I am targeting.` : "";
  const problem = [fn, domain && `(${domain})`].filter(Boolean).join(" ");
  const approach = reqs.length ? `Start with ${reqs.map((m) => m[1].trim().toLowerCase()).join(" and ")}, drawing on ${reqs.map((m) => m[2].trim()).join(" and ")}.` : "";
  return { why: why.slice(0, MAX_ANSWER), problem: problem.slice(0, MAX_ANSWER), approach: approach.slice(0, MAX_ANSWER), tone: "mirror" };
}

/**
 * Start scripts/hunt-tailor-run.mjs detached. Refuses while the same run is still going.
 * @returns {{ok: true, state: object} | {ok: false, status: number, error: string}}
 */
export function startTailorRun({ root, codeRoot, kind, report, brief, now = Date.now(), spawnFn = spawn, nodePath = process.execPath }) {
  const n = Number(report);
  const reportsDir = path.join(root, "reports");
  const has = fs.existsSync(reportsDir) && fs.readdirSync(reportsDir).some((f) => f.startsWith(`${pad(n)}-`) && f.endsWith(".md"));
  if (!has) return { ok: false, status: 404, error: `No report #${report}. Evaluate this job first.` };
  const current = readOne(root, n, kind, now);
  if (current?.state === "running") return { ok: false, status: 409, error: "Already running." };
  const dir = path.join(root, "data", "hunt-tailor");
  fs.mkdirSync(dir, { recursive: true });
  const args = [path.join(codeRoot, "scripts", "hunt-tailor-run.mjs"), "--yes", "--kind", kind, "--report", pad(n)];
  if (kind === "cover") {
    const briefFile = path.join(dir, `${pad(n)}-cover-brief.json`);
    fs.writeFileSync(briefFile, JSON.stringify(brief, null, 1));
    args.push("--input", briefFile);
  }
  const state = { kind, report: pad(n), state: "running", startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), finishedAt: null, error: null, outputs: {}, ...(brief ? { brief } : {}) };
  fs.writeFileSync(statePath(root, n, kind), JSON.stringify(state, null, 1));
  const log = fs.openSync(path.join(dir, `${pad(n)}-${kind}.log`), "w");
  const child = spawnFn(nodePath, args, { cwd: codeRoot, env: { ...process.env, CAREER_OPS_ROOT: root }, detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref?.();
  fs.closeSync(log);
  return { ok: true, state };
}
