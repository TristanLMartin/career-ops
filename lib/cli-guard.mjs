// Safe command-line entry points for the scripts/hunt-*.mjs tools.
//
// exitOnHelp(): `--help` / `-h` prints the script's leading comment block (its usage) and exits
// 0 before anything is read, written, fetched or spent.
//
// requireSpendConsent(): scripts that call an LLM (and so cost money) refuse to run unless the
// caller says so explicitly, with `--yes` or CAREER_OPS_ALLOW_SPEND=1 (scripts/hunt-cron.sh
// passes --yes; its jobs only run for an active profile). Dry runs and estimates are always free.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** The leading `//` comment block of a script, without the slashes. */
export function usageOf(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out = [];
  for (const l of lines.slice(l0(lines))) {
    if (!/^\s*\/\//.test(l)) break;
    out.push(l.replace(/^\s*\/\/ ?/, ""));
  }
  return out.join("\n").trim();
}
const l0 = (lines) => (lines[0]?.startsWith("#!") ? 1 : 0);

export function wantsHelp(argv = process.argv.slice(2)) {
  return argv.includes("--help") || argv.includes("-h");
}

export function exitOnHelp(metaUrl, argv = process.argv.slice(2)) {
  if (!wantsHelp(argv)) return;
  console.log(usageOf(fileURLToPath(metaUrl)) || "No usage text.");
  process.exit(0);
}

/** True when spending is allowed: --yes, or CAREER_OPS_ALLOW_SPEND=1/true. */
export function spendAllowed(argv = process.argv.slice(2), env = process.env) {
  return argv.includes("--yes") || /^(1|true|yes)$/i.test(String(env.CAREER_OPS_ALLOW_SPEND ?? ""));
}

/**
 * Exit 2 with an explanation unless spending is allowed or this run is free (`freeFlags`, e.g.
 * --dry-run / --estimate, are present).
 */
export function requireSpendConsent(name, { argv = process.argv.slice(2), env = process.env, freeFlags = ["--dry-run", "--estimate"] } = {}) {
  if (freeFlags.some((f) => argv.includes(f)) || spendAllowed(argv, env)) return;
  console.error(`${name}: this calls an LLM through the Claude CLI and costs money. Re-run with --yes (or CAREER_OPS_ALLOW_SPEND=1) to go ahead${freeFlags.length ? `, or with ${freeFlags.join(" / ")} to see what it would do for free` : ""}.`);
  process.exit(2);
}
