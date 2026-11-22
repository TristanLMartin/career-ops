/**
 * hunt: fact gate for free-text application answers.
 *
 * The CV and cover-letter renderers run verify-cv-facts.mjs before writing a PDF.
 * Answers drafted for an application form ("Why this role?", "Desired salary") had no
 * such gate: an answer could say "seven years" or "10 years" and nothing checked it.
 * gateAnswers() runs each answer through the same exported verifyFacts() with the same
 * sources (cv.md, article-digest.md, config/cv-facts.json) plus any extra user-layer
 * fact files (data/candidate-facts.md by default), so an answer is held to the same
 * standard as the CV. Generic on purpose: nothing here is specific to one person, so it could
 * move upstream as a helper for modes/apply.md.
 */
import fs from "node:fs";
import path from "node:path";
import { verifyFacts } from "../verify-cv-facts.mjs";

/** Extra fact files read when they exist, relative to the data root. */
export const EXTRA_FACT_SOURCES = ["data/candidate-facts.md"];

/** The sources an answer is checked against: cv.md, article-digest.md, then extras that exist. */
export function answerSources(root, extras = EXTRA_FACT_SOURCES) {
  const base = ["cv.md", "article-digest.md"].map((f) => path.join(root, f));
  const more = extras.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  return [...base, ...more];
}

function findingsOf(result) {
  const value = (x) => (typeof x === "string" ? x : x?.value ?? x?.claim ?? JSON.stringify(x));
  return [
    ...result.invented.map((x) => ({ kind: "unsupported number", value: value(x) })),
    ...result.unsupportedFacts.map((x) => ({ kind: x.kind || "unsupported claim", value: value(x) })),
    ...result.forbidden.map((x) => ({ kind: "forbidden phrase", value: value(x) })),
  ].filter((f, i, all) => all.findIndex((o) => o.kind === f.kind && o.value === f.value) === i);
}

/**
 * Check each { question, answer } against the user's fact sources.
 * @param {{question: string, answer: string}[]} answers
 * @param {{root: string, sourcePaths?: string[], configPath?: string, verify?: typeof verifyFacts}} opts
 * @returns {{verdict: "pass"|"warn"|"block", answers: {question: string, answer: string, verdict: string, findings: {kind: string, value: string}[], warnings: string[]}[], configMissing: boolean}}
 */
export function gateAnswers(answers, { root, sourcePaths = answerSources(root), configPath = path.join(root, "config", "cv-facts.json"), verify = verifyFacts } = {}) {
  let configMissing = false;
  const checked = (answers ?? []).map(({ question, answer }) => {
    const text = String(answer ?? "").trim();
    if (!text) return { question, answer: text, verdict: "pass", findings: [], warnings: [] };
    const r = verify(text, { sourcePaths, configPath, cwd: root });
    configMissing ||= Boolean(r.configMissing);
    const findings = findingsOf(r);
    const warnings = [...(r.warnings ?? []), ...(r.advisoryFacts ?? []).map((x) => (typeof x === "string" ? x : x?.value ?? ""))].filter(Boolean);
    return { question, answer: text, verdict: findings.length ? "block" : r.verdict === "block" ? "block" : warnings.length ? "warn" : "pass", findings, warnings };
  });
  const verdict = checked.some((a) => a.verdict === "block") ? "block" : checked.some((a) => a.verdict === "warn") ? "warn" : "pass";
  return { verdict, answers: checked, configMissing };
}
