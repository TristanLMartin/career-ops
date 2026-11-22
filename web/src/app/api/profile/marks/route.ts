// hunt: Done / Won't respond marks and kind overrides for message threads and follow-up rows,
// in data/message-marks.json so the phone and the laptop agree. Written atomically (temp file,
// then rename). Nothing is ever sent or replied to; this only hides rows in the dashboard.
import { readJsonObject } from "@/lib/json-body";
import { messageMarksFile, readMessageMarks } from "@/lib/hunt-data";
import { applyMarkOp, normalizeMarks } from "@/lib/hunt-message-kinds.mjs";
import { MARKS_MAPS, updateJsonFile } from "@/lib/hunt-json-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readMessageMarks(), { headers: { "Cache-Control": "no-store" } });
}

// One request at a time inside this process, so read-modify-write stays consistent.
let chain: Promise<unknown> = Promise.resolve();

export async function POST(req: Request) {
  const body = await readJsonObject<{ op?: unknown; id?: unknown; mark?: unknown; kind?: unknown; lastDate?: unknown }>(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const run = chain.then(() => {
    // Merged into the file as it is on disk, so keys and per-item fields we don't know survive.
    const next = updateJsonFile(messageMarksFile(), normalizeMarks, (prev) => applyMarkOp(prev, {
      op: body.op,
      id: body.id,
      mark: body.mark ?? null,
      kind: body.kind ?? null,
      lastDate: body.lastDate,
    }), [...MARKS_MAPS]);
    if (!next) return { error: "bad op" as const };
    return { state: next };
  });
  chain = run.catch(() => undefined);
  const res = await run;
  if ("error" in res) return Response.json({ error: res.error }, { status: 400 });
  return Response.json(res.state, { headers: { "Cache-Control": "no-store" } });
}
