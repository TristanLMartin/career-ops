#!/usr/bin/env node
// Per-company, per-level total comp from Levels.fyi's official MCP server, free tier
// (https://mcp.levels.fyi/). Deterministic, no LLM; an account is optional (scripts/hunt-levels-auth.mjs).
//
// Levels.fyi's published policy (its llms.txt and robots.txt) welcomes agents fetching data for
// an individual person and forbids AI training on the data. This script serves one person's job
// search: it reads only the companies in your own pipeline, stays far under the rate limits,
// caches everything, and keeps the data on your machine. Never commit data/comp-levels.json or
// redistribute it.
//
// 1. Companies: every company in data/hunt-enrich.json that is shortlisted, tracked, or
//    evaluated (plus `--company NAME`), most relevant first, up to --max.
// 2. Slugs: search-companies, accepted only when Levels.fyi's name normalizes to ours (no fuzzy
//    guesses). config/ranking.yml `levels_slugs: { "Company": "slug" | null }` overrides.
//    Cached in data/cache/levels-slugs.json (found: 90 days, not found: 30 days); `public`
//    comes from get-company's ticker.
// 3. Levels: get-salaries-by-company-level, software-engineer, US-wide plus your home metro when
//    config/ranking.yml sets `levels: { home_location: <Levels.fyi location slug> }`,
//    5 companies a call, re-fetched when older than --max-age-days (default 25). Without an
//    account the free tier answers for large companies only; a batch it refuses ("Sign in") is
//    retried one company at a time, and a company refused alone is marked signInRequiredAt in
//    the slug cache and skipped for 30 days.
// 4. Writes data/comp-levels.json (lib/hunt-levels.mjs reads it). A failed fetch keeps the
//    company's previous record.
//
// Usage: node scripts/hunt-levels-refresh.mjs [--max 250] [--max-age-days 25] [--company NAME]... [--dry-run] [--out FILE]
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { loadYaml } from "../lib/yaml-document.mjs";
import { readPerson } from "../lib/profile-paths.mjs";
import { normCompany } from "../lib/hunt-comp.mjs";
import { US, LEVELS_SOURCE } from "../lib/hunt-levels.mjs";
import { tokenFile as defaultTokenFile, refreshToken } from "./hunt-levels-auth.mjs";

const ENDPOINT = "https://mcp.levels.fyi/";
const JOB_FAMILY = "software-engineer";
const SPACING_MS = 5000; // 12 calls a minute, under the free tier's 20
const DAY = 86400000;

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback; };
const args = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Signed in (scripts/hunt-levels-auth.mjs saved a token): every request carries it, an
 * expiring token is renewed first, and a 401 renews it once and retries. Not signed in: the free
 * anonymous tier.
 */
export class LevelsClient {
  constructor({ endpoint = ENDPOINT, spacingMs = SPACING_MS, fetchImpl = fetch, log = () => {}, tokenPath = null, renew = refreshToken } = {}) {
    let token = null;
    try { if (tokenPath) token = JSON.parse(fs.readFileSync(tokenPath, "utf8")); } catch { token = null; }
    Object.assign(this, { endpoint, spacingMs, fetchImpl, log, tokenPath, renew, token, session: null, last: 0, id: 1, count: 0 });
  }
  get signedIn() { return Boolean(this.token?.access_token); }
  async renewToken() {
    this.token = await this.renew(this.tokenPath);
    this.session = null; // a new token starts a new MCP session
    this.log("levels: token renewed");
  }
  async post(body, retried = false) {
    if (this.signedIn && this.token.expires_at && this.token.expires_at < Date.now() + 60_000 && !retried) await this.renewToken();
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "career-ops/1.0" };
    if (this.signedIn) headers.authorization = `Bearer ${this.token.access_token}`;
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await this.fetchImpl(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    const text = await res.text();
    if (res.status === 429) { const e = new Error("rate limited"); e.rateLimited = true; throw e; }
    if (res.status === 401 && this.signedIn && !retried) {
      await this.renewToken();
      if (body.method !== "initialize") await this.init();
      return this.post(body, true);
    }
    if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); e.signIn = res.status === 401 || /sign in to levels/i.test(text); throw e; }
    if (!text.trim()) return null;
    const data = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
    return JSON.parse(data.length ? data.at(-1) : text);
  }
  async init() {
    await this.post({ jsonrpc: "2.0", id: this.id++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "career-ops", version: "1.0" } } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  /** Calls one tool and returns its parsed JSON text result. Paced; retries a rate limit twice. */
  async call(name, args) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      try {
        if (!this.session && this.count === 0) await this.init();
        this.count++;
        const r = await this.post({ jsonrpc: "2.0", id: this.id++, method: "tools/call", params: { name, arguments: args } });
        if (r?.error) throw new Error(`${name}: ${r.error.message ?? JSON.stringify(r.error)}`);
        const text = (r?.result?.content ?? []).map((c) => c.text ?? "").join("");
        if (r?.result?.isError) { const e = new Error(`${name}: ${text.slice(0, 200)}`); e.rateLimited = /rate.?limit/i.test(text); e.signIn = /sign in to levels/i.test(text); throw e; }
        return JSON.parse(text);
      } catch (e) {
        if (e.rateLimited && attempt < 2) { this.log(`rate limited; waiting 65s`); await sleep(65000); continue; }
        throw e;
      }
    }
  }
}

