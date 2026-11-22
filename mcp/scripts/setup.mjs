#!/usr/bin/env node
// Setup for the career-ops MCP server: creates mcp/.env from .env.example with a fresh random
// token when none is set, and optionally installs the systemd user unit.
//
//   npm run setup                 create .env (keeps an existing token)
//   npm run setup -- --rotate     replace the token (every client must get the new URL)
//   npm run setup -- --systemd    also write ~/.config/systemd/user/career-ops-mcp.service
//
// Prints the local MCP URL with the token masked. The full URL is a secret: print it with
// --show-url only when you are about to paste it into claude.ai.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../../lib/is-main-module.mjs";

const MCP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = path.join(MCP_DIR, ".env");
const args = new Set(process.argv.slice(2));

export function newToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** .env text with CAREER_OPS_MCP_TOKEN set (added, or replaced when rotate / empty). */
export function withToken(text, { rotate = false, token = newToken() } = {}) {
  const re = /^CAREER_OPS_MCP_TOKEN=(.*)$/m;
  const m = text.match(re);
  if (m && m[1].trim().length >= 24 && !rotate) return { text, changed: false };
  const line = `CAREER_OPS_MCP_TOKEN=${token}`;
  return { text: m ? text.replace(re, line) : `${line}\n${text}`, changed: true };
}

function readEnv(text) {
  const out = {};
  for (const l of text.split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
}

function main() {
  const base = fs.existsSync(ENV) ? fs.readFileSync(ENV, "utf8") : fs.readFileSync(path.join(MCP_DIR, ".env.example"), "utf8");
  const { text, changed } = withToken(base, { rotate: args.has("--rotate") });
  if (changed || !fs.existsSync(ENV)) {
    fs.writeFileSync(ENV, text, { mode: 0o600 });
    fs.chmodSync(ENV, 0o600);
    console.log(`${changed ? "wrote a new token to" : "created"} ${ENV} (mode 600)`);
  } else console.log(`kept the existing token in ${ENV}`);
  const env = readEnv(text);
  const host = env.CAREER_OPS_MCP_HOST || "127.0.0.1";
  const port = env.CAREER_OPS_MCP_PORT || "8765";
  const tok = env.CAREER_OPS_MCP_TOKEN;
  console.log(`local URL: http://${host}:${port}/mcp/${args.has("--show-url") ? tok : `${tok.slice(0, 4)}…(secret; --show-url prints it)`}`);

  if (args.has("--systemd")) {
    const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(unitDir, { recursive: true });
    const unit = fs.readFileSync(path.join(MCP_DIR, "deploy", "career-ops-mcp.service.template"), "utf8")
      .replace(/^#.*\n/gm, (l) => (l.startsWith("# systemd user unit") || l.startsWith("# Token") ? l : ""))
      .replaceAll("@MCP_DIR@", MCP_DIR)
      .replaceAll("@NODE@", process.execPath);
    const file = path.join(unitDir, "career-ops-mcp.service");
    fs.writeFileSync(file, unit);
    console.log(`wrote ${file}\nnext: systemctl --user daemon-reload && systemctl --user enable --now career-ops-mcp`);
  }
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: npm run setup [-- --rotate] [-- --systemd] [-- --show-url]  (see the header of mcp/scripts/setup.mjs)");
    process.exit(0);
  }
  main();
}
