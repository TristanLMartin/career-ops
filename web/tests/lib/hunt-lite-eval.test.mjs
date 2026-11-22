// hunt: lite/deep evaluation scopes, the lean evaluate argv, and the tracker score helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCliArgs, argValue } from "../../src/lib/claude-invocation.mjs";
import { isLiteSections, liteSystemPrompt, LITE_SECTIONS, medianScopeCost, parseEvaluationScope } from "../../src/lib/hunt-lite-eval.mjs";
import { withScore } from "../../../scripts/hunt-set-score.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("evaluate runs load no settings sources or skills and can take a cached system prompt file", () => {
  const args = claudeCliArgs({ kind: "evaluate", prompt: "x", systemPromptFile: "/tmp/s.md" });
  assert.equal(argValue(args, "--setting-sources"), "");
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"));
  assert.equal(argValue(args, "--append-system-prompt-file"), "/tmp/s.md");
  // other kinds keep their settings
  assert.ok(!claudeCliArgs({ kind: "pdf", prompt: "x" }).includes("--setting-sources"));
});

test("scope parsing", () => {
  assert.equal(parseEvaluationScope("lite"), "lite");
  assert.equal(parseEvaluationScope("deep"), "deep");
  assert.equal(parseEvaluationScope("full"), null);
  assert.ok(isLiteSections([...LITE_SECTIONS]));
  assert.ok(!isLiteSections(["summary"]));
});

test("lite system prompt carries the canonical scoring, the lite contract and the candidate files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lite-"));
  fs.writeFileSync(path.join(dir, "cv.md"), "# CV\nUNIQUE-CV-LINE\n");
  const text = liteSystemPrompt({ codeRoot: CODE_ROOT, dataRoot: dir });
  assert.match(text, /## Scoring System/);
  assert.match(text, /LITE SCOPE CONTRACT/);
  assert.match(text, /UNIQUE-CV-LINE/);
  assert.doesNotMatch(text, /## Block F/);
  // deterministic, so consecutive runs share the prompt cache
  assert.equal(text, liteSystemPrompt({ codeRoot: CODE_ROOT, dataRoot: dir }));
});

test("withScore changes only the Score cell of the URL's row", () => {
  const t = [
    "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| 1 | 2026-11-21 | A | R | 4.3/5 | Evaluated | ❌ | [1](../reports/001-a.md) | n | [ashby](https://jobs.ashbyhq.com/a/1) |",
    "| 2 | 2026-11-21 | B | R | 3.0/5 | Evaluated | ❌ | [2](../reports/002-b.md) | n | [ashby](https://jobs.ashbyhq.com/b/2) |",
  ].join("\n");
  const out = withScore(t, "https://jobs.ashbyhq.com/a/1", 3.9).split("\n");
  assert.match(out[2], /\| 3\.9\/5 \|/);
  assert.equal(out[3], t.split("\n")[3]);
  assert.equal(withScore(t, "https://example.com/none", 1), null);
});

test("medianScopeCost reads lite and deep rows of the tier's model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "data", "hunt-usage.tsv"), [
    "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl",
    "d\tclaude-sonnet-5-5 (web lite)\tok\t1\t1\t0.10\t\t\t\tu",
    "d\tclaude-sonnet-5-5 (web lite)\tok\t1\t1\t0.30\t\t\t\tu",
    "d\tclaude-haiku-5-5 (web lite)\tok\t1\t1\t9\t\t\t\tu",
    "d\tclaude-sonnet-5-5 (web deep)\tok\t1\t1\t0.70\t\t\t\tu",
  ].join("\n") + "\n");
  assert.equal(medianScopeCost(dir, "lite", { model: "claude-sonnet-5-5" }), 0.2);
  assert.equal(medianScopeCost(dir, "deep", { model: "claude-sonnet-5-5" }), 0.7);
});

test("model run labels map to a kind and a model", async () => {
  const { describeLabel } = await import("../../src/lib/hunt-model-runs.mjs");
  assert.equal(describeLabel("claude-haiku-5-5 (quick score)").kind, "Quick score");
  assert.equal(describeLabel("spend_tier (lite)").kind, "Lite eval (auto)");
  assert.equal(describeLabel("claude-sonnet-5-5 (reeval lite)").kind, "Lite eval (bulk)");
  assert.equal(describeLabel("claude-haiku-5-5 (web deep)").kind, "Deep dive");
  assert.equal(describeLabel("claude-opus-5-5 (spot-check lite)").kind, "Opus spot-check");
  assert.equal(describeLabel("spend_tier").kind, "Full eval");
  assert.equal(describeLabel("claude-opus-5-5 (reeval)").model, "claude-opus-5-5");
});
