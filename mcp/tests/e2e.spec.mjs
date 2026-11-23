// End to end: the real HTTP server on a random port, the MCP SDK client over Streamable HTTP
// (secret-path auth, as claude.ai uses it), and the stand-in dashboard for writes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "../src/server.mjs";
import { makeWorkspace, startFakeDashboard } from "./helpers.mjs";
import { listTree } from "../../lib/walk-tree.mjs";

const TOKEN = "e2e-" + "x".repeat(44);
let ws, dash, server, client;

function snapshot(dir) {
  const out = {};
  for (const p of listTree(dir)) out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
  return out;
}

before(async () => {
  ws = makeWorkspace();
  dash = await startFakeDashboard(ws.root);
  server = createMcpHttpServer({ config: ws.configFor(dash.port), token: TOKEN, logDir: path.join(ws.dir, "logs") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp/${TOKEN}`)));
});
after(async () => { await client.close(); await new Promise((r) => server.close(r)); await dash.close(); ws.cleanup(); });

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  try { return { r, v: JSON.parse(text) }; } catch { return { r, v: text }; }
};

test("lists exactly the twenty-one tools, all with descriptions and a profile arg", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["add_job_by_url", "complete_study_task", "evaluate_jobs", "get_eval_run", "get_job", "get_study_today", "get_summary", "list_eval_runs", "list_followups", "list_tracker", "mark_followup", "search_jobs", "update_tracker", "get_study_plan", "add_study_task", "update_study_task", "archive_study_task", "unarchive_study_task", "add_study_day", "update_study_day", "add_study_cards"].sort());
  for (const t of tools) {
    assert.ok(t.description.length > 30, t.name);
    assert.ok(t.inputSchema.properties.profile, t.name);
  }
});

test("read tools leave the data dir byte-for-byte unchanged", async () => {
  const before = snapshot(ws.root);
  const s = await call("search_jobs", { limit: 3 });
  assert.equal(s.v.jobs.length, 3);
  await call("get_job", { id: s.v.jobs[0].id });
  await call("list_tracker");
  await call("list_followups", { include_done: true });
  await call("get_study_today");
  const sum = await call("get_summary");
  assert.match(sum.v, /Needs you/);
  assert.deepEqual(snapshot(ws.root), before);
  assert.deepEqual(dash.calls.map((c) => `${c.method} ${c.url}`), ["GET /api/profile/followups", "GET /api/profile/home"], "reads only GET the read-only Follow-ups and Home routes");
});

test("a write goes through the dashboard and shows up in the next read", async () => {
  const u = await call("update_tracker", { id: "2", status: "Responded", append_note: "Recruiter replied" });
  assert.equal(u.r.isError, undefined);
  assert.equal(u.v.entry.status, "Responded");
  assert.equal(dash.calls.filter((c) => c.url === "/api/status").length, 1);
  const t = await call("list_tracker", { status: "Responded" });
  assert.equal(t.v.entries[0].n, "2");
  assert.match(t.v.entries[0].notes, /Recruiter replied/);
});

test("tool errors come back as isError results, not transport failures", async () => {
  const r = await client.callTool({ name: "get_job", arguments: { id: "missing" } });
  assert.equal(r.isError, true);
  const p = await client.callTool({ name: "list_tracker", arguments: { profile: "nobody" } });
  assert.equal(p.isError, true);
  assert.match(p.content[0].text, /Unknown profile/);
});
