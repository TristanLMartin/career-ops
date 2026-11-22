// hunt: study days (days.md), LeetCode slugger, cross-links, checkpoints, start / fast-track state.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companyAnchor, companySections, currentDay, designPromptIndex, leetcodeSlug, linkProblems, linkRefs,
  nextCheckpoint, nextItems, parseCheckpoints, parseDays, slugify, splitItem, trackProgress,
} from "../../src/lib/hunt-study-days.mjs";
import { applyOp, normalizeState } from "../../src/lib/hunt-study.mjs";

const DAYS = `# Study days

Intro line.

## Phase A: base

### Day 1: arrays and strings
- Coding: ★ Two Sum (1)
- Design: SDI Vol 1 Ch 1
- Stories: draft all stories (stories.md)

### Day 2: lists
- Coding: ★ LRU Cache (146)

## Phase B: other

### Week 1: Salesforce (Days 13 to 18)

### Day 13: Salesforce basics
- Company: read the overviews (company-prep.md)

## Fast-track

### Fast-track Day 1
- Coding: ★ problems from Days 1 and 2 above
`;

test("parseDays: phases, weeks, days and one tickable item per bullet", () => {
  const d = parseDays(DAYS);
  assert.deepEqual(d.days.map((x) => x.key), ["d1", "d2", "d13", "ft1"]);
  assert.equal(d.days[0].theme, "arrays and strings");
  assert.equal(d.days[2].week, "Week 1: Salesforce (Days 13 to 18)");
  assert.deepEqual(d.days[0].items.map((i) => i.type), ["Coding", "Design", "Stories"]);
  assert.equal(d.days[0].items[0].star, true);
  assert.match(d.days[0].items[0].id, /^[a-z0-9]{2,40}$/, "ids fit the study-state id rule");
  assert.notEqual(d.days[0].items[0].id, d.days[1].items[0].id);
  assert.equal(parseDays(DAYS).days[0].items[0].id, d.days[0].items[0].id, "stable across parses");
  assert.deepEqual(d.intro, ["Intro line."]);
});

test("current day = first day not fully ticked; calendar days never skip content; fast-track is its own track", () => {
  const d = parseDays(DAYS).days;
  const t = Object.fromEntries(d[0].items.map((i) => [i.id, true]));
  assert.equal(currentDay(d, {}).key, "d1");
  assert.equal(currentDay(d, t).key, "d2");
  assert.equal(currentDay(d, {}, { fastTrack: true }).key, "ft1");
  assert.deepEqual(trackProgress(d, t), { done: 1, total: 3 });
  assert.deepEqual(nextItems(d[0], { [d[0].items[0].id]: true }, 3).map((i) => i.type), ["Design", "Stories"]);
});

test("slugger: lowercase, hyphens, punctuation dropped, overrides for odd names", () => {
  assert.equal(slugify("Insert Delete GetRandom O(1)"), "insert-delete-getrandom-o1");
  assert.equal(slugify("Time Based Key-Value Store"), "time-based-key-value-store");
  assert.equal(slugify("Search a 2D Matrix"), "search-a-2d-matrix");
  assert.equal(leetcodeSlug("Zigzag", 103), "binary-tree-zigzag-level-order-traversal");
  assert.equal(leetcodeSlug("Simple Bank System", 2043), "simple-bank-system");
  assert.equal(leetcodeSlug("Implement Trie", 208), "implement-trie-prefix-tree");
  assert.equal(leetcodeSlug("Two Sum", 1), "two-sum");
});

