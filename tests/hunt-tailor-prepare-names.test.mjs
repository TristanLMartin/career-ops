// hunt: prepare-application.mjs honors candidate.first_name / last_name over the split of
// full_name, so a display name with a middle initial ("Sam Q. Example") prefills "Sam" / "Example".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function prefill(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-names-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "output"));
  fs.writeFileSync(path.join(root, "output", "cv.pdf"), "%PDF-fixture");
  fs.writeFileSync(path.join(root, "config", "profile.yml"), profile);
  return spawnSync(process.execPath, [path.join(ROOT, "prepare-application.mjs"), "--url", "https://jobs.ashbyhq.com/fictional/1", "--pdf", "output/cv.pdf"], { env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_PROFILE: "" }, encoding: "utf8" });
}

test("explicit first_name / last_name win over the full_name split", () => {
  const r = prefill('candidate:\n  full_name: "Sam Q. Example"\n  first_name: "Sam"\n  last_name: "Example"\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /firstName\s+Sam\n/);
  assert.match(r.stdout, /lastName\s+Example\n/);
});

test("without them the split is unchanged", () => {
  const r = prefill('candidate:\n  full_name: "Sam Q. Example"\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /lastName\s+Q\. Example\n/);
});
