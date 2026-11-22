// hunt: scripts/hunt-tailor-run.mjs + lib/hunt-tailor-prompts.mjs — the harness side of
// the job page's Tailor & apply runs. The model is faked; the fact gate and file writes are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, run, findReport, companyOf, statePath } from "../scripts/hunt-tailor-run.mjs";
import { answersPrompt, coverPrompt, parseEnvelope, questionsFor, reportQuestions } from "../lib/hunt-tailor-prompts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-run-"));
  for (const d of ["reports", "data", "config", "output"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "cv.md"), "# Sam\n\n## Experience\n\n### Acme — Seattle, WA\n**Senior Software Engineer**\n2019 – 2026\n\n- Cut customer payment inquiries by 22%\n");
  fs.writeFileSync(path.join(root, "data", "candidate-facts.md"), "- About 7 years full-time; \"7 years\" is accurate.\n");
  fs.writeFileSync(path.join(root, "reports", "274-acme-2026-11-21.md"), "# Evaluation: Acme — Forward Deployed Engineer\n\n**Score:** 3.8/5\n\n## H) Draft Answers\n\n### Why do you want to work at Acme?\n\nBecause.\n");
  return root;
}

test("parseArgs validates kind, report and the cover brief; --help needs nothing", () => {
  assert.deepEqual(parseArgs(["--kind", "answers", "--report", "274"]), { kind: "answers", report: "274", input: "", promptOnly: false, help: false });
  assert.equal(parseArgs(["--help"]).help, true);
  assert.throws(() => parseArgs(["--kind", "submit", "--report", "274"]), /--kind/);
  assert.throws(() => parseArgs(["--kind", "answers", "--report", "x"]), /report/);
  assert.throws(() => parseArgs(["--kind", "cover", "--report", "274"]), /--input/);
  assert.throws(() => parseArgs(["--kind", "answers", "--report", "274", "--open-browser"]), /unrecognized/);
});

test("--help prints usage and exits 0 without running anything", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "hunt-tailor-run.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node scripts\/hunt-tailor-run\.mjs/);
});

test("prompts run the real modes read-only and never ask to submit", () => {
  const a = answersPrompt({ reportFile: "reports/274-acme.md", report: "274", company: "Acme", questions: ["Why {company}?"], today: "2026-11-22" });
  assert.match(a, /modes\/apply\.md/);
  assert.match(a, /"Why Acme\?"/);
  assert.match(a, /never submit/i);
  const c = coverPrompt({ reportFile: "reports/274-acme.md", report: "274", company: "Acme", brief: { why: "w", problem: "p", approach: "a", tone: "direct" }, today: "2026-11-22" });
  assert.match(c, /modes\/cover\.md/);
  assert.match(c, /Tone: Direct/);
  assert.match(c, /render no PDF/);
});

test("parseEnvelope takes the last envelope and tolerates a code fence", () => {
  const t = "<<answers-json>>{\"a\":1}<</answers-json>> text <<answers-json>>\n```json\n{\"a\":2}\n```\n<</answers-json>>";
  assert.deepEqual(parseEnvelope(t, "answers-json"), { a: 2 });
  assert.equal(parseEnvelope("no envelope", "answers-json"), null);
});

test("questionsFor: standard questions plus the report's Block H questions, deduped", () => {
  const report = fs.readFileSync(path.join(fixture(), "reports", "274-acme-2026-11-21.md"), "utf8");
  assert.deepEqual(reportQuestions(report), ["Why do you want to work at Acme?"]);
  const qs = questionsFor(report);
  assert.ok(qs.includes("Why do you want to work at Acme?"));
  assert.equal(new Set(qs).size, qs.length);
});

