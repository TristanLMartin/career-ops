// career-ops MCP server: Streamable HTTP, stateless, listens on 127.0.0.1 by default
// (CAREER_OPS_MCP_HOST / CAREER_OPS_MCP_PORT). Put a tunnel such as Tailscale Funnel in front of it.
// Auth: `Authorization: Bearer <token>` on /mcp, or the secret path /mcp/<token> (for clients
// that can't send headers). Anything else, or a wrong token, gets an empty 404.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, projectRoot } from "./config.mjs";
import { registerTools } from "./tools.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";

const MAX_BODY = 1 << 20;
const VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;

/** KEY=VALUE lines from a .env file (no expansion), or {}. */
export function readEnvFile(file) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
export function tokenMatches(candidate, token) {
  if (typeof candidate !== "string" || !candidate || !token) return false;
  return crypto.timingSafeEqual(digest(candidate), digest(token));
}

/** The token a request presents, or null: Bearer header on /mcp, or /mcp/<token>. */
export function presentedToken(req, pathname) {
  const p = pathname.replace(/\/+$/, "");
  if (p === "/mcp") {
    const h = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    return m ? m[1] : null;
  }
  const m = /^\/mcp\/([^/]+)$/.exec(p);
  return m ? decodeURIComponent(m[1]) : null;
}

export class RateLimiter {
  constructor({ limit = 120, windowMs = 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { limit, windowMs, now, hits: new Map() });
  }
  allow(key) {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) { h = { start: t, n: 0 }; this.hits.set(key, h); }
    h.n += 1;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (t - v.start >= this.windowMs) this.hits.delete(k);
    return h.n <= this.limit;
  }
}

export function makeLogger(dir) {
  const file = path.join(dir, "requests.log");
  fs.mkdirSync(dir, { recursive: true });
  return (entry) => {
    try {
      try { if (fs.statSync(file).size > 5 << 20) fs.renameSync(file, `${file}.1`); } catch { /* new file */ }
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch { /* logging must never break a request */ }
  };
}

function clientIp(req) {
  const remote = req.socket.remoteAddress ?? "";
  const loop = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return loop && fwd ? fwd : remote;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const end = (res, status, body = "", headers = {}) => { if (!res.headersSent) res.writeHead(status, headers); res.end(body); };

export function createMcpHttpServer({ config, token, logDir = path.join(projectRoot, "logs"), limiter = new RateLimiter() }) {
  if (!token || token.length < 32) throw new Error("MCP token missing or too short (need 32+ chars)");
  const log = makeLogger(logDir);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const ip = clientIp(req);
    if (!limiter.allow(ip)) { log({ ip, status: 429 }); return end(res, 429); }
    let pathname;
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { return end(res, 404); }
    if (!tokenMatches(presentedToken(req, pathname), token)) {
      log({ ip, status: 404, denied: true });
      return end(res, 404);
    }
    if (req.method !== "POST") return end(res, 405, JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }), { "content-type": "application/json", allow: "POST" });
    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw);
    } catch (err) {
      return end(res, err?.code === 413 ? 413 : 400, JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), { "content-type": "application/json" });
    }
    const rpc = (Array.isArray(body) ? body : [body]).map((m) => (typeof m?.method === "string" ? m.method : "?")).join(",").slice(0, 80);
    const server = new McpServer({ name: "career-ops", version: VERSION });
    registerTools(server, { config, onCall: (e) => log({ ip, ...e }) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      log({ ip, status: res.statusCode, rpc, ms: Date.now() - started });
    } catch (err) {
      console.error("mcp request failed:", err);
      log({ ip, status: 500, rpc });
      end(res, 500, JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }), { "content-type": "application/json" });
    }
  });
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("career-ops MCP server. Settings in mcp/.env (see .env.example): CAREER_OPS_MCP_TOKEN, CAREER_OPS_MCP_HOST, CAREER_OPS_MCP_PORT, CAREER_OPS_MCP_PROFILES. Start: npm start. Setup: mcp/README.md");
    process.exit(0);
  }
  const env = { ...readEnvFile(path.join(projectRoot, ".env")), ...process.env };
  const token = env.CAREER_OPS_MCP_TOKEN;
  const host = env.CAREER_OPS_MCP_HOST || "127.0.0.1";
  const port = Number(env.CAREER_OPS_MCP_PORT || 8765);
  if (!token || token.length < 24) {
    console.error("career-ops MCP: CAREER_OPS_MCP_TOKEN is missing or shorter than 24 characters. Run `npm run setup` in mcp/ first.");
    process.exit(1);
  }
  const config = loadConfig(undefined, env);
  const server = createMcpHttpServer({ config, token });
  server.listen(port, host, () => console.error(`career-ops MCP on http://${host}:${port}/mcp (profiles: ${Object.keys(config.profiles).join(", ")})`));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
