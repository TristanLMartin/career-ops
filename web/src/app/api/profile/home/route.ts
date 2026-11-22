// hunt: Home's "Needs you", "In flight" and "New since you last looked" as JSON (read-only),
// for the current profile. Same loader and helpers as <HuntHome/> (lib/hunt-home-data.ts).
import { loadHomeSections } from "@/lib/hunt-home-data";
import { homeApiBody } from "@/lib/hunt-home-v2.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(homeApiBody(loadHomeSections()), { headers: { "Cache-Control": "no-store" } });
}
