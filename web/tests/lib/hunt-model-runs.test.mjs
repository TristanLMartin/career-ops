// hunt: Workers → Model runs groups bulk batches into one parent row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readModelRuns } from "../../src/lib/hunt-model-runs.mjs";

function fixture(liveRuns, usage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-runs-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "hunt-runs-live.json"), JSON.stringify({ runs: liveRuns }));
  fs.writeFileSync(path.join(root, "data", "hunt-usage.tsv"), "date\tmodel\tstatus\tsecs\ttokens\tcost_usd\treport\tcompany\trole\turl\n" + usage.map((r) => r.join("\t")).join("\n") + "\n");
  return root;
}

const T0 = Date.parse("2026-11-22T08:00:00Z");
const iso = (min) => new Date(T0 + min * 60_000).toISOString();

test("batch rows nest their jobs and spot-checks; other runs stay single", () => {
  const root = fixture({
    "batch:b1": { id: "batch:b1", kind: "batch", label: "sonnet 5.5 lite · 3 jobs", usageLabel: "claude-sonnet-5-5 (reeval lite)", model: "claude-sonnet-5-5", total: 3, done: 2, failed: 0, costUsd: 0.22, capUsd: 45, state: "running", startedAt: iso(0), updatedAt: iso(2) },
    "reeval:u1": { url: "u1", batch: "b1", state: "done", updatedAt: iso(1), finishedAt: iso(1) },
    "reeval:u2": { url: "u2", batch: "b1", state: "done", updatedAt: iso(2), finishedAt: iso(2) },
    "reeval:u3": { url: "u3", batch: "b1", kind: "lite eval (bulk)", model: "claude-sonnet-5-5", company: "C", role: "R", state: "running", updatedAt: iso(2) },
  }, [
    [iso(-30), "claude-sonnet-5-5 (reeval lite)", "ok", 40, 1, 0.11, 1, "Old", "Earlier", "u1"],
    [iso(1), "claude-sonnet-5-5 (reeval lite)", "ok", 40, 1, 0.11, 2, "A", "R1", "u1"],
    [iso(2), "claude-sonnet-5-5 (reeval lite)", "ok", 40, 1, 0.11, 3, "B", "R2", "u2"],
    [iso(2), "claude-opus-5-5 (spot-check lite)", "ok", 60, 1, 0.57, "", "A", "R1", "u1"],
    [iso(3), "claude-haiku-5-5 (quick score)", "ok", 5, 1, 0.01, "", "D", "R4", "u4"],
  ]);
  const { runs } = readModelRuns(root, { now: T0 + 3 * 60_000 });
  const batches = runs.filter((r) => r.type === "batch");
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(b.label, "sonnet 5.5 lite · 3 jobs");
  assert.equal(b.state, "running");
  assert.equal(b.children.length, 4); // 2 logged + 1 spot-check + 1 running
  assert.equal(b.spotchecks, 1);
  assert.equal(b.children[0].state, "running");
  assert.equal(b.costUsd, 0.79); // log total beats the script's pre-spot-check count
  // the same URL evaluated before the batch started is its own row
  assert.ok(runs.some((r) => r.type !== "batch" && r.company === "Old"));
  assert.ok(runs.some((r) => r.type !== "batch" && r.company === "D"));
  assert.ok(runs.every((r) => !("label" in r) || r.type === "batch"));
});

test("a batch silent for 30 minutes reads as stopped", () => {
  const root = fixture({ "batch:b2": { id: "batch:b2", label: "x", total: 5, done: 1, state: "running", startedAt: iso(0), updatedAt: iso(0) } }, []);
  const { runs } = readModelRuns(root, { now: T0 + 31 * 60_000 });
  assert.equal(runs[0].state, "stopped");
});
