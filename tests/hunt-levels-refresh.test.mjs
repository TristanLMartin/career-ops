// Tests for scripts/hunt-levels-refresh.mjs, with a fake MCP client.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptSlug, companiesFromEnrich, refresh } from "../scripts/hunt-levels-refresh.mjs";
import { US } from "../lib/hunt-levels.mjs";

const HOME = "greater-austin-area";

test("acceptSlug takes only a result whose name normalizes to ours", () => {
  assert.deepEqual(acceptSlug("Acme Rockets", [{ name: "Acme Rockets", slug: "acme-rockets" }]), { slug: "acme-rockets", name: "Acme Rockets" });
  assert.deepEqual(acceptSlug("Salesforce, Inc.", [{ name: "Salesforce", slug: "salesforce" }]), { slug: "salesforce", name: "Salesforce" });
  assert.equal(acceptSlug("Ramp", [{ name: "Rampart Communications", slug: "rampart" }]), null);
  assert.equal(acceptSlug("Globex", []), null);
});

test("companiesFromEnrich: tracked first, then shortlisted, then evaluated; deduped; capped", () => {
  const doc = { jobs: [
    { company: "Inboxonly", relevance: 99 },
    { company: "Evaluated Co", fit: 3.5, relevance: 50 },
    { company: "Short Co", shortlist: true, relevance: 40 },
    { company: "Tracked Co", status: "Interview", relevance: 10 },
    { company: "Short Co", shortlist: true, relevance: 90 },
  ] };
  assert.deepEqual(companiesFromEnrich(doc, [], 10), ["Tracked Co", "Short Co", "Evaluated Co"]);
  assert.deepEqual(companiesFromEnrich(doc, ["Extra"], 1), ["Extra", "Tracked Co"]);
});

