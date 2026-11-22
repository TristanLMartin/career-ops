// hunt: the job page's "Tailor & apply" runs (cover letter PDF, apply answers).
// GET  ?report=274            → { cover, answers } run states for the panel to poll
// POST { report, kind, brief } → starts scripts/hunt-tailor-run.mjs detached (real upstream
// cover / apply modes, read-only worker, harness renders and fact-gates). Never submits anything.
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { readTailorState, startTailorRun, validateTailorRequest } from "@/lib/hunt-tailor.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const report = new URL(req.url).searchParams.get("report") ?? "";
  if (!/^\d{1,4}$/.test(report)) return Response.json({ error: "report must be a report number" }, { status: 400 });
  return Response.json(readTailorState(careerOpsRoot(), report), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const body = await readJsonObject<Record<string, unknown>>(req);
  const v = validateTailorRequest(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const r = startTailorRun({ root: careerOpsRoot(), codeRoot: resolveCodeRoot(process.cwd(), process.env), kind: v.kind, report: v.report, brief: v.brief });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json(r.state, { status: 202 });
}