/** Levels.fyi company whose name normalizes to ours, or null (never a fuzzy guess). */
export function acceptSlug(name, results) {
  const key = normCompany(name);
  const hit = (results ?? []).find((r) => normCompany(r.name) === key);
  return hit ? { slug: hit.slug, name: hit.name } : null;
}

/** Companies to cover: shortlisted / tracked / evaluated first, then by best relevance. */
export function companiesFromEnrich(doc, extra = [], max = 250) {
  const jobs = Array.isArray(doc?.jobs) ? doc.jobs : Object.values(doc?.jobs ?? {});
  const score = new Map();
  for (const j of jobs) {
    if (!j?.company) continue;
    const s = (j.status ? 3 : 0) + (j.shortlist || j.groupShortlist ? 2 : 0) + (j.fit != null ? 1 : 0);
    if (s === 0) continue;
    const prev = score.get(j.company) ?? [0, 0];
    score.set(j.company, [Math.max(prev[0], s), Math.max(prev[1], j.relevance ?? 0)]);
  }
  const names = [...score].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).map(([c]) => c);
  const seen = new Set();
  return [...extra, ...names].filter((c) => { const k = normCompany(c); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, max + extra.length);
}

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export async function refresh({ root = getCareerOpsRoot(), max = 250, maxAgeDays = 25, extra = [], dryRun = false, client = null, now = Date.now(), log = console.log, out: outPath = null } = {}) {
  if (readPerson(root).is_tech !== true) { log("levels refresh: not a tech profile, nothing to do"); return null; }
  const enrich = readJson(path.join(root, "data", "hunt-enrich.json"), null);
  if (!enrich) throw new Error("data/hunt-enrich.json is missing; run the scan first");
  let cfg = {};
  try { cfg = loadYaml(fs.readFileSync(path.join(root, "config", "ranking.yml"), "utf8")) ?? {}; } catch {}
  const overrides = cfg.levels_slugs ?? {};
  const home = typeof cfg.levels?.home_location === "string" && cfg.levels.home_location.trim() ? cfg.levels.home_location.trim() : null;
  const locs = home ? [home, US] : [US];
  const overrideByKey = new Map(Object.entries(overrides).map(([k, v]) => [normCompany(k), v]));
  const companies = companiesFromEnrich(enrich, extra, max);
  log(`levels refresh: ${companies.length} companies`);
  if (dryRun) { log(companies.join(", ")); return { companies }; }

  const slugFile = path.join(root, "data", "cache", "levels-slugs.json");
  // --out writes somewhere else (a staging copy to compare before it goes live); it starts from the live file.
  const liveFile = path.join(root, "data", "comp-levels.json");
  const outFile = outPath ? path.resolve(outPath) : liveFile;
  const slugs = readJson(slugFile, {});
  const prev = readJson(fs.existsSync(outFile) ? outFile : liveFile, { companies: {} });
  const out = { fetchedAt: new Date(now).toISOString(), source: `${LEVELS_SOURCE} MCP (free tier)`, jobFamily: JOB_FAMILY, companies: { ...(prev.companies ?? {}) } };
  const tokenPath = defaultTokenFile(root);
  const c = client ?? new LevelsClient({ log, tokenPath, spacingMs: fs.existsSync(tokenPath) ? 2500 : SPACING_MS }); // signed in: 60 a minute, we use 24
  if (c.signedIn) log("levels refresh: signed in to Levels.fyi");
  const stats = { slugLookups: 0, notFound: 0, fetched: 0, kept: 0, failed: 0, signIn: 0 };

  // 2. Slugs.
  for (const name of companies) {
    const key = normCompany(name);
    if (overrideByKey.has(key)) {
      const o = overrideByKey.get(key) || null;
      const known = slugs[key]?.manual && slugs[key].slug === o && slugs[key].public != null;
      let isPublic = known ? slugs[key].public : null;
      if (o && !known) { try { const prof = await c.call("get-company", { companyNameOrSlug: o }); isPublic = prof ? Boolean(prof.ticker) : null; } catch (e) { log(`company ${o}: ${e.message}`); } }
      slugs[key] = { ...(slugs[key] ?? {}), name, slug: o, public: isPublic, checkedAt: new Date(now).toISOString(), manual: true };
      writeJsonAtomic(slugFile, slugs);
      continue;
    }
    const cached = slugs[key];
    const age = cached ? now - Date.parse(cached.checkedAt) : Infinity;
    if (cached && age < (cached.slug ? 90 : 30) * DAY) continue;
    try {
      stats.slugLookups++;
      const hit = acceptSlug(name, await c.call("search-companies", { searchText: name, limit: 5 }));
      let isPublic = null;
      if (hit) { const prof = await c.call("get-company", { companyNameOrSlug: hit.slug }); isPublic = prof?.ticker ? true : prof ? false : null; }
      else stats.notFound++;
      slugs[key] = { name, slug: hit?.slug ?? null, levelsName: hit?.name ?? null, public: isPublic, checkedAt: new Date(now).toISOString() };
    } catch (e) { log(`slug ${name}: ${e.message}`); }
    writeJsonAtomic(slugFile, slugs);
  }

  // 3. Levels, 5 slugs a call, for companies whose record is missing or stale.
  // Signed in, a company that needed sign-in is tried again.
  const signInFresh = (k) => !c.signedIn && slugs[k]?.signInRequiredAt && now - Date.parse(slugs[k].signInRequiredAt) < 30 * DAY;
  const due = companies.map((n) => [normCompany(n), n]).filter(([k]) => slugs[k]?.slug && !signInFresh(k) && !(out.companies[k] && now - Date.parse(out.companies[k].fetchedAt) < maxAgeDays * DAY));
  const fetchLevels = async (batch) => {
    const locations = {};
    for (const loc of locs) {
      const r = await c.call("get-salaries-by-company-level", { jobFamilySlug: JOB_FAMILY, locationSlug: loc, companySlugs: batch.map(([k]) => slugs[k].slug) });
      for (const co of r?.companies ?? []) (locations[co.companySlug] ??= {})[loc] = co.levels ?? [];
    }
    for (const [key, name] of batch) {
      const slug = slugs[key].slug, got = locations[slug] ?? {};
      out.companies[key] = { name, slug, public: slugs[key].public ?? null, fetchedAt: new Date(now).toISOString(), locations: Object.fromEntries(locs.map((l) => [l, got[l] ?? []])) };
      stats.fetched++;
    }
  };
  for (let i = 0; i < due.length; i += 5) {
    const batch = due.slice(i, i + 5);
    try {
      await fetchLevels(batch);
    } catch (e) {
      if (!e.signIn) { stats.failed += batch.length; log(`levels ${batch.map(([k]) => slugs[k].slug).join(",")}: ${e.message} (previous data kept)`); }
      else {
        for (const one of batch) {
          try { await fetchLevels([one]); }
          catch (e1) {
            if (e1.signIn) { stats.signIn++; slugs[one[0]] = { ...slugs[one[0]], signInRequiredAt: new Date(now).toISOString() }; }
            else { stats.failed++; log(`levels ${slugs[one[0]].slug}: ${e1.message} (previous data kept)`); }
          }
        }
        writeJsonAtomic(slugFile, slugs);
      }
    }
    writeJsonAtomic(outFile, out);
  }
  stats.kept = Object.keys(out.companies).length;
  writeJsonAtomic(outFile, out);
  const withData = Object.values(out.companies).filter((r) => Object.values(r.locations ?? {}).some((l) => l?.length)).length;
  log(`levels refresh: ${stats.slugLookups} slug lookups (${stats.notFound} not on levels.fyi), ${stats.fetched} fetched, ${stats.signIn} need a Levels.fyi sign-in, ${stats.failed} failed; ${stats.kept} companies on file, ${withData} with level data; ${c.count} calls`);
  return { stats, withData };
}

if (isMainModule(import.meta.url)) {
  refresh({ max: Number(arg("--max", 250)), maxAgeDays: Number(arg("--max-age-days", 25)), extra: args("--company"), dryRun: argv.includes("--dry-run"), out: arg("--out", null) })
    .catch((e) => { console.error(`levels refresh failed: ${e.message}`); process.exit(1); });
}
