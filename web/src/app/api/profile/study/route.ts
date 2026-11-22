// hunt: Study page state (ticks and flashcard flags) in data/study-state.json, so the
// phone and the laptop share progress. Written atomically (temp file, then rename).
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { applyOp, normalizeState } from "@/lib/hunt-study.mjs";
import { STUDY_MAPS, updateJsonFile } from "@/lib/hunt-json-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const file = () => path.join(careerOpsRoot(), "data", "study-state.json");

function readState() {
  try { return normalizeState(JSON.parse(fs.readFileSync(file(), "utf8"))); } catch { return normalizeState({}); }
}

export async function GET() {
  return Response.json(readState(), { headers: { "Cache-Control": "no-store" } });
}

// Requests are handled one at a time inside this process, so read-modify-write stays consistent.
let chain: Promise<unknown> = Promise.resolve();

export async function POST(req: Request) {
  const body = await readJsonObject<{ op?: unknown; id?: unknown; value?: unknown; ops?: unknown }>(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 200) : [body];
  const run = chain.then(() => {
    // Merged into the file as it is on disk, so keys and per-item fields we don't know survive.
    const state = updateJsonFile(file(), normalizeState, (prev) => {
      let s = prev;
      for (const op of ops as { op?: unknown; id?: unknown; value?: unknown }[]) {
        const next = applyOp(s, { op: op?.op, id: op?.id, value: op?.op === "start" ? op?.value : op?.value === true });
        if (!next) return null;
        s = next;
      }
      return s;
    }, [...STUDY_MAPS]);
    if (!state) return { error: "bad op" as const };
    return { state };
  });
  chain = run.catch(() => undefined);
  const res = await run;
  if ("error" in res) return Response.json({ error: res.error }, { status: 400 });
  return Response.json(res.state, { headers: { "Cache-Control": "no-store" } });
}