test("linkProblems: every 'Name (number)' in a bullet, ★ kept, verbs and joins left as text", () => {
  const view = (t) => linkProblems(t).map((x) => (x.problem ? `[${x.problem.star ? "★" : ""}${x.problem.name}|${x.problem.url.replace("https://leetcode.com/problems/", "")}]` : x.text));
  assert.deepEqual(view("★ Two Sum (1)"), ["[★Two Sum|two-sum/]"]);
  assert.deepEqual(view("★ Reverse Linked List (206), then Reverse Nodes in k-Group (25)"), ["[★Reverse Linked List|reverse-linked-list/]", ", then ", "[Reverse Nodes in k-Group|reverse-nodes-in-k-group/]"]);
  assert.deepEqual(view("Insert Delete GetRandom O(1) (380)"), ["[Insert Delete GetRandom O(1)|insert-delete-getrandom-o1/]"]);
  assert.deepEqual(view("★ Number of Islands (200), ★ Rotting Oranges (994) redo"), ["[★Number of Islands|number-of-islands/]", ", ", "[★Rotting Oranges|rotting-oranges/]", " redo"]);
  assert.deepEqual(view("★ Design a Bank-like system: Simple Bank System (2043)"), ["★ Design a Bank-like system: ", "[Simple Bank System|simple-bank-system/]"]);
  assert.deepEqual(view("Rewrite Two Sum (1) and Valid Parentheses (20) in TypeScript"), ["Rewrite ", "[Two Sum|two-sum/]", " and ", "[Valid Parentheses|valid-parentheses/]", " in TypeScript"]);
  assert.deepEqual(view("redo the two ★ problems you missed this week"), ["redo the two ★ problems you missed this week"]);
});

test("linkRefs: quoted design prompts, FDE drills and doc names become links", () => {
  const prompts = designPromptIndex(`# Design prompts\n## Mailbox read API\n## Search over a user's mail\n## FDE decomposition drills\n### Drill 2: Sales team wants Agentforce\n`);
  const hrefs = (t) => linkRefs(t, prompts).filter((r) => r.href).map((r) => `${r.text}->${r.href}`);
  assert.deepEqual(hrefs('mock "low-latency mailbox read API", 45 minutes'), ['"low-latency mailbox read API"->/study/design#mailbox-read-api']);
  assert.deepEqual(hrefs(`Then "Search over a user's mail"`), [`"Search over a user's mail"->/study/design#search-over-a-users-mail`]);
  assert.deepEqual(hrefs("FDE decomposition drill 2 and 3 (design-prompts.md)"), ["FDE decomposition drill 2->/study/design#drill-2-sales-team-wants-agentforce", "design-prompts.md->/study/design"]);
  assert.deepEqual(hrefs("draft all stories (stories.md)"), ["stories.md->/study/stories"]);
  assert.deepEqual(hrefs('"Design a payments ledger"'), [], "no matching prompt: plain text");
});

test("checkpoints and company sections", () => {
  const cps = parseCheckpoints("# Checkpoints\n\n- End of Day 12: every ★ problem.\n- End of Day 18: Salesforce answers.\n\nRule: write it down.\n");
  assert.deepEqual(cps.map((c) => c.day), [12, 18]);
  assert.equal(nextCheckpoint(cps, 13).day, 18);
  assert.equal(nextCheckpoint(cps, 40), null);
  const cs = companySections("# Company prep\n## Microsoft: Senior SWE, Substrate Store (in process)\n## Salesforce: FDE (in process)\n## Stripe\n");
  assert.equal(companyAnchor(cs, "Microsoft"), "microsoft-senior-swe-substrate-store");
  assert.equal(companyAnchor(cs, "Stripe"), "stripe");
  assert.equal(companyAnchor(cs, "Brightloop"), null);
  assert.equal(companyAnchor(cs, "Unknown (via Paraform)"), null);
});

test("study state: start date and fast-track ops; ticks untouched", () => {
  let s = normalizeState({ ticks: { abc: true } });
  assert.equal(s.startDate, null);
  s = applyOp(s, { op: "start", value: "2026-11-22" });
  assert.equal(s.startDate, "2026-11-22");
  assert.equal(applyOp(s, { op: "start", value: "tomorrow" }), null);
  s = applyOp(s, { op: "fast", value: true });
  assert.equal(s.fastTrack, true);
  assert.deepEqual(s.ticks, { abc: true });
  assert.equal(applyOp(s, { op: "start", value: null }).startDate, null);
  assert.equal(splitItem("Rest: no stories today").type, "Rest");
  assert.equal(splitItem("Python refresher first: Counter, defaultdict").type, "Coding");
});
