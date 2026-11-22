#!/usr/bin/env node
/**
 * hunt: headless "Tailor & apply" runs for one report.
 *
 *   node scripts/hunt-tailor-run.mjs --kind cover   --report 274 --input brief.json
 *   node scripts/hunt-tailor-run.mjs --kind answers --report 274
 *   add --prompt-only to print the prompt and exit (no model call)
 *
 * Runs the real upstream mode (modes/cover.md or modes/apply.md) through `claude -p --model
 * sonnet` with read-only tools, then does every write itself:
 *   cover   → writes the payload to output/diagnostics/, renders it with generate-cover-letter.mjs
 *             (which runs the verify-cv-facts gate and names the PDF output/{NNN}-…-cover-….pdf)
 *   answers → gates every answer with lib/hunt-tailor-fact-gate.mjs and writes
 *             output/diagnostics/{NNN}-{company}-apply-answers.{md,json}
 * Progress and results go to data/hunt-tailor/{NNN}-{kind}.json, which the dashboard polls.
 * Never opens a browser, never submits or sends anything, never changes a tracker status.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { requireSpendConsent } from "../lib/cli-guard.mjs";
import { localToday } from "../lib/local-today.mjs";
import { gateAnswers } from "../lib/hunt-tailor-fact-gate.mjs";
import { ANSWERS_ENVELOPE, COVER_ENVELOPE, answersPrompt, coverPrompt, coverRepairPrompt, parseEnvelope, questionsFor } from "../lib/hunt-tailor-prompts.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const KINDS = ["cover", "answers"];
export const MODEL = "sonnet";
export const BUDGET_USD = "1.50";
const TIMEOUT_MS = 15 * 60 * 1000;

const USAGE = `Usage: node scripts/hunt-tailor-run.mjs --kind cover|answers --report <N> [--input <brief.json>] [--prompt-only]
  cover   needs --input: {"why","problem","approach","tone"} (the four modes/cover.md Step 6 answers)
  answers drafts form answers with modes/apply.md (no browser) and fact-gates them
Writes data/hunt-tailor/<NNN>-<kind>.json and files under output/. Never submits anything.`;

export function parseArgs(argv) {
  const a = { kind: "", report: "", input: "", promptOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--prompt-only") a.promptOnly = true;
    else if (k === "--yes") continue; // spend consent (lib/cli-guard.mjs), checked before parsing
    else if (k === "--kind" || k === "--report" || k === "--input") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
      a[k.slice(2)] = v;
    } else throw new Error(`unrecognized flag: ${k}`);
  }
  if (a.help) return a;
  if (!KINDS.includes(a.kind)) throw new Error(`--kind must be one of ${KINDS.join(", ")}`);
  if (!/^\d{1,4}$/.test(a.report)) throw new Error("--report must be a report number");
  if (a.kind === "cover" && !a.input && !a.promptOnly) throw new Error("--kind cover needs --input <brief.json>");
  return a;
}

export const pad = (n) => String(Number(n)).padStart(3, "0");

/** reports/{NNN}-*.md for a report number, newest name last; null when absent. */
export function findReport(root, n) {
  const dir = path.join(root, "reports");
  const hits = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.startsWith(`${pad(n)}-`) && f.endsWith(".md")).sort();
  return hits.length ? path.join(dir, hits.at(-1)) : null;
}

export function companyOf(reportText, file) {
  const m = String(reportText).match(/^#\s*Evaluation:\s*(.+?)\s+[—–-]\s+/m);
  if (m) return m[1].trim();
  return path.basename(file).replace(/^\d+-/, "").replace(/-\d{4}-\d{2}-\d{2}\.md$/, "");
}

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";

export function statePath(root, n, kind) {
  return path.join(root, "data", "hunt-tailor", `${pad(n)}-${kind}.json`);
}

export function writeState(root, n, kind, patch) {
  const file = statePath(root, n, kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first write */ }
  const next = { ...prev, ...patch, kind, report: pad(n), updatedAt: new Date().toISOString() };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 1));
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

