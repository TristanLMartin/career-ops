#!/usr/bin/env node
// Validates config/comp.json (schema, required fields, sane ranges, TC/base ratio
// 1.0-4.0, as_of older than 6 months flagged). Exit 1 on errors; warnings print only.
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { validateComp } from "../lib/hunt-comp-validate.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";
if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);

const file = path.join(getCareerOpsRoot(), "config", "comp.json");
let doc;
try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { console.error(`hunt-comp-validate: cannot read ${file}: ${e.message}`); process.exit(1); }
const { errors, warnings } = validateComp(doc);
for (const w of warnings) console.log(`warn  ${w}`);
for (const e of errors) console.log(`error ${e}`);
console.log(`hunt-comp-validate: ${doc.length ?? 0} entries, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
