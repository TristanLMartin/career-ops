// hunt: serve a file a Tailor & apply run wrote, by report + kind (never an arbitrary path).
// ?report=274&kind=cover → the cover PDF; ?report=274&kind=answers → the answers markdown.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, isRegularContainedFile } from "@/lib/career-ops";
import { inlineDisposition } from "@/lib/content-disposition.mjs";
import { readOne } from "@/lib/hunt-tailor.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const report = q.get("report") ?? "";
  const kind = q.get("kind") ?? "";
  if (!/^\d{1,4}$/.test(report) || !["cover", "answers"].includes(kind)) return new Response("bad request", { status: 400 });
  const root = careerOpsRoot();
  const s = readOne(root, report, kind);
  const rel = kind === "cover" ? s?.outputs?.pdf : s?.outputs?.markdown;
  if (typeof rel !== "string") return new Response("not found", { status: 404 });
  const file = path.resolve(root, rel);
  if (!isRegularContainedFile(file, path.join(root, "output"))) return new Response("not found", { status: 404 });
  const type = kind === "cover" ? "application/pdf" : "text/markdown; charset=utf-8";
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "Content-Type": type, "Content-Disposition": inlineDisposition(path.basename(file)), "Cache-Control": "no-store" } });
}
