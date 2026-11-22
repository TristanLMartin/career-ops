// hunt: every model run (dashboard, cron scripts, spot-checks) for the Workers page. Read-only.
import { careerOpsRoot } from "@/lib/career-ops";
import { readModelRuns } from "@/lib/hunt-model-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readModelRuns(careerOpsRoot()));
}
