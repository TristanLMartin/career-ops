// Tracker page helpers (web/src/lib/hunt-tracker.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// web/ is optional in a checkout; load its modules only when it is there.
const HAS_WEB = existsSync(new URL("../web/src", import.meta.url));
const { isInFlight, parseStatusLog, nextStep, appliedDate, lastUpdate, cellUrl, trackerRows, sortRows, trackerCsvText } = HAS_WEB ? await import("../web/src/lib/hunt-tracker.mjs") : {};

const LOG = parseStatusLog("54\t2026-11-20\tEvaluated\tInterview\tset-status\t\nbad line\n");
const APPS = [
  { n: "54", date: "2026-11-21", company: "Salesforce", role: "Forward Deployed Engineer (FDE)", status: "Interview", notes: "Location: Washington - Bellevue; applied 2026-11-17 via Workday; Next: recruiter call Mon", url: "[workday](https://salesforce.example/JR349466)" },
  { n: "55", date: "2026-11-13", company: "Microsoft", role: "Senior Software Engineer - Substrate Store", status: "Interview", notes: "Technical screen scheduled", url: "" },
  { n: "1", date: "2026-11-20", company: "OpenAI", role: "FDE", status: "Evaluated", notes: "", url: "" },
  { n: "9", date: "2026-11-01", company: "Old", role: "Backend", status: "Rejected", notes: "", url: "" },
  { n: "10", date: "2026-11-01", company: "Nope", role: "Backend", status: "Discarded", notes: "", url: "" },
];

test("in flight: past Evaluated, not Discarded/SKIP", () => {
  assert.equal(isInFlight("Interview"), true);
  assert.equal(isInFlight("Rejected"), true);
  assert.equal(isInFlight("Evaluated"), false);
  assert.equal(isInFlight("SKIP"), false);
  assert.equal(isInFlight("Discarded"), false);
});

test("dates, next step and link come from the tracker row and the ledger", () => {
  assert.equal(LOG.length, 1);
  assert.deepEqual(appliedDate(APPS[0], LOG), { date: "2026-11-17", approx: false });
  assert.deepEqual(appliedDate(APPS[1], LOG), { date: "2026-11-13", approx: true });
  assert.equal(lastUpdate(APPS[0], LOG), "2026-11-21");
  assert.deepEqual(nextStep(APPS[0].notes), { text: "recruiter call Mon", raw: "Next: recruiter call Mon" });
  assert.deepEqual(nextStep("a; b"), { text: "", raw: "" });
  assert.equal(cellUrl(APPS[0].url), "https://salesforce.example/JR349466");
  assert.equal(cellUrl("https://x.example/a"), "https://x.example/a");
});

test("trackerRows keeps #54 and #55, joins pay by URL", () => {
  const rows = trackerRows(APPS, LOG, { "https://salesforce.example/JR349466": { pay: { currency: "USD", annualMin: 180000, annualMax: 250000 }, tc_est: { usd: 300000 } } });
  assert.deepEqual(rows.map((r) => r.n), ["54", "55", "9"]);
  assert.deepEqual(rows[0].base, [180000, 250000]);
  assert.equal(rows[0].tc, 300000);
  assert.equal(rows[0].location, "Washington - Bellevue");
  assert.deepEqual(sortRows(rows, "company").map((r) => r.company), ["Microsoft", "Old", "Salesforce"]);
  assert.deepEqual(sortRows(rows, "status").map((r) => r.n), ["54", "55", "9"]);
  assert.equal(sortRows(rows, "pay", "desc")[0].n, "54");
  const csv = trackerCsvText(rows);
  assert.match(csv.split("\r\n")[0], /^#,Company,Role,Status/);
  assert.match(csv, /recruiter call Mon/);
  assert.equal(trackerCsvText([{ ...rows[0], next: "=HYPERLINK(1)" }]).includes(",'=HYPERLINK(1),"), true);
});
