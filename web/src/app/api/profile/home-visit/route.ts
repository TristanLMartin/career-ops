// hunt: Home's last visit (data/home-last-visit.json), set by <HomeVisit/> after 10 s on Home
// or on leaving it. Written atomically.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const file = path.join(careerOpsRoot(), "data", "home-last-visit.json");
  const doc = { lastVisit: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}