function workspace({ isTech = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "levels-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "config", "person.yml"), `is_tech: ${isTech}\n`);
  fs.writeFileSync(path.join(root, "config", "ranking.yml"), "levels:\n  home_location: greater-austin-area\nlevels_slugs:\n  Acme Robotics: null\n  Pub Co: pubco\n");
  fs.writeFileSync(path.join(root, "data", "hunt-enrich.json"), JSON.stringify({ jobs: [
    { company: "Salesforce", status: "Interview" }, { company: "Stripe", shortlist: true }, { company: "Nowhere Labs", fit: 3 }, { company: "Acme Robotics", fit: 4 }, { company: "Pub Co", fit: 4 },
  ] }));
  return root;
}

function fakeClient({ failLevels = false } = {}) {
  const calls = [];
  return {
    calls,
    get count() { return calls.length; },
    async call(name, args) {
      calls.push([name, args]);
      if (name === "search-companies") return { Salesforce: [{ name: "Salesforce", slug: "salesforce" }], Stripe: [{ name: "Stripe", slug: "stripe" }] }[args.searchText] ?? [{ name: "Something Else", slug: "x" }];
      if (name === "get-company") return { slug: args.companyNameOrSlug, ticker: { salesforce: "CRM", pubco: "PUB" }[args.companyNameOrSlug] ?? null };
      if (name === "get-salaries-by-company-level") {
        if (failLevels) throw new Error("HTTP 500");
        return { companies: args.companySlugs.map((s) => ({ companySlug: s, levels: args.locationSlug === HOME && s === "stripe" ? [] : [{ level: "Senior", medianTotalCompensation: 300000 }] })) };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test("refresh: resolves slugs (exact names only, overrides honoured) and stores both locations", async () => {
  const root = workspace();
  const client = fakeClient();
  const r = await refresh({ root, client, log: () => {} });
  const doc = JSON.parse(fs.readFileSync(path.join(root, "data", "comp-levels.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.companies).sort(), ["pub", "salesforce", "stripe"]);
  assert.equal(doc.companies.pub.public, true); // a manual slug still gets its public/private flag
  assert.equal(doc.companies.salesforce.public, true);
  assert.equal(doc.companies.stripe.public, false);
  assert.deepEqual(doc.companies.stripe.locations[HOME], []);
  assert.equal(doc.companies.stripe.locations[US][0].medianTotalCompensation, 300000);
  assert.equal(r.withData, 3);
  // Acme Robotics is overridden to null: never searched.
  assert.ok(!client.calls.some(([n, a]) => n === "search-companies" && a.searchText === "Acme Robotics"));
  const slugs = JSON.parse(fs.readFileSync(path.join(root, "data", "cache", "levels-slugs.json"), "utf8"));
  assert.equal(slugs.nowhere.slug, null);

  // A second run within the cache windows makes no calls at all.
  const again = fakeClient();
  await refresh({ root, client: again, log: () => {} });
  assert.deepEqual(again.calls, []);
});

test("refresh: a failed level fetch keeps the previous record", async () => {
  const root = workspace();
  await refresh({ root, client: fakeClient(), log: () => {} });
  const later = Date.now() + 40 * 86400000; // levels stale, slugs still cached
  await refresh({ root, client: fakeClient({ failLevels: true }), now: later, log: () => {} });
  const doc = JSON.parse(fs.readFileSync(path.join(root, "data", "comp-levels.json"), "utf8"));
  assert.equal(doc.companies.salesforce.locations[US][0].medianTotalCompensation, 300000);
});

test("refresh: a non-tech profile does nothing", async () => {
  const root = workspace({ isTech: false });
  const client = fakeClient();
  assert.equal(await refresh({ root, client, log: () => {} }), null);
  assert.equal(client.calls.length, 0);
});

test("refresh: a batch refused for sign-in is retried one company at a time; refused ones are marked", async () => {
  const root = workspace();
  const calls = [];
  const client = {
    calls, count: 0,
    async call(name, args) {
      calls.push([name, args]);
      if (name === "search-companies") return { Salesforce: [{ name: "Salesforce", slug: "salesforce" }], Stripe: [{ name: "Stripe", slug: "stripe" }] }[args.searchText] ?? [];
      if (name === "get-company") return { ticker: null };
      if (name === "get-salaries-by-company-level") {
        if (args.companySlugs.includes("stripe")) { const e = new Error("HTTP 401: Sign in to Levels.fyi (free) to use get-salaries-by-company-level."); e.signIn = true; throw e; }
        return { companies: args.companySlugs.map((s) => ({ companySlug: s, levels: [{ level: "Senior", medianTotalCompensation: 300000 }] })) };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
  const r = await refresh({ root, client, log: () => {} });
  const doc = JSON.parse(fs.readFileSync(path.join(root, "data", "comp-levels.json"), "utf8"));
  assert.equal(doc.companies.salesforce.locations[US][0].medianTotalCompensation, 300000);
  assert.equal(doc.companies.stripe, undefined);
  const slugs = JSON.parse(fs.readFileSync(path.join(root, "data", "cache", "levels-slugs.json"), "utf8"));
  assert.ok(slugs.stripe.signInRequiredAt);
  assert.equal(r.stats.signIn, 1);
  // Next run within 30 days does not ask for Stripe again.
  calls.length = 0;
  await refresh({ root, client, now: Date.now() + 26 * 86400000, log: () => {} }); // levels stale (25d), sign-in mark fresh (30d)
  assert.ok(calls.some(([n, a]) => n === "get-salaries-by-company-level" && a.companySlugs.includes("salesforce")));
  assert.ok(!calls.some(([n, a]) => n === "get-salaries-by-company-level" && a.companySlugs.includes("stripe")));
});

test("LevelsClient signed in: sends the token, renews it once on a 401, then retries", async () => {
  const { LevelsClient } = await import("../scripts/hunt-levels-refresh.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "levels-tok-"));
  const tokenPath = path.join(dir, "levels-oauth.json");
  fs.writeFileSync(tokenPath, JSON.stringify({ access_token: "old", refresh_token: "r1", expires_at: Date.now() + 3600_000 }));
  const seen = [];
  let rejectOld = true;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push([body.method, init.headers.authorization]);
    if (init.headers.authorization === "Bearer old" && body.method === "tools/call" && rejectOld) { rejectOld = false; return new Response("unauthorized", { status: 401 }); }
    if (body.method === "tools/call") return new Response(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: true }) }] } }), { status: 200 });
    return new Response("", { status: 200 });
  };
  const c = new LevelsClient({ fetchImpl, tokenPath, spacingMs: 0, renew: async () => ({ access_token: "new", refresh_token: "r1", expires_at: Date.now() + 3600_000 }) });
  assert.equal(c.signedIn, true);
  assert.deepEqual(await c.call("get-permissions", {}), { ok: true });
  assert.equal(seen[0][1], "Bearer old");
  assert.ok(seen.some(([m, a]) => m === "tools/call" && a === "Bearer new"));
  // Not signed in: no header at all.
  const anon = new LevelsClient({ fetchImpl, tokenPath: path.join(dir, "missing.json"), spacingMs: 0 });
  assert.equal(anon.signedIn, false);
});

test("refresh: without levels.home_location only US-wide data is fetched", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "config", "ranking.yml"), "levels_slugs: {}\n");
  const client = fakeClient();
  await refresh({ root, client, log: () => {} });
  const locs = new Set(client.calls.filter(([n]) => n === "get-salaries-by-company-level").map(([, a]) => a.locationSlug));
  assert.deepEqual([...locs], [US]);
  const doc = JSON.parse(fs.readFileSync(path.join(root, "data", "comp-levels.json"), "utf8"));
  assert.deepEqual(Object.keys(doc.companies.salesforce.locations), [US]);
});
