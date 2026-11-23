// Study plan editing through the dashboard (fake dashboard, real career-ops study-plan lib).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeWorkspace, startFakeDashboard, callTool } from "./helpers.mjs";

let ws, dash, config;
before(async () => { ws = makeWorkspace(); dash = await startFakeDashboard(ws.root); config = ws.configFor(dash.port); });
after(async () => { await dash.close(); ws.cleanup(); });

const day = (plan, n) => plan.days.find((d) => d.day === n);

test("the ops check: add a task to Day 2, edit it, archive it, see it in get_study_plan", async () => {
  const p0 = (await callTool(config, "get_study_plan", {})).value;
  const firstDay1 = day(p0, 1).tasks[0].id;
  await callTool(config, "complete_study_task", { id: firstDay1, done: true });

  const added = await callTool(config, "add_study_task", { day: 2, type: "Inference", text: "KV cache basics", star: true, position: 1 });
  assert.equal(added.isError, false, added.text);
  const id = added.value.task.id;
  assert.equal(added.value.task.type, "Inference");
  assert.equal(day((await callTool(config, "get_study_plan", {})).value, 2).tasks[0].id, id);

  const edited = await callTool(config, "update_study_task", { task_id: id, text: "KV cache and batching", star: false });
  assert.equal(edited.value.task.text, "KV cache and batching");
  assert.equal(edited.value.task.star, false);

  const archived = await callTool(config, "archive_study_task", { task_id: id });
  assert.equal(archived.value.task.archived, true);
  const p1 = (await callTool(config, "get_study_plan", {})).value;
  const t = day(p1, 2).tasks.find((x) => x.id === id);
  assert.equal(t.archived, true);
  assert.equal(day(p1, 1).tasks[0].done, true, "an earlier tick survives the edits");

  await callTool(config, "unarchive_study_task", { task_id: id });
  assert.ok(!day((await callTool(config, "get_study_plan", {})).value, 2).tasks.find((x) => x.id === id).archived);

  const log = fs.readFileSync(path.join(ws.root, "data", "study", "plan-edits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.length >= 4 && log.every((e) => e.via === "mcp"));
});

test("add_study_day renumbers later days and keeps done state; update_study_day renames", async () => {
  const p0 = (await callTool(config, "get_study_plan", {})).value;
  const day2Ids = day(p0, 2).tasks.map((x) => x.id);
  await callTool(config, "complete_study_task", { id: day2Ids[0], done: true });
  const r = await callTool(config, "add_study_day", { after_day: 1, theme: "inference basics" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.value.day, 2);
  const p1 = (await callTool(config, "get_study_plan", {})).value;
  assert.equal(day(p1, 2).theme, "inference basics");
  assert.deepEqual(day(p1, 3).tasks.map((x) => x.id), day2Ids, "old Day 2 is Day 3, same task ids");
  assert.equal(day(p1, 3).tasks[0].done, true);
  const u = await callTool(config, "update_study_day", { day: 2, theme: "inference: KV cache and batching" });
  assert.equal(u.isError, false, u.text);
  assert.equal(day((await callTool(config, "get_study_plan", {})).value, 2).theme, "inference: KV cache and batching");
});

test("add_study_cards dedupes on the front; bad requests come back as plain errors", async () => {
  const cards = [{ front: "What is a KV cache?", back: "Stored attention keys and values.\n- saves recompute", tags: ["Inference"] }];
  const a = await callTool(config, "add_study_cards", { cards });
  assert.equal(a.value.added.length, 1);
  const b = await callTool(config, "add_study_cards", { cards });
  assert.deepEqual(b.value.skipped, ["What is a KV cache?"]);
  const bad = await callTool(config, "add_study_task", { day: 99, text: "x" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Not changed: No study day "99"/);
  const none = await callTool(config, "update_study_task", { task_id: "abc123" });
  assert.match(none.text, /Nothing to change/);
});
