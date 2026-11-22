// GET /api/profile/home: built from the same homeSections() Home renders, so the two cannot drift.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeApiBody, homeSections, inFlight, needsYou } from "../../src/lib/hunt-home-v2.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = Date.parse("2026-11-21T20:00:00");
const tracker = [
  { n: "435", company: "Hex", role: "Senior SWE", status: "Interview", updated: "2026-11-21", next: "Hex intro call (via Paraform) Tue 11/24 1:00 PM PT" },
  { n: "12", company: "Acme", role: "SWE", status: "Applied", updated: "2026-11-10", next: "follow up 11/20" },
  { n: "7", company: "Closed Co", role: "SWE", status: "Rejected", updated: "2026-11-01", next: "" },
];
const threads = [{ id: "t1", name: "Jordan", about: "Stripe", owe: true, href: "https://mail.example/t1" }];
const jobs = {
  "https://jobs.example/a": { company: "Alpha", role: "Backend", composite: 4.5, h2h_rank: 1, fit: 4 },
  "https://jobs.example/b": { company: "Beta", role: "Infra", composite: 4.0, h2h_rank: 2 },
};
const firstSeen = { "https://jobs.example/a": "2026-11-21T10:00:00Z", "https://jobs.example/b": "2026-11-01T00:00:00Z" };

test("homeSections: same needs / in-flight as the Home helpers; new = first seen after the last visit", () => {
  const s = homeSections({ tracker, threads, jobs, firstSeen, lastVisit: "2026-11-20T00:00:00Z", now: NOW });
  assert.deepEqual(s.flying.map((r) => r.n), inFlight(tracker).map((r) => r.n));
  assert.deepEqual(s.fresh.map((e) => e.url), ["https://jobs.example/a"]);
  assert.deepEqual(s.needs, needsYou({ tracker, threads, newTop: s.newTop, now: NOW }));
  assert.deepEqual(s.needs.map((n) => n.id), ["next:12", "msg:t1", "new:https://jobs.example/a"]);
});

test("homeApiBody: { needs, inFlight, opportunities } with compact rows", () => {
  const body = homeApiBody(homeSections({ tracker, threads, jobs, firstSeen, lastVisit: "2026-11-20T00:00:00Z", now: NOW }));
  assert.deepEqual(Object.keys(body), ["needs", "inFlight", "opportunities"]);
  assert.equal(body.needs.length, 3);
  assert.equal("sort" in body.needs[0], false);
  assert.deepEqual(body.inFlight[0], { n: "435", company: "Hex", role: "Senior SWE", status: "Interview", updated: "2026-11-21", next: "Hex intro call (via Paraform) Tue 11/24 1:00 PM PT" });
  assert.deepEqual(body.opportunities, [{ url: "https://jobs.example/a", company: "Alpha", role: "Backend", rank: 1, fit: 4, composite: 4.5, tracker: null }]);
  assert.deepEqual(homeApiBody(homeSections({})), { needs: [], inFlight: [], opportunities: [] });
});

test("the route and the Home page share one loader (no second copy to drift)", () => {
  const route = fs.readFileSync(path.join(web, "src/app/api/profile/home/route.ts"), "utf8");
  const home = fs.readFileSync(path.join(web, "src/components/hunt/home.tsx"), "utf8");
  for (const src of [route, home]) assert.match(src, /loadHomeSections\(\)/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.doesNotMatch(home, /needsYou\(|newSince\(|worthALook\(/);
});
