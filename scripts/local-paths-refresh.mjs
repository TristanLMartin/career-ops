#!/usr/bin/env node
// local-paths-refresh: rewrite config/local-paths.txt from git, listing every tracked file that
// an upstream career-ops ref does not have (collapsed to a directory when upstream has none of
// that directory). Read-only apart from that one file; --dry-run prints instead.
//
// Usage: node scripts/local-paths-refresh.mjs [--ref upstream/main] [--dry-run]
//   Add upstream first if needed: git remote add upstream https://github.com/santifer/career-ops && git fetch upstream main
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitOnHelp } from "../lib/cli-guard.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const ref = argv.includes("--ref") ? argv[argv.indexOf("--ref") + 1] : "upstream/main";
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);

export function localPaths(tracked, upstream) {
  const up = new Set(upstream);
  const upDirs = new Set(upstream.flatMap((f) => f.split("/").slice(0, -1).map((_, i, p) => p.slice(0, i + 1).join("/"))));
  const out = new Set();
  for (const f of tracked) {
    if (up.has(f)) continue;
    const parts = f.split("/");
    let chosen = f;
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join("/"); if (!upDirs.has(d)) { chosen = `${d}/`; break; } }
    out.add(chosen);
  }
  return [...out].sort();
}

const file = path.join(ROOT, "config", "local-paths.txt");
const header = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("#")).join("\n");
const body = localPaths(git("ls-files"), git("ls-tree", "-r", "--name-only", ref)).join("\n");
if (argv.includes("--dry-run")) console.log(body);
else { fs.writeFileSync(file, `${header}\n${body}\n`); console.log(`local-paths-refresh: ${body.split("\n").length} entries -> config/local-paths.txt`); }