test("answers run: gate passes 'seven years', blocks '10 years', writes diagnostics and state", async () => {
  const root = fixture();
  assert.ok(findReport(root, 274).endsWith("274-acme-2026-11-21.md"));
  assert.equal(companyOf(fs.readFileSync(findReport(root, 274), "utf8"), findReport(root, 274)), "Acme");
  let seenPrompt = "";
  const claude = async (prompt) => {
    seenPrompt = prompt;
    return { code: 0, cost: 0.1, result: `<<answers-json>>${JSON.stringify({ notes: ["Not applied yet."], answers: [
      { question: "Why Acme?", answer: "I have spent seven years building production systems." },
      { question: "Experience?", answer: "I bring 10 years of backend experience." },
      { question: "Start date?", answer: "", needs_you: true, note: "No start date on file." },
    ] })}<</answers-json>>` };
  };
  const s = await run({ kind: "answers", report: "274" }, { root, claude, today: "2026-11-22" });
  assert.match(seenPrompt, /report #274 \(Acme\)/);
  assert.equal(s.state, "done");
  assert.equal(s.verdict, "block");
  assert.deepEqual(s.answers.map((a) => a.verdict), ["pass", "block", "pass"]);
  assert.equal(s.answers[2].needs_you, true);
  const md = fs.readFileSync(path.join(root, s.outputs.markdown), "utf8");
  assert.match(md, /blocked by the fact gate/);
  assert.match(md, /Not submitted/);
  assert.equal(JSON.parse(fs.readFileSync(statePath(root, 274, "answers"), "utf8")).state, "done");
});

test("cover run: payload goes to the renderer; a failed render or a missing envelope is a failed state", async () => {
  const root = fixture();
  const brief = path.join(root, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ why: "w", problem: "p", approach: "a", tone: "mirror" }));
  const payload = { candidate: { name: "Sam" }, letter: { company: "Acme", opening: "Hi" }, user_inputs: ["w", "p", "a", "mirror"] };
  const claude = async () => ({ code: 0, cost: 0.2, result: `<<cover-json>>${JSON.stringify(payload)}<</cover-json>>\n- note` });
  let rendered = null;
  const ok = await run({ kind: "cover", report: "274", input: brief }, { root, claude, render: (a) => { rendered = a; return { ok: true, pdf: "output/274-acme-cover-sam-2026-11-22.pdf", payloadFile: "output/diagnostics/274-acme-cover-payload.json", log: "" }; } });
  assert.equal(ok.state, "done");
  assert.equal(ok.outputs.pdf, "output/274-acme-cover-sam-2026-11-22.pdf");
  assert.deepEqual(rendered.payload, payload);
  const blocked = await run({ kind: "cover", report: "274", input: brief }, { root, claude, render: () => ({ ok: false, pdf: null, payloadFile: "p", log: "CV fact check failed" }) });
  assert.equal(blocked.state, "failed");
  const none = await run({ kind: "cover", report: "274", input: brief }, { root, claude: async () => ({ code: 0, cost: 0, result: "no envelope" }) });
  assert.equal(none.state, "failed");
  assert.match(none.error, /no payload/);
});

test("cover run: one repair round when the fact gate blocks, then the gate decides again", async () => {
  const root = fixture();
  const brief = path.join(root, "brief.json");
  fs.writeFileSync(brief, JSON.stringify({ why: "w", problem: "p", approach: "a", tone: "mirror" }));
  const prompts = [];
  const claude = async (prompt) => {
    prompts.push(prompt);
    const letter = prompts.length === 1 ? { opening: "Shipped it" } : { opening: "Built it" };
    return { code: 0, cost: 0.3, result: `<<cover-json>>${JSON.stringify({ letter })}<</cover-json>>` };
  };
  const renders = [];
  const render = ({ payload }) => {
    renders.push(payload.letter.opening);
    return payload.letter.opening === "Built it"
      ? { ok: true, pdf: "output/274-acme-cover.pdf", payloadFile: "p", log: "" }
      : { ok: false, pdf: null, payloadFile: "p", log: "Fact check failed for cover letter: drift=shipped" };
  };
  const s = await run({ kind: "cover", report: "274", input: brief }, { root, claude, render });
  assert.equal(s.state, "done");
  assert.equal(s.repaired, true);
  assert.deepEqual(renders, ["Shipped it", "Built it"]);
  assert.match(prompts[1], /REPAIR ROUND/);
  assert.match(prompts[1], /drift=shipped/);
  assert.equal(Math.round(s.costUsd * 10), 6);
  // A render failure that is not the fact gate gets no repair round.
  prompts.length = 0;
  const other = await run({ kind: "cover", report: "274", input: brief }, { root, claude, render: () => ({ ok: false, pdf: null, payloadFile: "p", log: "page budget exceeded" }) });
  assert.equal(other.state, "failed");
  assert.equal(prompts.length, 1);
});
