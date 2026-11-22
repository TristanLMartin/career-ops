// Study page helpers (web/src/lib/hunt-study.mjs): parsing, stable ids, next-up, state ops.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// web/ is optional in a checkout; load its modules only when it is there.
const HAS_WEB = existsSync(new URL("../web/src", import.meta.url));
const { buildChecklist, nextUp, parsePlan, stableId, applyOp, normalizeState, beyondCards } = HAS_WEB ? await import("../web/src/lib/hunt-study.mjs") : {};

const MD = `# Plan
## Part 3 · 12-day study plan
| Day | Coding (~1 hr) | System design (~1.5 hr) | Stories (~20 min) |
| 1 | Day 1 problems | SDI Ch 1 | Draft stories |
| 2 | Day 2 problems | SDI Ch 2 | Stories out loud |
## Part 4 · Coding
### Problem list by day
| Day | Topic | Problems (LeetCode number) |
| 1 | Arrays | ★ Two Sum (1) · Group Anagrams (49) |
## Part 6 · Checklist
**Ask the recruiter**
- Which rounds?
## Part 7 · Beyond
### Lessons from the Nov 17 screen
- **Saga retries, four layers:** (1) undo steps safe to run twice, (2) retry with backoff
### Weeks after Part 3
| Week | Focus | What to do |
| 1 | Payments | Design a ledger. |
### Gap drills
- **Go reading** for LiveKit: goroutines.
`;

test("buildChecklist: days with three sub-checks, one item per problem, bullets, weeks and drills", () => {
  const g = buildChecklist(MD);
  assert.deepEqual(g.map((x) => x.title), ["12-day plan", "LeetCode problems", "Before the loop", "Beyond Microsoft"]);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(g[0].items[0].subs.map((s) => s.label), ["Coding", "System design", "Stories"]);
  assert.deepEqual(g[1].items.map((i) => [i.text, i.star, i.number]), [["Two Sum (1)", true, "1"], ["Group Anagrams (49)", false, "49"]]);
  assert.equal(g[2].items[0].note, "Ask the recruiter");
  assert.deepEqual(g[3].items.map((i) => i.text), ["Week 1: Payments", "Go reading"]);
});

test("ids are stable across a re-import and change only with heading path or text", () => {
  const a = buildChecklist(MD), b = buildChecklist(MD + "\n## Part 8 · New\n- extra\n");
  assert.equal(a[1].items[0].id, b[1].items[0].id);
  assert.equal(stableId("x", "y"), stableId("x", " y "));
  assert.notEqual(stableId("x", "y"), stableId("x", "z"));
});

test("nextUp: first day not ticked (all three subs ticked counts as done)", () => {
  const g = buildChecklist(MD);
  const ticks = Object.fromEntries(g[0].items[0].subs.map((s) => [s.id, true]));
  assert.equal(nextUp(g, ticks).text, "Day 2");
  assert.equal(nextUp(g, {}).text, "Day 1");
});

test("parsePlan: tables keep their header row, headings nest", () => {
  const tree = parsePlan(MD);
  assert.equal(tree[0].children[0].blocks[0].type, "table");
  assert.equal(tree[0].children[0].blocks[0].head[0], "Day");
});

test("state ops: tick/untick, flags, bad ids refused", () => {
  let s = normalizeState({});
  s = applyOp(s, { op: "tick", id: "abc123", value: true });
  assert.equal(s.ticks.abc123, true);
  s = applyOp(s, { op: "tick", id: "abc123", value: false });
  assert.equal(s.ticks.abc123, undefined);
  assert.equal(applyOp(s, { op: "tick", id: "../etc", value: true }), null);
  assert.equal(applyOp(s, { op: "nope", id: "abc123", value: true }), null);
});

test("beyondCards: Saga layers become numbered bullets", () => {
  const c = beyondCards(MD);
  assert.equal(c[0].c, "Lessons");
  assert.equal(c[0].b.length, 2);
});

const { sectionSummary, splitLeadIn, isFoldable, searchPlan, searchCards, reviewQueue, answerQueue } = HAS_WEB ? await import("../web/src/lib/hunt-study.mjs") : {};

test("sectionSummary: first sentence, skipping bold labels; table and children fallbacks", () => {
  const [plan] = parsePlan(`# P\n## A\n**Label**\n\nFirst point here. Second one.\n## B\n| Day | Do |\n| 1 | x |\n## C\n### C1\n### C2\n## D\n- **Lead in.** Body text.`);
  const [a, b, c, d] = plan.children;
  assert.equal(sectionSummary(a), "First point here.");
  assert.equal(sectionSummary(b), "1 rows: Day, Do");
  assert.equal(sectionSummary(c), "C1 · C2");
  assert.equal(sectionSummary(d), "Lead in. Body text.");
  assert.ok(sectionSummary({ blocks: [{ type: "p", text: "x ".repeat(200) }], children: [] }).length <= 121);
});

test("splitLeadIn / isFoldable", () => {
  assert.deepEqual(splitLeadIn("**Mostly your resume.** Your background."), { lead: "Mostly your resume.", rest: "Your background." });
  assert.deepEqual(splitLeadIn("plain"), { lead: "", rest: "plain" });
  assert.equal(isFoldable(`**Lead.** ${"word ".repeat(40)}`), true);
  assert.equal(isFoldable("**Lead.** short"), false);
  assert.equal(isFoldable("no lead ".repeat(40)), false);
});

test("searchPlan and searchCards match every word, case-insensitively", () => {
  const plan = parsePlan(`# P\n## Coding\n- Two pointers on arrays\n- Heaps for top k\n## Design\nCache with LRU eviction.`);
  const r = searchPlan(plan, "TOP heaps");
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "Coding");
  assert.deepEqual(r[0].blocks[0].items, ["Heaps for top k"]);
  assert.equal(searchPlan(plan, "design")[0].blocks[0].text, "Cache with LRU eviction.");
  assert.deepEqual(searchPlan(plan, "  "), []);
  const cards = [{ id: "a", c: "Design", q: "Cache?", one: "LRU", b: [] }, { id: "b", c: "Meta", q: "Rooms", one: "iOS", b: ["join funnel"] }];
  assert.deepEqual(searchCards(cards, "funnel").map((c) => c.id), ["b"]);
});

test("reviewQueue puts flagged first; answerQueue requeues Again later", () => {
  const cards = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
  assert.deepEqual(reviewQueue(cards, { d: true, b: true }), ["b", "d", "a", "c", "e", "f"]);
  assert.deepEqual(answerQueue(["a", "b", "c"], false), ["b", "c"]);
  assert.deepEqual(answerQueue(["a", "b", "c", "d", "e", "f"], true), ["b", "c", "d", "e", "a", "f"]);
  assert.deepEqual(answerQueue(["a", "b"], true), ["b", "a"]);
  assert.deepEqual(answerQueue(["a"], true), ["a"]);
  assert.deepEqual(answerQueue([], true), []);
});
