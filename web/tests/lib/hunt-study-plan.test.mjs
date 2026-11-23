// study plan editing (lib/hunt-study-plan.mjs). Done state must survive every edit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addCards, addDay, addTask, materialize, PlanError, setArchived, updateDay, updateTask } from "../../src/lib/hunt-study-plan.mjs";
import { parseDays } from "../../src/lib/hunt-study-days.mjs";

const MD = `# Study days

## Phase A: base

### Day 1: arrays
- Coding: ★ Two Sum (1)
- Design: read chapter 1

### Day 2: lists
- Coding: LRU Cache (146)
- Stories: tell story 1

## Phase B: targets

### Day 3: payments
- Design: payments ledger

## Fast-track

### Fast-track Day 1
- Mock: one full loop
`;

const ids = (md) => parseDays(md).days.flatMap((d) => d.items.map((i) => i.id));
const day = (md, n) => parseDays(md).days.find((d) => d.key === `d${n}`);

test("materialize writes the current ids, so ticks keyed by them still match", () => {
  const before = ids(MD);
  const after = materialize(MD);
  assert.deepEqual(ids(after), before);
  assert.equal(materialize(after), after, "idempotent");
});

test("addTask: a free-text type, a star, a position; existing ids unchanged", () => {
  const before = ids(MD);
  const { md, task } = addTask(MD, { day: 2, type: "inference", text: "KV cache basics", star: true, position: 1 });
  assert.equal(task.type, "Inference");
  assert.equal(task.star, true);
  assert.equal(task.position, 1);
  assert.equal(day(md, 2).items[0].id, task.id);
  for (const id of before) assert.ok(ids(md).includes(id), id);
});

test("updateTask edits and moves a task, keeping its id", () => {
  const first = addTask(MD, { day: 2, type: "Coding", text: "Min Stack (155)" });
  const edited = updateTask(first.md, first.task.id, { text: "Min Stack (155), then Max Stack", star: true });
  assert.equal(edited.task.text, "★ Min Stack (155), then Max Stack");
  const moved = updateTask(edited.md, first.task.id, { day: 3, position: 1 });
  assert.equal(day(moved.md, 3).items[0].id, first.task.id);
  assert.ok(!day(moved.md, 2).items.some((i) => i.id === first.task.id));
});

test("archive hides a task from the day and progress; unarchive restores it with the same id", () => {
  const id = ids(MD)[1];
  const a = setArchived(MD, id, true);
  assert.equal(a.task.archived, true);
  assert.ok(!day(a.md, 1).items.some((i) => i.id === id));
  assert.ok(day(a.md, 1).archived.some((i) => i.id === id));
  const u = setArchived(a.md, id, false);
  assert.ok(day(u.md, 1).items.some((i) => i.id === id));
});

test("addDay inserts and renumbers later days; every task keeps its id (ticks survive)", () => {
  const before = ids(MD);
  const { md, day: n } = addDay(MD, { after_day: 1, theme: "inference basics" });
  assert.equal(n, 2);
  const days = parseDays(md).days.filter((d) => !d.fast);
  assert.deepEqual(days.map((d) => `${d.n}:${d.theme}`), ["1:arrays", "2:inference basics", "3:lists", "4:payments"]);
  assert.deepEqual(ids(md).sort(), before.sort());
  assert.equal(parseDays(md).days.find((d) => d.fast).n, 1, "fast-track days keep their numbers");
  // a task added to the new day lands there
  const t = addTask(md, { day: 2, type: "Inference", text: "batching" });
  assert.equal(day(t.md, 2).items[0].text, "batching");
});

test("updateDay renames a day and moves it to another section, renumbering", () => {
  const before = ids(MD);
  const r = updateDay(MD, 3, { theme: "ledgers and payments" });
  assert.equal(day(r.md, 3).theme, "ledgers and payments");
  const m = updateDay(MD, 1, { section: "Phase B" });
  const days = parseDays(m.md).days.filter((d) => !d.fast);
  assert.deepEqual(days.map((d) => `${d.n}:${d.theme}:${d.section.split(":")[0]}`), ["1:lists:Phase A", "2:payments:Phase B", "3:arrays:Phase B"]);
  assert.deepEqual(ids(m.md).sort(), before.sort());
});

test("bad requests are refused with a plain message", () => {
  assert.throws(() => addTask(MD, { day: 9, text: "x" }), PlanError);
  assert.throws(() => addTask(MD, { day: 1, text: "  " }), /empty/);
  assert.throws(() => addTask(MD, { day: 1, text: "x", type: "not a valid type because way too long" }), /type/);
  assert.throws(() => updateTask(MD, "nope", { text: "x" }), /No study task/);
  assert.throws(() => addDay(MD, { theme: "x" }), /after_day/);
  assert.throws(() => updateDay(MD, 1, { section: "Phase Z" }), /No section/);
});

test("addCards appends in the deck format and skips fronts already in the deck", () => {
  const deck = `${JSON.stringify({ c: "C#", q: "What does LINQ Count do?", one: "Walks the list.", b: [] })}\n`;
  const r = addCards(deck, [
    { front: "What does LINQ Count do?", back: "dup" },
    { front: "What is a KV cache?", back: "Stored attention keys and values.\n- saves recompute\n- grows with context", tags: ["Inference"] },
  ]);
  assert.deepEqual(r.skipped, ["What does LINQ Count do?"]);
  assert.equal(r.added.length, 1);
  const last = JSON.parse(r.jsonl.trim().split("\n").at(-1));
  assert.deepEqual(last, { c: "Inference", q: "What is a KV cache?", one: "Stored attention keys and values.", b: ["saves recompute", "grows with context"] });
});
