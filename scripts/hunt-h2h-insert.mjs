#!/usr/bin/env node
// hunt-h2h-insert: place a few new roles into the existing head-to-head ranking without
// re-running the whole weekly tournament.
//
// Each round splits the current top N (by h2h_rank) into batches and adds every new role to
// every batch; Sonnet ranks each batch (same prompt and cards as hunt-h2h.mjs). A new role
// is inserted just above the best-ranked incumbent it beat most often; one that beats none
// is placed after the top N. Incumbents keep their order. data/hunt-h2h.json is updated in
// place (inserted items carry "inserted": true) and the weekly run replaces it as usual.
// Cost is logged to data/hunt-usage.tsv. Never applies or sends anything.
//
// Usage: node scripts/hunt-h2h-insert.mjs --urls u1,u2 [--top 20] [--rounds 2] [--batch 7]
import fs from "node:fs";
import path from "node:path";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { MODEL, cardFor, keyRequirements, parseRanking, promptFor, rng, shuffle } from "./hunt-h2h.mjs";
import { runClaude, logUsage } from "./hunt-quickscore.mjs";
import { exitOnHelp, requireSpendConsent } from "../lib/cli-guard.mjs";

/**
 * Where each new id goes, from the batch rankings. incumbents: ids in current rank order.
 * Returns the merged order of ids.
 */
export function insertOrder(incumbents, newIds, rankings) {
  const beatsAt = new Map(newIds.map((n) => [n, new Map()]));
  for (const order of rankings) {
    for (const n of newIds) {
      const p = order.indexOf(n);
      if (p < 0) continue;
      for (const other of order.slice(p + 1)) {
        if (!incumbents.includes(other)) continue;
        const m = beatsAt.get(n);
        m.set(other, (m.get(other) ?? 0) + 1);
      }
    }
  }
  // Position = index of the best incumbent it beat (in every batch that pair met), else the end.
  const met = (n, inc) => rankings.filter((o) => o.includes(n) && o.includes(inc)).length;
  const slot = new Map(newIds.map((n) => {
    const m = beatsAt.get(n);
    const i = incumbents.findIndex((inc) => (m.get(inc) ?? 0) > 0 && m.get(inc) >= met(n, inc));
    return [n, i < 0 ? incumbents.length : i];
  }));
  const out = [];
  for (let i = 0; i <= incumbents.length; i++) {
    // new ids for this slot: the one ranked higher more often first
    const here = newIds.filter((n) => slot.get(n) === i).sort((a, b) => {
      const ab = rankings.filter((o) => o.includes(a) && o.includes(b) && o.indexOf(a) < o.indexOf(b)).length;
      const ba = rankings.filter((o) => o.includes(a) && o.includes(b) && o.indexOf(b) < o.indexOf(a)).length;
      return ba - ab;
    });
    out.push(...here);
    if (i < incumbents.length) out.push(incumbents[i]);
  }
  return out;
}

export async function insert({ root = getCareerOpsRoot(), urls, top = 20, rounds = 2, size = 7, run = runClaude, log = () => {} } = {}) {
  const enrich = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-enrich.json"), "utf8")).jobs;
  const h2hFile = path.join(root, "data", "hunt-h2h.json");
  const doc = JSON.parse(fs.readFileSync(h2hFile, "utf8"));
  const items = [...doc.items].sort((a, b) => a.h2h_rank - b.h2h_rank);
  const topItems = items.filter((i) => !urls.includes(i.url)).slice(0, top);
  const reportsDir = path.join(root, "reports");
  const reportFiles = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
  const card = (id, url) => {
    const e = enrich[url];
    const n = e?.report?.n;
    const f = n ? reportFiles.find((x) => x.startsWith(`${n}-`)) : null;
    return cardFor(id, e, f ? keyRequirements(fs.readFileSync(path.join(reportsDir, f), "utf8")) : "");
  };
  const inc = topItems.map((_, i) => `T${String(i + 1).padStart(2, "0")}`);
  const nids = urls.map((_, i) => `N${i + 1}`);
  const urlOf = new Map([...inc.map((id, i) => [id, topItems[i].url]), ...nids.map((id, i) => [id, urls[i]])]);
  const cards = new Map([...urlOf].map(([id, url]) => [id, card(id, url)]));
  const readOr = (f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
  const profile = [readOr("skills-profile.md"), readOr("cv.md")].join("\n\n---\n\n");
  const rankings = [];
  let cost = 0;
  for (let r = 0; r < rounds; r++) {
    const mixed = shuffle(inc, rng(7000 + r));
    const groups = [];
    for (let i = 0; i < mixed.length; i += size) groups.push([...mixed.slice(i, i + size), ...nids]);
    await Promise.all(groups.map(async (ids) => {
      const order = shuffle(ids, rng(9000 + r + ids.length));
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await run(promptFor(profile, order.map((i) => cards.get(i))), MODEL);
        cost += Number(res.cost) || 0;
        const parsed = res.code === 0 ? parseRanking(res.result, order) : null;
        logUsage(root, { model: `${MODEL} (h2h insert)`, status: parsed ? `ok ${order.length} ranked` : `error ${res.error || "format"}`.slice(0, 100), secs: res.secs, tokens: res.tokens, cost: res.cost, role: `h2h insert batch of ${order.length}` });
        if (parsed) { rankings.push(parsed.order); log(`  round ${r + 1}: ranked ${order.length}`); return; }
      }
      log(`  round ${r + 1}: batch failed twice`);
    }));
  }
  const merged = insertOrder(inc, nids, rankings);
  // Rebuild items: merged top section, then everything else in its old order.
  const topUrls = merged.map((id) => urlOf.get(id));
  const rest = items.filter((i) => !topUrls.includes(i.url));
  const byUrl = new Map(items.map((i) => [i.url, i]));
  const out = [...topUrls, ...rest.map((i) => i.url)].map((url, i) => {
    const old = byUrl.get(url);
    const e = enrich[url];
    return old ? { ...old, h2h_rank: i + 1 } : { url, company: e.company, role: e.displayRole ?? e.role, h2h_rank: i + 1, composite: e.composite, fit: e.fit, why: "", inserted: true };
  });
  const next = { ...doc, items: out, insertedAt: new Date().toISOString(), insertCostUsd: Math.round(cost * 1000) / 1000 };
  const tmp = `${h2hFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1));
  fs.renameSync(tmp, h2hFile);
  return { placed: urls.map((u) => ({ url: u, rank: out.find((i) => i.url === u)?.h2h_rank })), costUsd: next.insertCostUsd, calls: rankings.length };
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  requireSpendConsent("hunt-h2h-insert", { freeFlags: [] });
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  const urls = String(arg("--urls", "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { console.error("usage: --urls u1,u2"); process.exit(2); }
  const r = await insert({ urls, top: Number(arg("--top", 20)), rounds: Number(arg("--rounds", 2)), size: Number(arg("--batch", 7)), log: console.log });
  console.log(JSON.stringify(r, null, 1));
}
