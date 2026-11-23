// evaluate_jobs / get_eval_run / list_eval_runs against the fixture, through career-ops' real
// eval hook. CAREER_OPS_EVAL_DRY_SPAWN=1 records the run without starting a worker, so nothing
// here spends; CAREER_OPS_EVAL_LOCK keeps the test off og's real one-run-at-a-time lock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeWorkspace, startFakeDashboard, callTool } from "./helpers.mjs";
import { jobId } from "../src/data.mjs";

let ws, dash, config;
before(async () => {
  process.env.CAREER_OPS_EVAL_DRY_SPAWN = "1";
  process.env.CAREER_OPS_EVAL_LOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "evlock-")), "eval-run.lock");
  ws = makeWorkspace(); dash = await startFakeDashboard(ws.root); config = ws.configFor(dash.port);
  // The fixture has no ranking config; the hook reads evals_paused from it.
  fs.mkdirSync(path.join(ws.root, "config"), { recursive: true });
  fs.writeFileSync(path.join(ws.root, "config", "ranking.yml"), "weights: {}\n");
});
after(async () => { await dash.close(); ws.cleanup(); });

const hooli = jobId("https://jobs.example.com/hooli/5");
const vandelay = jobId("https://jobs.example.com/vandelay/6");

test("evaluate_jobs: small run by job ids starts, and get_eval_run / list_eval_runs see it", async () => {
  // Unique checkout per test file: the profile's data dir is the fixture copy, not the checkout.
  const r = await callTool(config, "evaluate_jobs", { job_ids: [hooli, vandelay], model: "sonnet-lite", max_spend_usd: 1 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.value.run_id, /^ev-\d{12}-[0-9a-f]{4}$/);
  assert.equal(r.value.jobs, 2);
  assert.equal(r.value.estimate_usd, 0.25);
  assert.equal(r.value.cap_usd, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(ws.root, "data", "eval-runs", `${r.value.run_id}.json`), "utf8"));
  assert.deepEqual(manifest.jobs.map((j) => j.url), ["https://jobs.example.com/hooli/5", "https://jobs.example.com/vandelay/6"]);

  const s = await callTool(config, "get_eval_run", { run_id: r.value.run_id });
  assert.equal(s.isError, false, s.text);
  assert.equal(s.value.jobs_total, 2);
  assert.equal(s.value.spent_usd, 0);
  assert.equal(s.value.cap_usd, 1);
  assert.match(s.value.state, /^(queued|stalled)/);

  const l = await callTool(config, "list_eval_runs", {});
  assert.ok(l.value.runs.some((x) => x.run_id === r.value.run_id));
});

test("evaluate_jobs: over $10 needs confirm; pass 1 over the cap is refused", async () => {
  const big = await callTool(config, "evaluate_jobs", { job_ids: [hooli], model: "opus-full", max_spend_usd: 25 });
  assert.equal(big.isError, true);
  assert.match(big.text, /Not started: .*confirm: true only if the user approved/);
  const tight = await callTool(config, "evaluate_jobs", { job_ids: [hooli, vandelay], model: "opus-full", max_spend_usd: 2 });
  assert.equal(tight.isError, true);
  assert.match(tight.text, /pass 1 alone is estimated at \$3\.70/);
  const unknown = await callTool(config, "evaluate_jobs", { job_ids: ["jnothere00"], model: "sonnet-lite", max_spend_usd: 1 });
  assert.match(unknown.text, /Unknown job ids/);
});

test("evaluate_jobs: a paused profile is refused; bad run ids are rejected", async () => {
  fs.writeFileSync(path.join(ws.root, "config", "ranking.yml"), "evals_paused: true\n");
  try {
    const r = await callTool(config, "evaluate_jobs", { job_ids: [hooli], model: "sonnet-lite", max_spend_usd: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text, /paused/);
  } finally {
    fs.writeFileSync(path.join(ws.root, "config", "ranking.yml"), "weights: {}\n");
  }
  await assert.rejects(callTool(config, "get_eval_run", { run_id: "../../etc/passwd" }));
  const none = await callTool(config, "get_eval_run", { run_id: "ev-202601010000-abcd" });
  assert.equal(none.isError, true);
  assert.match(none.text, /no run/);
});
