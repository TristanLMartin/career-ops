import assert from "node:assert/strict";
import { test } from "node:test";
import { pending } from "../scripts/hunt-quickscore.mjs";

test("quick scores skip jobs the profile excludes (not full-time, below the floor) and ones already scored", () => {
  const jobs = { a: { composite: 50 }, b: { composite: 90, excluded: "below the base floor" }, c: { composite: 70, excluded: "not full-time" }, d: { composite: 80 } };
  assert.deepEqual(pending(jobs, { d: { score: 4 } }).map(([u]) => u), ["a"]);
});
