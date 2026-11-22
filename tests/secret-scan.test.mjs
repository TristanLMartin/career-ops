// scripts/secret-scan.sh: finds secret-looking strings and personal words in tracked files and in
// history, honors .secret-scan-allow, and passes a clean repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
  git(dir, "init", "-q");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "secret-scan.sh"), path.join(dir, "scripts", "secret-scan.sh"));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "x");
  return dir;
}
// Pattern layer only (gitleaks off), so the test needs nothing installed.
const scan = (dir, ...args) => spawnSync("bash", ["scripts/secret-scan.sh", ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin", HOME: dir } });

test("a clean repo passes", () => {
  const r = scan(repo({ "a.md": "hello\n" }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /clean/);
});

test("an API key or a filled-in token fails", () => {
  for (const text of ["key: sk-ant-api03-" + "x".repeat(40) + "\n", "CAREER_OPS_MCP_TOKEN=" + "A".repeat(40) + "\n", "url: https://box.tail1234ab.ts.net/mcp\n"]) {
    const r = scan(repo({ "cfg.txt": text }));
    assert.equal(r.status, 1, text);
  }
});

test("personal words from .secret-scan-words are caught in files and history, allow rules skip lines", () => {
  const dir = repo({ ".gitignore": ".secret-scan-words\n", "notes.md": "contact Jamie Q. Example\n", ".secret-scan-allow": "Jamie Q\\. Example is fictional\n" });
  fs.writeFileSync(path.join(dir, ".secret-scan-words"), "# mine\njamie q. example\n");
  assert.equal(scan(dir).status, 1, "tree");
  fs.writeFileSync(path.join(dir, "notes.md"), "nothing here\n");
  git(dir, "commit", "-qam", "scrub");
  assert.equal(scan(dir).status, 0, "tree is clean now");
  assert.equal(scan(dir, "--history").status, 1, "but history still has it");
  fs.writeFileSync(path.join(dir, "ok.md"), "Jamie Q. Example is fictional\n");
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "allowed");
  assert.equal(scan(dir).status, 0, "allow-listed line passes");
});

test("--help prints usage and exits 0", () => {
  const r = spawnSync("bash", [path.join(ROOT, "scripts", "secret-scan.sh"), "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--pre-push/);
});
