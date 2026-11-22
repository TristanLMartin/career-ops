// Jobs Map helpers (web/src/lib/hunt-map.mjs): role family, location group, points.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
// web/ is optional in a checkout; load its modules only when it is there.
const HAS_WEB = existsSync(new URL("../web/src", import.meta.url));
const { roleFamily, locationGroup, mapPoints, visiblePoints, payTicks, unitHash } = HAS_WEB ? await import("../web/src/lib/hunt-map.mjs") : {};

test("roleFamily: title keywords, in priority order", () => {
  assert.equal(roleFamily("Forward Deployed Engineer (FDE) - Seattle"), "FDE/Applied AI");
  assert.equal(roleFamily("Applied AI/ML Lead - Payments"), "FDE/Applied AI");
  assert.equal(roleFamily("Senior Solutions Engineer"), "FDE/Applied AI");
  assert.equal(roleFamily("Backend / API Engineer, Radar Payments"), "Payments/Fintech");
  assert.equal(roleFamily("Staff Backend Engineer (Payments and Billing)"), "Payments/Fintech");
  assert.equal(roleFamily("Senior Software Engineer, Full-stack"), "Full-stack");
  assert.equal(roleFamily("Senior Software Engineer - Substrate Store"), "Backend/Infra");
  assert.equal(roleFamily("Software Engineer, Frontier AI Infrastructure"), "Backend/Infra");
});

test("roleFamily: generic titles fall back to domains, then Other", () => {
  assert.equal(roleFamily("Senior Software Engineer", ["payments", "platform"]), "Payments/Fintech");
  assert.equal(roleFamily("Senior Software Engineer", ["fullstack"]), "Full-stack");
  assert.equal(roleFamily("Senior Software Engineer", ["realtime", "platform"]), "Backend/Infra");
  assert.equal(roleFamily("Senior Software Engineer", []), "Other");
  assert.equal(roleFamily(null), "Other");
});

test("locationGroup: from the profile's location tier, remote text as a fallback", () => {
  assert.equal(locationGroup("whatever", 1), "Home area");
  assert.equal(locationGroup("whatever", 2), "Remote");
  assert.equal(locationGroup("whatever", 3), "Secondary area");
  assert.equal(locationGroup("whatever", 4), "Other");
  assert.equal(locationGroup("Remote, global", 5), "Other");
  assert.equal(locationGroup("Remote US"), "Remote");
  assert.equal(locationGroup("United States, Remote"), "Remote");
  assert.equal(locationGroup("Anywhere, USA"), "Remote");
  assert.equal(locationGroup("San Francisco, CA"), "Other");
  assert.equal(locationGroup("Remote - Europe"), "Other");
});

test("mapPoints: fit and pay sources, hollow for estimated TC, deterministic jitter", () => {
  const jobs = {
    a: { company: "A", role: "Backend Engineer", location: "Springfield", locationTier: 1, fit: 4, pay: { currency: "USD", annualMin: 200000, annualMax: 300000 }, shortlist: true, groupLeader: true },
    b: { company: "B", role: "FDE", location: "Remote US", quick_score: 3, tc_est: { usd: 400000 }, h2h_rank: 7, groupLeader: true },
    c: { company: "C", role: "Backend", location: "NYC", quick_score: 2, groupLeader: true }, // no pay
    d: { company: "D", role: "Backend", location: "NYC", groupLeader: true }, // no fit
    e: { company: "E", role: "Backend", location: "Chicago", fit: 3, pay: { currency: "USD", annualMin: 150000, annualMax: 180000 }, belowFloor: true, groupLeader: true },
  };
  const { points, noPay } = mapPoints(jobs, { trueRank: (u) => (u === "a" ? 1 : null) });
  assert.equal(noPay, 1);
  const a = points.find((p) => p.url === "a");
  const b = points.find((p) => p.url === "b");
  assert.equal(a.y, 250000); assert.equal(a.estimated, false); assert.equal(a.fitFrom, "full"); assert.equal(a.rank, 1);
  assert.equal(b.y, 400000); assert.equal(b.estimated, true); assert.equal(b.fitFrom, "quick");
  assert.ok(Math.abs(a.x - 4) <= 0.14);
  assert.equal(mapPoints(jobs).points.find((p) => p.url === "a").x, a.x);
  assert.deepEqual(visiblePoints(points).map((p) => p.url).sort(), ["a", "b"]);
  assert.deepEqual(visiblePoints(points, { all: true }).map((p) => p.url).sort(), ["a", "b"]);
  assert.deepEqual(visiblePoints(points, { all: true, belowFloor: true }).map((p) => p.url).sort(), ["a", "b", "e"]);
  assert.deepEqual(visiblePoints(points, { hiddenLoc: ["Home area"] }).map((p) => p.url), ["b"]);
});

test("payTicks and unitHash", () => {
  assert.deepEqual(payTicks(175000, 330000), [150000, 200000, 250000, 300000, 350000]);
  assert.equal(payTicks(100000, 900000)[1] - payTicks(100000, 900000)[0], 100000);
  const h = unitHash("x");
  assert.ok(h >= 0 && h < 1); assert.equal(unitHash("x"), h);
});

test("role families come from the profile: target roles or map_families, the rest is Other", async () => {
  const { familiesFrom } = await import("../web/src/lib/hunt-map.mjs");
  const { mapFamilies } = await import("../scripts/hunt-enrich.mjs");
  const fromRoles = mapFamilies(null, { target_roles: ["Senior Technical Recruiter", "Technical Recruiter", "Talent Acquisition Partner", "Sourcer"] });
  assert.deepEqual(fromRoles.map((f) => f.name), ["Technical Recruiter", "Talent Acquisition Partner", "Sourcer"]);
  const fams = familiesFrom(fromRoles);
  assert.equal(roleFamily("Sr. Technical Recruiter, Engineering", [], fams), "Technical Recruiter");
  assert.equal(roleFamily("Lead Sourcer", [], fams), "Sourcer");
  assert.equal(roleFamily("Senior Backend Engineer", [], fams), "Other");
  const cfg = familiesFrom(mapFamilies({ Nursing: ["nurse", "re:\\bRN\\b"], Admin: ["coordinator"] }, {}));
  assert.equal(roleFamily("ICU RN", [], cfg), "Nursing");
  assert.equal(mapFamilies(null, {}), null, "no roles: the built-in software families");
  assert.equal(familiesFrom(null), null);
  const { points } = mapPoints({ a: { company: "A", role: "Technical Recruiter", fit: 4, pay: { currency: "USD", annualMin: 90000, annualMax: 120000 }, groupLeader: true } }, { families: fams });
  assert.equal(points[0].family, "Technical Recruiter");
});
