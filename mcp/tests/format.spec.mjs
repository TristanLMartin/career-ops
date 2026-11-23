import test from "node:test";
import assert from "node:assert/strict";
import { localWhen, trackerLabel, parseTrackerRef } from "../src/format.mjs";

test("localWhen: UTC timestamps are told in the configured zone, with its short name", () => {
  assert.equal(localWhen("2026-11-22T17:15:12.328Z", "America/New_York"), "Sun, Nov 22, 12:15 PM EST");
  assert.equal(localWhen("2026-11-23T03:30:00Z", "America/New_York"), "Sun, Nov 22, 10:30 PM EST"); // crosses midnight back to the 22nd
  assert.equal(localWhen("2026-07-01T19:00:00Z", "America/New_York"), "Wed, Jul 1, 3:00 PM EDT"); // daylight time
  assert.equal(localWhen("2026-11-22T17:15:12Z", "UTC"), "Sun, Nov 22, 5:15 PM UTC");
});

test("localWhen: non-timestamps pass through", () => {
  assert.equal(localWhen("2026-11-22"), "2026-11-22");
  assert.equal(localWhen(null), null);
  assert.equal(localWhen("never"), "never");
});

test("trackerLabel and parseTrackerRef: ID N, never #N", () => {
  assert.equal(trackerLabel(54), "ID 54");
  for (const s of ["54", "#54", "ID 54", "id:54", "Id #54", "tracker:54", " ID54 "]) assert.equal(parseTrackerRef(s), "54", s);
  for (const s of ["", "abc", "54a", "ID", "https://x/54"]) assert.equal(parseTrackerRef(s), null, s);
});
