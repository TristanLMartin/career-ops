import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpHttpServer, tokenMatches, presentedToken, RateLimiter, readEnvFile } from "../src/server.mjs";
import { makeWorkspace } from "./helpers.mjs";

const TOKEN = "t".repeat(20) + "SecretToken0123456789abcdefABCDEF";
let ws, server, base, logDir;
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const post = (p, headers = {}, body = init) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

before(async () => {
  ws = makeWorkspace();
  logDir = path.join(ws.dir, "logs");
  server = createMcpHttpServer({ config: ws.configFor(1), token: TOKEN, logDir, limiter: new RateLimiter({ limit: 1000 }) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); ws.cleanup(); });

test("Bearer header on /mcp is accepted", async () => {
  const res = await post("/mcp", { authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.result.serverInfo.name, "career-ops");
});

test("secret path /mcp/<token> is accepted", async () => {
  const res = await post(`/mcp/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name, "career-ops");
});

test("wrong or missing token is an empty 404", async () => {
  for (const [p, h] of [["/mcp", {}], ["/mcp", { authorization: `Bearer ${TOKEN}x` }], ["/mcp", { authorization: TOKEN }], [`/mcp/${TOKEN.slice(1)}`, {}], ["/mcp/", {}]]) {
    const res = await post(p, h);
    assert.equal(res.status, 404, `${p} ${JSON.stringify(h)}`);
    assert.equal(await res.text(), "");
  }
});

test("every other path is an empty 404, even with the right header", async () => {
  for (const p of ["/", "/health", "/mcp/x/y", `/mcp/${TOKEN}/extra`, `/other/${TOKEN}`, "/.env"]) {
    const res = await post(p, { authorization: `Bearer ${TOKEN}` });
    assert.equal(res.status, 404, p);
    assert.equal(await res.text(), "");
  }
  const get = await fetch(base + "/");
  assert.equal(get.status, 404);
});

test("GET on an authorized path is 405 (stateless server, no SSE stream)", async () => {
  const res = await fetch(`${base}/mcp/${TOKEN}`);
  assert.equal(res.status, 405);
});

test("bad JSON is a 400", async () => {
  const res = await fetch(`${base}/mcp/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(res.status, 400);
});

test("request log records denials and calls, never the token", async () => {
  await post(`/mcp/${TOKEN}`, {}, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_study_today", arguments: {} } });
  const log = fs.readFileSync(path.join(logDir, "requests.log"), "utf8");
  assert.ok(!log.includes(TOKEN.slice(10)), "token leaked into log");
  assert.match(log, /"denied":true/);
  assert.match(log, /"tool":"get_study_today","profile":"me","ok":true/);
  assert.equal(fs.statSync(path.join(logDir, "requests.log")).mode & 0o777, 0o600);
});

test("tokenMatches is exact", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN + "a", TOKEN), false);
  assert.equal(tokenMatches("", TOKEN), false);
  assert.equal(tokenMatches(null, TOKEN), false);
  assert.equal(tokenMatches("x", ""), false);
});

test("presentedToken reads header only on /mcp and path only on /mcp/<t>", () => {
  const req = (h) => ({ headers: h });
  assert.equal(presentedToken(req({ authorization: "Bearer abc" }), "/mcp"), "abc");
  assert.equal(presentedToken(req({ authorization: "Bearer abc" }), "/mcp/"), "abc");
  assert.equal(presentedToken(req({}), "/mcp/abc"), "abc");
  assert.equal(presentedToken(req({ authorization: "Bearer abc" }), "/x"), null);
  assert.equal(presentedToken(req({}), "/mcp/a/b"), null);
});

test("rate limiter: per key, resets each window", () => {
  let now = 0;
  const rl = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(rl.allow("a"), true);
  assert.equal(rl.allow("a"), true);
  assert.equal(rl.allow("a"), false);
  assert.equal(rl.allow("b"), true);
  now = 1000;
  assert.equal(rl.allow("a"), true);
});

test("rate limit answers 429 over the limit", async () => {
  const s = createMcpHttpServer({ config: ws.configFor(1), token: TOKEN, logDir, limiter: new RateLimiter({ limit: 2 }) });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${s.address().port}/`;
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await fetch(url)).status);
  await new Promise((r) => s.close(r));
  assert.deepEqual(codes, [404, 404, 429]);
});

test("refuses to start without a long token", () => {
  assert.throws(() => createMcpHttpServer({ config: ws.configFor(1), token: "short", logDir }));
  assert.throws(() => createMcpHttpServer({ config: ws.configFor(1), token: undefined, logDir }));
});

test("readEnvFile parses KEY=VALUE and quotes", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "env-")), ".env");
  fs.writeFileSync(f, "# c\nCAREER_OPS_MCP_TOKEN=\"abc\"\nOTHER = x\n");
  assert.deepEqual(readEnvFile(f), { CAREER_OPS_MCP_TOKEN: "abc", OTHER: "x" });
  assert.deepEqual(readEnvFile(f + ".missing"), {});
});
