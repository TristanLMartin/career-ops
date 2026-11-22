// hunt: the job page's Deep dive score choice. A deep dive (the full modes/oferta.md run,
// /api/run evaluationScope "deep") keeps the lite score on the tracker; POST {url, use: "deep"}
// ranks the job by the deep-dive score instead, {use: "lite"} goes back. Nothing is sent anywhere.
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { isTrackerWriting } from "@/lib/core/run-registry";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { chooseDeepDiveScore, readDeepDives } from "@/lib/hunt-lite-eval.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url).searchParams.get("url") ?? "";
  return Response.json({ entry: readDeepDives(careerOpsRoot())[url] ?? null });
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ url?: unknown; use?: unknown }>(req);
  if (!body || typeof body.url !== "string" || (body.use !== "lite" && body.use !== "deep")) {
    return Response.json({ error: "url and use (lite or deep) required" }, { status: 400 });
  }
  if (isTrackerWriting()) return Response.json({ error: "An evaluation is saving to the tracker. Try again in a moment." }, { status: 409 });
  let entry;
  try {
    entry = chooseDeepDiveScore(careerOpsRoot(), body.url, body.use, resolveCodeRoot(process.cwd(), process.env));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not update the tracker." }, { status: 500 });
  }
  if (!entry) return Response.json({ error: "No deep dive score to switch to for this job." }, { status: 404 });
  return Response.json({ entry });
}
