// hunt: "Add a job" by URL. Runs scripts/hunt-add-job.mjs (dedupe via the core's
// precheck-duplicate/url-key, JD via fetch-jd's API dispatch, write via scan.mjs's
// appendToPipeline/appendToScanHistory, then hunt-enrich). Zero AI tokens.
import { spawn } from "node:child_process";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

export async function POST(req: Request) {
  const body = await readJsonObject<{ url?: unknown; company?: unknown; title?: unknown; location?: unknown; jd?: unknown; force?: unknown }>(req);
  if (!body) return Response.json({ status: "error", message: "bad request" }, { status: 400 });
  const input = { url: str(body.url, 2000).trim(), company: str(body.company, 200), title: str(body.title, 300), location: str(body.location, 200), jd: str(body.jd, 60000) };
  const script = path.join(path.dirname(rootScript("scan")), "scripts", "hunt-add-job.mjs");
  const args = [script, ...(body.force === true ? ["--force"] : [])];
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: resolveCodeRoot(process.cwd(), process.env), env: { ...process.env, CAREER_OPS_ROOT: careerOpsRoot() }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", () => { clearTimeout(timer); resolve(stdout); });
    child.stdin.end(JSON.stringify(input));
  });
  const last = out.trim().split("\n").pop() ?? "";
  try {
    return Response.json(JSON.parse(last));
  } catch {
    return Response.json({ status: "error", message: "The add-job helper didn't answer. Try again." }, { status: 500 });
  }
}
