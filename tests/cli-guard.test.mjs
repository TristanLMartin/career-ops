// lib/cli-guard.mjs: --help exits before side effects; LLM scripts need explicit consent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spendAllowed } from "../lib/cli-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEND = ["hunt-autoscore", "hunt-quickscore", "hunt-h2h", "hunt-h2h-insert", "hunt-message-kinds", "hunt-discovery-boards", "hunt-reeval", "hunt-tailor-run"];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-guard-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, "root"));
  // A fake `claude` that records any call, so a test can prove none happened.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho called >> "${dir}/claude-called"\nexit 1\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAREER_OPS_ROOT: path.join(dir, "root"), CAREER_OPS_PROFILE_DIR: "", CAREER_OPS_ALLOW_SPEND: "" };
  return { dir, env, called: () => fs.existsSync(path.join(dir, "claude-called")), files: () => fs.readdirSync(path.join(dir, "root")) };
}

test("every scripts/*.mjs answers --help with usage, exit 0, no files written", () => {
  const s = sandbox();
  // Every CLI (a module with an isMainModule entry point); libraries such as hunt-job-filters are skipped.
  const scripts = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^(hunt-.*|onboard|migrate-legacy-names|local-paths-refresh)\.mjs$/.test(f) && /isMainModule\(import\.meta\.url\)|exitOnHelp\(/.test(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8")));
  assert.ok(scripts.length >= 18);
  for (const f of scripts) {
    const r = spawnSync(process.execPath, [path.join("scripts", f), "--help"], { cwd: ROOT, env: s.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    assert.ok(r.stdout.trim().length > 20, `${f} prints usage`);
  }
  assert.deepEqual(s.files(), [], "nothing written");
  assert.equal(s.called(), false, "claude never called");
});

test("LLM scripts refuse to run without --yes, and never reach claude", () => {
  const s = sandbox();
  for (const name of SPEND) {
    const r = spawnSync(process.execPath, [path.join("scripts", `${name}.mjs`)], { cwd: ROOT, env: s.env, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, `${name} exits 2`);
    assert.match(r.stderr, /costs money.*--yes/);
  }
  assert.equal(s.called(), false);
  assert.deepEqual(s.files(), []);
});

test("spendAllowed: --yes or CAREER_OPS_ALLOW_SPEND", () => {
  assert.equal(spendAllowed([], {}), false);
  assert.equal(spendAllowed(["--yes"], {}), true);
  assert.equal(spendAllowed([], { CAREER_OPS_ALLOW_SPEND: "1" }), true);
  assert.equal(spendAllowed([], { CAREER_OPS_ALLOW_SPEND: "0" }), false);
});

test("hunt-cron.sh passes --yes to every LLM job", () => {
  const sh = fs.readFileSync(path.join(ROOT, "scripts", "hunt-cron.sh"), "utf8");
  for (const name of ["hunt-autoscore", "hunt-quickscore", "hunt-h2h", "hunt-message-kinds", "hunt-discovery-boards"]) {
    for (const line of sh.split("\n").filter((l) => l.includes(`scripts/${name}.mjs`))) assert.match(line, /--yes/, line);
  }
});
