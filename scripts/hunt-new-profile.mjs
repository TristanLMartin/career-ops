#!/usr/bin/env node
// hunt-new-profile: create profiles/<id>/ from profiles/_template/.
// Never overwrites an existing profile. The new directory is gitignored (personal data).
//
// Usage: node scripts/hunt-new-profile.mjs <id> [--first-name Name]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/is-main-module.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function newProfile(id, { firstName = "", codeRoot = CODE_ROOT } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id) || id === "_template") throw new Error(`bad profile id: ${id}`);
  const dir = path.join(codeRoot, "profiles", id);
  if (fs.existsSync(dir)) throw new Error(`profiles/${id} already exists; not touching it`);
  fs.cpSync(path.join(codeRoot, "profiles", "_template"), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  if (firstName) {
    const f = path.join(dir, "config", "person.yml");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^first_name: ""/m, `first_name: ${JSON.stringify(firstName)}`));
  }
  return dir;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const id = process.argv[2];
  const i = process.argv.indexOf("--first-name");
  try {
    console.log(`created ${newProfile(id, { firstName: i > 0 ? process.argv[i + 1] : "" })}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
