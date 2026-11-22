// hunt: the user's own 1-5 rating of a job, in data/hunt-ratings.json. Best overall reads it
// as its strongest signal (4-5 lifts a job above every unrated one, 1-3 sinks it). Written
// atomically; a malformed file is refused rather than overwritten. Nothing is ever sent.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { applyRatingOp, normalizeRatingsDoc } from "@/lib/hunt-job-signals.mjs";
import { updateJsonFile } from "@/lib/hunt-json-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ratingsFile = () => path.join(careerOpsRoot(), "data", "hunt-ratings.json");

/** null when the file is missing or valid JSON; an error message when it exists but is broken. */
function brokenFile(file: string): string | null {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : (e as Error).message;
  }
  try { JSON.parse(text); return null; } catch { return `${path.basename(file)} is not valid JSON; fix or remove it before rating`; }
}

let chain: Promise<unknown> = Promise.resolve();

export async function POST(req: Request) {
  const body = await readJsonObject<{ url?: unknown; rating?: unknown; note?: unknown }>(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const file = ratingsFile();
  const run = chain.then(() => {
    const broken = brokenFile(file);
    if (broken) return { error: broken, status: 409 };
    const next = updateJsonFile(file, normalizeRatingsDoc, (prev: ReturnType<typeof normalizeRatingsDoc>) => applyRatingOp(prev, { url: body.url as string, rating: body.rating === null ? null : (body.rating as number), note: typeof body.note === "string" ? body.note : undefined }), ["ratings"]);
    if (!next) return { error: "bad rating", status: 400 };
    return { rating: next.ratings[body.url as string] ?? null };
  });
  chain = run.catch(() => undefined);
  const res = await run;
  if ("error" in res) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res, { headers: { "Cache-Control": "no-store" } });
}