/** The headless worker: real modes, read-only tools, no auto-approve flag. Injected in tests. */
export function runClaude(prompt, { cwd = CODE_ROOT, bin = process.env.HUNT_TAILOR_CLAUDE || "claude" } = {}) {
  return new Promise((resolve) => {
    const args = ["-p", "--model", MODEL, "--output-format", "json", "--max-budget-usd", BUDGET_USD,
      "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
      "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent"];
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, result: "", cost: 0, error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      let o = {}; try { o = JSON.parse(out); } catch { o = { result: out }; }
      resolve({ code, result: String(o.result ?? ""), cost: Number(o.total_cost_usd ?? 0), error: code ? (err || String(o.result ?? "")).slice(0, 300) : "" });
    });
    child.stdin.end(prompt);
  });
}

/** Render a cover payload through generate-cover-letter.mjs (its own fact gate decides). */
export function renderCover({ root, n, payload, company, node = process.execPath }) {
  const diag = path.join(root, "output", "diagnostics");
  fs.mkdirSync(diag, { recursive: true });
  const payloadFile = path.join(diag, `${pad(n)}-${slug(company)}-cover-payload.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2));
  const r = spawnSync(node, [path.join(CODE_ROOT, "generate-cover-letter.mjs"), "--payload", payloadFile, "--report", pad(n)], { cwd: CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: root }, encoding: "utf8", timeout: 180000 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = text.match(/(output\/[^\s"']+-cover-[^\s"']+\.pdf)/) || text.match(/([^\s"']+\.pdf)/);
  const pdf = m ? path.resolve(root, m[1].replace(/^\.\//, "")) : null;
  return { ok: r.status === 0 && Boolean(pdf && fs.existsSync(pdf)), pdf: pdf && fs.existsSync(pdf) ? path.relative(root, pdf) : null, payloadFile: path.relative(root, payloadFile), log: text.trim().split("\n").slice(-12).join("\n") };
}

export function answersMarkdown({ company, n, gate, notes, date }) {
  const lines = [`# Application answers: ${company} (report ${pad(n)})`, "", `Drafted ${date}. Not submitted. Fact gate: **${gate.verdict}**.`, ""];
  if (notes?.length) lines.push("## Preflight", "", ...notes.map((x) => `- ${x}`), "");
  lines.push("## Answers", "");
  for (const a of gate.answers) {
    const flag = a.verdict === "block" ? " ⛔ blocked by the fact gate" : a.needs_you ? " ✋ needs you" : "";
    lines.push(`### ${a.question}${flag}`, "", a.answer || "_(no answer)_", "");
    if (a.findings.length) lines.push(`> Unsupported: ${a.findings.map((f) => `${f.value} (${f.kind})`).join("; ")}`, "");
    if (a.note) lines.push(`> Note: ${a.note}`, "");
  }
  return lines.join("\n");
}

export async function run(args, { root = getCareerOpsRoot(), claude = runClaude, today = localToday(), render = renderCover, log = () => {} } = {}) {
  const { kind } = args;
  const n = Number(args.report);
  const reportPath = findReport(root, n);
  if (!reportPath) throw new Error(`no report ${pad(n)} in ${path.join(root, "reports")}`);
  const reportText = fs.readFileSync(reportPath, "utf8");
  const company = companyOf(reportText, reportPath);
  const reportFile = path.relative(root, reportPath);
  let prompt;
  let brief = null;
  if (kind === "cover") {
    brief = args.input ? JSON.parse(fs.readFileSync(args.input, "utf8")) : { why: "", problem: "", approach: "", tone: "mirror" };
    prompt = coverPrompt({ reportFile, report: pad(n), company, brief, today });
  } else {
    prompt = answersPrompt({ reportFile, report: pad(n), company, questions: questionsFor(reportText), today });
  }
  if (args.promptOnly) return { prompt };

  writeState(root, n, kind, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, error: null, outputs: {}, company, ...(brief ? { brief } : {}) });
  try {
    const res = await claude(prompt, { cwd: CODE_ROOT });
    if (res.code !== 0) throw new Error(`the model run failed: ${res.error || "no output"}`);
    if (kind === "cover") {
      let payload = parseEnvelope(res.result, COVER_ENVELOPE);
      if (!payload?.letter) throw new Error("the cover run returned no payload");
      let r = render({ root, n, payload, company });
      let notes = res.result.split(`<</${COVER_ENVELOPE}>>`).pop().trim().slice(0, 2000);
      let cost = res.cost;
      let repaired = false;
      // One repair round when the fact gate (not the renderer) said no: the gate's own message
      // goes back to the worker. The gate still decides; nothing is waived or allow-listed.
      if (!r.ok && /fact check failed/i.test(r.log)) {
        writeState(root, n, kind, { state: "running", note: "Fixing what the fact check flagged…" });
        const again = await claude(coverRepairPrompt({ base: prompt, payload, gateLog: r.log }), { cwd: CODE_ROOT });
        cost += again.cost;
        const fixed = again.code === 0 ? parseEnvelope(again.result, COVER_ENVELOPE) : null;
        if (fixed?.letter) {
          payload = fixed;
          r = render({ root, n, payload, company });
          notes = again.result.split(`<</${COVER_ENVELOPE}>>`).pop().trim().slice(0, 2000) || notes;
          repaired = true;
        }
      }
      if (!r.ok) {
        return writeState(root, n, kind, { state: "failed", finishedAt: new Date().toISOString(), error: "The cover letter did not pass the fact check or did not render. Details below.", costUsd: cost, repaired, outputs: { payload: r.payloadFile }, log: r.log, notes });
      }
      return writeState(root, n, kind, { state: "done", finishedAt: new Date().toISOString(), costUsd: cost, repaired, outputs: { pdf: r.pdf, payload: r.payloadFile }, log: r.log, notes, letter: payload.letter });
    }
    const body = parseEnvelope(res.result, ANSWERS_ENVELOPE);
    if (!Array.isArray(body?.answers)) throw new Error("the apply run returned no answers");
    const raw = body.answers.map((a) => ({ question: String(a?.question ?? ""), answer: String(a?.answer ?? ""), needs_you: Boolean(a?.needs_you), note: String(a?.note ?? "") }));
    const gate = gateAnswers(raw, { root });
    gate.answers = gate.answers.map((g, i) => ({ ...g, needs_you: raw[i].needs_you, note: raw[i].note }));
    const notes = Array.isArray(body.notes) ? body.notes.map(String).slice(0, 10) : [];
    const diag = path.join(root, "output", "diagnostics");
    fs.mkdirSync(diag, { recursive: true });
    const stem = `${pad(n)}-${slug(company)}-apply-answers`;
    fs.writeFileSync(path.join(diag, `${stem}.md`), answersMarkdown({ company, n, gate, notes, date: today }));
    fs.writeFileSync(path.join(diag, `${stem}.json`), JSON.stringify({ report: pad(n), company, date: today, notes, ...gate }, null, 2));
    return writeState(root, n, kind, { state: "done", finishedAt: new Date().toISOString(), costUsd: res.cost, outputs: { markdown: path.join("output", "diagnostics", `${stem}.md`), json: path.join("output", "diagnostics", `${stem}.json`) }, verdict: gate.verdict, answers: gate.answers, notes });
  } catch (e) {
    log(e.message);
    return writeState(root, n, kind, { state: "failed", finishedAt: new Date().toISOString(), error: e.message });
  }
}

if (isMainModule(import.meta.url)) {
  // Costs a Claude run; the dashboard's Tailor button passes --yes (the click is the consent).
  requireSpendConsent("hunt-tailor-run", { freeFlags: ["--prompt-only", "--help", "-h"] });
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(1);
  }
  if (args.help) { console.log(USAGE); process.exit(0); }
  const out = await run(args, { log: (m) => console.error(m) });
  if (args.promptOnly) console.log(out.prompt);
  else console.log(JSON.stringify({ state: out.state, outputs: out.outputs, error: out.error ?? null }));
  process.exit(out.state === "failed" ? 1 : 0);
}
