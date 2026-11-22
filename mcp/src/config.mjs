// Profile config: which career-ops data dir and dashboard URL each profile uses.
// Sources, first match wins:
//   1. CAREER_OPS_MCP_CONFIG=<file> or config/profiles.json (see config/profiles.example.json)
//   2. environment / mcp/.env: CAREER_OPS_CODE_ROOT (default: the checkout this mcp/ folder
//      sits in) and CAREER_OPS_MCP_PROFILES, a comma list of id=profileDir@dashboardUrl, e.g.
//      "me=.@http://127.0.0.1:3000,partner=profiles/partner@http://127.0.0.1:3001"
//      (profileDir is relative to the code root; "." is the default profile).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class ToolError extends Error {}

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

/** Profiles from CAREER_OPS_MCP_PROFILES (see the header). */
export function configFromEnv(env = process.env) {
  const codeRoot = path.resolve(projectRoot, env.CAREER_OPS_CODE_ROOT || "..");
  const spec = String(env.CAREER_OPS_MCP_PROFILES || `me=.@http://127.0.0.1:${env.CAREER_OPS_WEB_PORT || 3000}`);
  const profiles = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9_-]{0,40})=([^@]+)@(https?:\/\/\S+)$/i.exec(part);
    if (!m) throw new Error(`CAREER_OPS_MCP_PROFILES: can't read "${part}" (want id=profileDir@http://host:port)`);
    const [, id, dir, url] = m;
    const rel = dir.trim();
    profiles[id] = { id, dataDir: path.resolve(codeRoot, rel), url: url.replace(/\/+$/, ""), profileDir: rel === "." ? null : rel, enabled: true, codeRoot };
  }
  if (!Object.keys(profiles).length) throw new Error("CAREER_OPS_MCP_PROFILES lists no profiles");
  return { codeRoot, defaultProfile: env.CAREER_OPS_MCP_DEFAULT_PROFILE || Object.keys(profiles)[0], profiles };
}

export function loadConfig(file = process.env.CAREER_OPS_MCP_CONFIG || path.join(projectRoot, "config", "profiles.json"), env = process.env) {
  if (!process.env.CAREER_OPS_MCP_CONFIG && !fs.existsSync(file)) return configFromEnv(env);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const base = path.dirname(file);
  if (!doc || typeof doc.profiles !== "object") throw new Error(`${file}: missing "profiles"`);
  const codeRoot = path.resolve(base, doc.codeRoot);
  const profiles = {};
  for (const [id, p] of Object.entries(doc.profiles)) {
    profiles[id] = {
      id,
      dataDir: path.resolve(base, p.dataDir),
      // Dashboard base URL: `url`, or http://<host>:<port> (older configs).
      url: String(p.url ?? `http://${p.host ?? "127.0.0.1"}:${Number(p.port)}`).replace(/\/+$/, ""),
      port: Number(p.port) || null,
      host: p.host ?? "127.0.0.1",
      profileDir: p.profileDir ?? null,
      enabled: p.enabled !== false,
      codeRoot,
    };
  }
  return { codeRoot, defaultProfile: doc.defaultProfile ?? Object.keys(profiles)[0], profiles };
}

/** The named profile, or a ToolError a model can act on. */
export function resolveProfile(config, name) {
  const id = name == null || name === "" ? config.defaultProfile : String(name);
  const p = config.profiles[id];
  const known = Object.keys(config.profiles).join(", ");
  if (!p) throw new ToolError(`Unknown profile "${id}". Known profiles: ${known}.`);
  if (!p.enabled) throw new ToolError(`Profile "${id}" is turned off in the MCP profile config.`);
  if (!fs.existsSync(path.join(p.dataDir, "data"))) throw new ToolError(`Profile "${id}" is inactive: it has no data directory yet.`);
  return p;
}
