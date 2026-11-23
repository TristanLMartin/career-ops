// edits to the study plan (data/study/days.md) and the flashcard deck
// (data/study/cards.jsonl), through lib/hunt-study-plan.mjs. Every change is written
// atomically, the previous file is kept under data/study/history/, and the edit is logged to
// data/study/plan-edits.jsonl with its time and who made it ("via"), so it can be undone by
// restoring that copy. Done state lives in data/study-state.json and survives every edit.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { readJsonObject } from "@/lib/json-body";
import { addCards, addDay, addTask, PlanError, setArchived, updateDay, updateTask } from "@/lib/hunt-study-plan.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const studyDir = () => path.join(careerOpsRoot(), "data", "study");

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

type Body = Record<string, unknown> & { op?: unknown; via?: unknown };

function apply(body: Body, days: string, cards: string): { file: "days" | "cards"; text: string; result: Record<string, unknown> } {
  const a = body as Record<string, never>;
  switch (body.op) {
    case "add_task": { const r = addTask(days, { day: a.day, type: a.type, text: a.text, star: a.star, position: a.position }); return { file: "days", text: r.md, result: { task: r.task } }; }
    case "update_task": { const r = updateTask(days, String(a.task_id ?? ""), { text: a.text, type: a.type, star: a.star, day: a.day, position: a.position }); return { file: "days", text: r.md, result: { task: r.task } }; }
    case "archive_task": { const r = setArchived(days, String(a.task_id ?? ""), true); return { file: "days", text: r.md, result: { task: r.task } }; }
    case "unarchive_task": { const r = setArchived(days, String(a.task_id ?? ""), false); return { file: "days", text: r.md, result: { task: r.task } }; }
    case "add_day": { const r = addDay(days, { after_day: a.after_day, theme: a.theme, title: a.title, section: a.section }); return { file: "days", text: r.md, result: { day: r.day } }; }
    case "update_day": { const r = updateDay(days, a.day, { theme: a.theme, title: a.title, section: a.section }); return { file: "days", text: r.md, result: { day: a.day, moved_to: r.moved_to } }; }
    case "add_cards": { const r = addCards(cards, a.cards as unknown as { front: string; back: string; tags?: string[] }[]); return { file: "cards", text: r.jsonl, result: { added: r.added, skipped: r.skipped } }; }
    default: throw new PlanError(`Unknown op "${String(body.op)}".`);
  }
}

let chain: Promise<unknown> = Promise.resolve();

export async function POST(req: Request) {
  const body = await readJsonObject<Body>(req);
  if (!body) return Response.json({ error: "bad request" }, { status: 400 });
  const via = typeof body.via === "string" && body.via.trim() ? body.via.trim().slice(0, 40) : "dashboard";
  const run = chain.then(() => {
    const dir = studyDir();
    const daysFile = path.join(dir, "days.md");
    const cardsFile = path.join(dir, "cards.jsonl");
    const days = readText(daysFile);
    const cards = readText(cardsFile);
    let out;
    try { out = apply(body, days, cards); } catch (e) {
      if (e instanceof PlanError) return { error: e.message, status: 400 };
      throw e;
    }
    const file = out.file === "days" ? daysFile : cardsFile;
    const before = out.file === "days" ? days : cards;
    const at = new Date().toISOString();
    let snapshot: string | null = null;
    if (out.text !== before) {
      const hist = path.join(dir, "history");
      fs.mkdirSync(hist, { recursive: true });
      snapshot = path.join(hist, `${path.basename(file).replace(/\.[^.]+$/, "")}-${at.replace(/[:.]/g, "-")}${path.extname(file)}`);
      fs.writeFileSync(snapshot, before);
      writeAtomic(file, out.text);
    }
    const { op: _op, via: _via, ...args } = body;
    void _op; void _via;
    fs.appendFileSync(path.join(dir, "plan-edits.jsonl"), `${JSON.stringify({ at, via, op: body.op, args, result: out.result, changed: snapshot != null, before: snapshot ? path.relative(careerOpsRoot(), snapshot) : null })}\n`);
    return { ok: true, op: body.op, ...out.result, undo: snapshot ? `restore ${path.relative(careerOpsRoot(), snapshot)} over data/study/${path.basename(file)}` : null };
  });
  chain = run.catch(() => undefined);
  const res = await run;
  if ("error" in res) return Response.json({ error: res.error }, { status: res.status });
  return Response.json(res, { headers: { "Cache-Control": "no-store" } });
}
