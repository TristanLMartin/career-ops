// Test helpers: a throwaway copy of the fixture data dir, and a stand-in dashboard that serves the
// four write endpoints the same way the real routes do (the real set-status.mjs for /api/status,
// the dashboard's own applyMarkOp / applyOp for marks and study). It records every request.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../src/config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// The career-ops checkout this mcp/ folder sits in (its dashboard helpers and set-status.mjs).
export const CODE_ROOT = path.resolve(here, "..", "..");
const lib = (rel) => import(pathToFileURL(path.join(CODE_ROOT, "web/src/lib", rel)).href);

export function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-mcp-"));
  fs.cpSync(path.join(here, "fixture", "root"), path.join(dir, "root"), { recursive: true });
  return {
    dir,
    root: path.join(dir, "root"),
    configFor(port) {
      const file = path.join(dir, "profiles.json");
      fs.writeFileSync(file, JSON.stringify({
        codeRoot: CODE_ROOT,
        defaultProfile: "me",
        profiles: {
          me: { dataDir: "root", port, enabled: true },
          partner: { dataDir: "partner-missing", port: port + 1, enabled: true },
          off: { dataDir: "root", port, enabled: false },
        },
      }));
      return loadConfig(file);
    },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function atomicJson(file, doc) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
  fs.renameSync(tmp, file);
}

const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { r(JSON.parse(s)); } catch { r(null); } }); });

export async function startFakeDashboard(root) {
  const kinds = await lib("hunt-message-kinds.mjs");
  const study = await lib("hunt-study.mjs");
  const statusCli = await lib("status-cli.mjs");
  const calls = [];
  // GET /api/profile/home: tests set `home` to the body to serve, or to { status, body } to fail.
  const state = { home: { ...HOME_FIXTURE } };
  const send = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/profile/followups") {
      calls.push({ method: req.method, url: req.url, body: null });
      const { followupsBody } = await import("./followups-reader.mjs");
      return send(res, 200, await followupsBody({ id: "me", dataDir: root, codeRoot: CODE_ROOT, profileDir: null }));
    }
    if (req.method === "GET" && req.url === "/api/profile/home") {
      calls.push({ method: req.method, url: req.url, body: null });
      const h = state.home;
      if (h && typeof h.status === "number") { res.writeHead(h.status, { "content-type": "text/plain" }); return res.end(String(h.body ?? "")); }
      return send(res, 200, h);
    }
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, body });
    if (req.method !== "POST" || !body) return send(res, 400, { error: "bad request" });
    if (req.url === "/api/status") {
      const args = ["--row", String(body.n), body.status];
      if (body.note !== undefined) { if (body.replaceNote) args.push("--replace-note", body.replaceNote); args.push(`--note=${body.note}`); }
      args.push("--source", "web", "--detach-jd-archive", "--json");
      execFile(process.execPath, [path.join(CODE_ROOT, "set-status.mjs"), ...args], { cwd: CODE_ROOT, env: { ...process.env, CAREER_OPS_ROOT: root } }, (err, stdout) => {
        const parsed = statusCli.parseCliJson(stdout);
        if (err) return send(res, err.code === 2 ? 404 : 400, { error: parsed?.message ?? parsed?.error ?? "failed", code: parsed?.code });
        send(res, 200, { ok: true, status: parsed?.newStatus, changed: parsed?.changed === true });
      });
      return;
    }
    if (req.url === "/api/profile/marks") {
      const file = path.join(root, "data", "message-marks.json");
      let state; try { state = kinds.normalizeMarks(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { state = kinds.normalizeMarks({}); }
      const next = kinds.applyMarkOp(state, { op: body.op, id: body.id, mark: body.mark ?? null, kind: body.kind ?? null, lastDate: body.lastDate });
      if (!next) return send(res, 400, { error: "bad op" });
      atomicJson(file, next);
      return send(res, 200, next);
    }
    if (req.url === "/api/profile/study") {
      const file = path.join(root, "data", "study-state.json");
      let state; try { state = study.normalizeState(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { state = study.normalizeState({}); }
      const next = study.applyOp(state, { op: body.op, id: body.id, value: body.value === true });
      if (!next) return send(res, 400, { error: "bad op" });
      atomicJson(file, next);
      return send(res, 200, next);
    }
    if (req.url === "/api/profile/add-job") {
      if (body.url.includes("acme/1")) return send(res, 200, { status: "duplicate", reason: "same posting URL", match: { num: 1, company: "Acme Robotics", role: "Senior Backend Engineer", status: "Interview", url: "https://jobs.example.com/acme/1" } });
      if (body.url.includes("linkedin")) return send(res, 200, { status: "need-details", message: "Add the company and title." });
      return send(res, 200, { status: "added", job: { url: body.url, company: body.company ?? "NewCo", title: body.title ?? "Engineer", location: "", ats: "other", hasDescription: false } });
    }
    send(res, 404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, calls,
    setHome(h) { state.home = h; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** What the fake dashboard's /api/profile/home serves by default (the shape of homeApiBody). */
export const HOME_FIXTURE = {
  needs: [
    { id: "nonext:1", label: "Acme Robotics · Senior Backend Engineer", detail: "Interview with no next step set", action: "Set next step", href: "/tracker" },
    { id: "msg:gmail:t1", label: "Sam Sample · Globex", detail: "You owe a reply", action: "Reply", href: "https://mail.example.com/t1", external: true },
  ],
  inFlight: [
    { n: "1", company: "Acme Robotics", role: "Senior Backend Engineer", status: "Interview", updated: "2026-11-20", next: "Acme onsite (via Paraform) Tue 11/24 1:00 PM PT" },
    { n: "2", company: "Globex", role: "Platform Engineer", status: "Applied", updated: "2026-11-18", next: "" },
  ],
  opportunities: [
    { url: "https://jobs.example.com/hooli/3", company: "Hooli", role: "Staff Engineer", rank: 3, fit: 4, composite: 0.71, tracker: null },
  ],
};

/** Run a tool's handler directly and parse its JSON (or text) result. */
export async function callTool(config, name, args = {}) {
  const { TOOLS } = await import("../src/tools.mjs");
  const { registerTools } = await import("../src/tools.mjs");
  const handlers = {};
  registerTools({ registerTool: (n, _meta, fn) => { handlers[n] = fn; } }, { config });
  if (!TOOLS[name]) throw new Error(`no tool ${name}`);
  const { z } = await import("zod");
  const parsed = z.object(TOOLS[name].input).parse(args); // apply defaults like the SDK does
  const out = await handlers[name](parsed);
  const text = out.content[0].text;
  let value = text;
  try { value = JSON.parse(text); } catch { /* text tool */ }
  return { isError: !!out.isError, value, text };
}
