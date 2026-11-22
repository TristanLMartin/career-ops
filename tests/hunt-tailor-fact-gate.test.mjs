// hunt: lib/hunt-tailor-fact-gate.mjs — apply answers go through verify-cv-facts like the CV does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { answerSources, gateAnswers } from "../lib/hunt-tailor-fact-gate.mjs";

function fixture({ facts = true, config = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-gate-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "cv.md"), [
    "# Sam Example", "", "## Experience", "", "### Acme Payments — Seattle, WA", "**Senior Software Engineer**", "2024 – 2026", "",
    "- Built a payment validation service with 2 engineers in 3 months", "- Cut customer payment inquiries by 22%", "",
    "### Bigco — Seattle, WA", "**Software Engineer**", "2019 – 2024", "", "- Cut database writes by a third, saving about $300K a year", "",
  ].join("\n"));
  if (facts) fs.writeFileSync(path.join(root, "data", "candidate-facts.md"), "# Facts\n- Total: about 7 years full-time. \"7 years\" and \"7+ years\" are accurate.\n- US citizen, no sponsorship needed.\n");
  if (config) fs.writeFileSync(path.join(root, "config", "cv-facts.json"), JSON.stringify(config));
  return root;
}

test("answerSources: cv.md and article-digest.md always, candidate-facts.md only when present", () => {
  const with_ = fixture();
  assert.deepEqual(answerSources(with_).map((p) => path.relative(with_, p)), ["cv.md", "article-digest.md", "data/candidate-facts.md"]);
  const without = fixture({ facts: false });
  assert.deepEqual(answerSources(without).map((p) => path.relative(without, p)), ["cv.md", "article-digest.md"]);
});

test("'seven years' passes once the candidate's facts file states it", () => {
  const root = fixture();
  const r = gateAnswers([{ question: "Why this role?", answer: "I have spent seven years building production systems, most recently payments." }], { root });
  assert.equal(r.answers[0].verdict, "pass", JSON.stringify(r.answers[0].findings));
  assert.equal(r.verdict, "pass");
});

test("'10 years' is blocked as an unsupported number, with no config needed", () => {
  const root = fixture();
  const r = gateAnswers([{ question: "Experience?", answer: "I bring 10 years of backend experience." }], { root });
  assert.equal(r.verdict, "block");
  assert.equal(r.answers[0].verdict, "block");
  assert.ok(r.answers[0].findings.some((f) => /10 years/.test(f.value)), JSON.stringify(r.answers[0].findings));
});

test("a forbidden phrase from config/cv-facts.json blocks; cv.md numbers pass; empty answers pass", () => {
  const root = fixture({ config: { forbidden_phrases: ["B.S."] } });
  const r = gateAnswers([
    { question: "Degree?", answer: "I hold a B.S. in Computer Science." },
    { question: "Proud of?", answer: "I led a payment settings page that cut customer payment inquiries by 22%." },
    { question: "Start date?", answer: "" },
  ], { root });
  assert.deepEqual(r.answers.map((a) => a.verdict), ["block", "pass", "pass"]);
  assert.deepEqual(r.answers[0].findings, [{ kind: "forbidden phrase", value: "B.S." }]);
  assert.equal(r.verdict, "block");
});
