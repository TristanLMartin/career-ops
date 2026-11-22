// Follow-ups as JSON (read-only), one row per opportunity with Done / Won't respond marks
// applied: the same readOpportunities() the /followups page renders, so the MCP server and the
// page can never drift. `when` is the page's own label (lib/hunt-followups.mjs whenLabel).
import { readOpportunities } from "@/lib/hunt-data";
import { whenLabel } from "@/lib/hunt-followups.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const now = Date.now();
  const followups = readOpportunities().map((o) => {
    let label: string | null = null;
    try { label = whenLabel(o, now) || null; } catch { /* label is optional */ }
    return { ...o, whenLabel: label };
  });
  return Response.json({ generatedAt: new Date(now).toISOString(), followups }, { headers: { "Cache-Control": "no-store" } });
}
