// Deterministic tests for the head-to-head aggregation (scripts/hunt-h2h.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { bordaAggregate, batches, shuffle, rng, parseRanking } from "../scripts/hunt-h2h.mjs";

test("bordaAggregate: fixture batches over three rounds give the expected order", () => {
  // Round 1: two batches of 3. Round 2, 3: different shuffles.
  const rankings = [
    ["A", "B", "C"], ["D", "E", "F"],
    ["A", "D", "E"], ["B", "C", "F"],
    ["D", "A", "F"], ["B", "E", "C"],
  ];
  const out = bordaAggregate(rankings);
  // A: 1, 1, 0.5 -> .833 · D: 1, .5, 1 -> .833 · B: .5, 1, 1 -> .833 · E: .5, 0, .5 -> .333
  // C: 0, .5, 0 -> .167 · F: 0, 0, 0 -> 0. Ties broken by id with no tiebreak.
  assert.deepEqual(out.map((x) => x.id), ["A", "B", "D", "E", "C", "F"]);
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(out[0].borda, 0.833);
  assert.equal(out[0].appearances, 3);
});

test("bordaAggregate: normalized so a 10-batch and a 4-batch weigh the same; tiebreak wins ties", () => {
  const big = ["X", "a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const small = ["Y", "j", "k", "l"];
  const out = bordaAggregate([big, small], (id) => (id === "Y" ? 1 : 0));
  assert.equal(out[0].id, "Y"); // X and Y both 1.0; tiebreak puts Y first
  assert.equal(out[1].id, "X");
  assert.equal(out.find((x) => x.id === "i").borda, 0);
});

test("batches: 100 ids in batches of ~9 are 8-10 each and cover every id once", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `J${i}`);
  const b = batches(shuffle(ids, rng(7)), 9);
  assert.ok(b.every((x) => x.length >= 8 && x.length <= 10));
  assert.equal(new Set(b.flat()).size, 100);
});

test("shuffle is deterministic per seed", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(shuffle(ids, rng(3)), shuffle(ids, rng(3)));
  assert.notDeepEqual(shuffle(ids, rng(3)), shuffle(ids, rng(4)));
});

test("parseRanking: keeps batch ids only, appends missing ones, rejects junk", () => {
  const r = parseRanking('noise {"ranking":["J2","J9","J1"],"why":{"J2":"payments"}}', ["J1", "J2", "J3"]);
  assert.deepEqual(r.order, ["J2", "J1", "J3"]);
  assert.equal(r.why.J2, "payments");
  assert.equal(parseRanking("I cannot rank these", ["J1", "J2"]), null);
});
