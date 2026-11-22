// hunt: `hunt-h2h-insert.mjs --new` picks tournament-eligible roles not in the head-to-head
// yet, so roles evaluated after the weekly run join Best overall the same day.
import test from "node:test";
import assert from "node:assert/strict";
import { newSinceTournament } from "../scripts/hunt-h2h-insert.mjs";

const job = (o) => ({ groupLeader: true, fit: 4, level: { key: "senior" }, locationTier: 1, composite: 70, company: "Acme", ...o });

test("only eligible roles missing from the tournament, best composite first, capped", () => {
  const jobs = {
    inIt: job({ composite: 99 }),
    newHigh: job({ composite: 90 }),
    newLow: job({ composite: 60 }),
    unevaluated: job({ fit: null, composite: 95 }),
    viaGroup: job({ fitVia: "group", composite: 94 }),
    member: job({ groupLeader: false, composite: 93 }),
    nyc: job({ locationTier: 3, composite: 92 }),
    belowFloor: job({ belowFloor: true, composite: 91 }),
    rejected: job({ status: "Rejected", composite: 89 }),
  };
  const doc = { items: [{ url: "inIt", h2h_rank: 1 }] };
  assert.deepEqual(newSinceTournament(jobs, doc, 10), ["newHigh", "newLow"]);
  assert.deepEqual(newSinceTournament(jobs, doc, 1), ["newHigh"]);
  assert.deepEqual(newSinceTournament(jobs, { items: [] }, 0), []);
});
