// hunt: starred companies, data/hunt-stars.json (lib/hunt-stars.mjs). A star is only a
// Jobs filter; it never changes the ranking. Written atomically; a malformed file is refused
// rather than overwritten. Nothing is ever sent.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { applyStarOp, normalizeStarsDoc } from "@/lib/hunt-stars.mjs";
import { updateJsonFile } from "@/lib/hunt-json-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const starsFile = () => path.join(careerOpsRoot(), "data", "hunt-stars.json");

function readStars(file: string): { companies: string[] } | { error: string } {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { companies: [] } : { error: (e as Error).message };
  }
  try { return normalizeStarsDoc(JSON.parse(text)); } catch { return { error: `${path.basename(file)} is not valid JSON; fix or remove it before starring` }; }
}

export async function GET() {
  const doc = readStars(starsFile());
  if ("error" in doc) return Response.json({ error: doc.error }, { status: 409 });
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}

let chain: Promise<unknown> = Promise.resolve();

export async function POST(req: Request) {
  const body = await readJsonObject<{ company?: unknown; starred?: unknown }>(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const file = starsFile();
  const run = chain.then(() => {
    const now = readStars(file);
    if ("error" in now) return { error: now.error, status: 409 };
    const next = updateJsonFile(file, normalizeStarsDoc, (prev: { companies: string[] }) => applyStarOp(prev, { company: body.company as string, starred: body.starred as boolean }));
    if (!next) return { error: "bad star", status: 400 };
    return { companies: next.companies };
  });
  chain = run.catch(() => undefined);
  const res = await run;
  if ("error" in res) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res, { headers: { "Cache-Control": "no-store" } });
}
