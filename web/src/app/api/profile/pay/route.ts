// hunt: the job page pay line for one posting URL (read-only), for client pages like /jobs/[id].
// Same data and formatter as /pipeline/[id]: data/hunt-enrich.json via lib/hunt-job-pay.mjs.
import { readHuntEnrichment } from "@/lib/hunt-data";
import { findEnrichRow, payLine } from "@/lib/hunt-job-pay.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const url = q.get("url") ?? "";
  const tracker = q.get("tracker");
  if (!url && !tracker) return Response.json({ error: "url or tracker required" }, { status: 400 });
  const row = findEnrichRow(readHuntEnrichment().jobs, { urls: [url], tracker });
  return Response.json(payLine(row), { headers: { "Cache-Control": "no-store" } });
}
