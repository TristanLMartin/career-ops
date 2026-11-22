#!/usr/bin/env node
// hunt-jd-fetch: job descriptions for postings whose board has no bulk JD API that
// hunt-enrich reads (Amazon, Google, Apple, Microsoft, Netflix, JPMorgan/Oracle HCM,
// Atlassian). One public, login-free request per posting with an honest User-Agent,
// one per second, cached by URL in data/cache/hunt-jd/sites.json for 7 days.
// hunt-enrich reads that cache like manual.json. JD text is untrusted data.
//
// Usage: node scripts/hunt-jd-fetch.mjs [--limit N] [--all]
//   default: only inbox postings at location tier 1/2/5 (or NYC/Chicago at quants/banks)
//   whose level is Senior / Senior-Staff / Mid; --all fetches every matching host.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { htmlToText, parsePipeline } from "./hunt-enrich.mjs";
import { locationTier, levelFit } from "../lib/hunt-rank.mjs";
import { exitOnHelp } from "../lib/cli-guard.mjs";

const UA = "career-ops-hunt-enrich/1.0 (personal job search; low volume)";
const PACE_MS = Number(process.env.HUNT_JD_PACE_MS ?? 1000);
const TTL = 7 * 24 * 3600 * 1000;
const HERE = path.dirname(new URL(import.meta.url).pathname);

let last = 0;
async function get(url, accept = "*/*") {
  const wait = last + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const clip = (s, n = 14000) => String(s ?? "").slice(0, n);
/** Text from `from` (first marker found) for up to n chars. */
function sliceFrom(text, markers, before = 0, n = 12000) {
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0) return text.slice(Math.max(0, i - before), i + n);
  }
  return "";
}
const jsonStr = (html, key) => {
  const m = html.match(new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"((?:[^"\\\\]|\\\\.){0,20000}?)\\\\?"`));
  if (!m) return "";
  try { return JSON.parse(`"${m[1].replace(/\\\\/g, "\\")}"`); } catch { return m[1]; }
};

export const SITES = [
  {
    id: "amazon", match: /amazon\.jobs\//,
    async fetch(url) {
      const t = htmlToText(await get(url));
      return sliceFrom(t, ["DESCRIPTION", "Description"], 0, 9000);
    },
  },
  {
    id: "google", match: /google\.com\/about\/careers\/applications\/jobs\/results\/\d+/,
    async fetch(url, row) {
      const t = htmlToText(await get(url.replace(/\?.*$/, "")));
      // The page also lists other postings: start at this posting's own title heading.
      const at = row?.role ? t.lastIndexOf(row.role.trim()) : -1;
      const from = at >= 0 ? t.slice(at) : t;
      const s = sliceFrom(from, ["Minimum qualifications"], 0, 9000);
      const pay = t.match(/The US base salary range for this full-time position is[^.]{0,200}/)?.[0] ?? "";
      return at >= 0 && s ? `${row.role}\n${s}${pay && !s.includes(pay) ? `\n${pay}` : ""}` : "";
    },
  },
  {
    id: "apple", match: /jobs\.apple\.com\/[a-z-]+\/details\//,
    async fetch(url) {
      const h = await get(url);
      const parts = ["jobSummary", "description", "minimumQualifications", "preferredQualifications", "responsibilities", "payAndBenefits"].map((k) => jsonStr(h, k)).filter(Boolean);
      return htmlToText(parts.join("\n\n"));
    },
  },
  {
    id: "netflix", match: /explore\.jobs\.netflix\.net\/careers\/job\/(\d+)/,
    async fetch(url) {
      const id = url.match(this.match)[1];
      const d = JSON.parse(await get(`https://explore.jobs.netflix.net/api/apply/v2/jobs/${id}?domain=netflix.com`, "application/json"));
      return htmlToText(d.job_description ?? "");
    },
  },
  {
    id: "oraclehcm", match: /([a-z0-9]+)\.fa\.(?:[a-z0-9]+\.)?oraclecloud\.com\/hcmUI\/CandidateExperience\/[a-z]+\/sites\/([A-Za-z0-9_]+)\/job\/(\d+)/,
    async fetch(url) {
      const m = url.match(this.match);
      const host = new URL(url).hostname;
      const d = JSON.parse(await get(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${m[3]}%22,siteNumber=${m[2]}`, "application/json"));
      const it = d.items?.[0] ?? {};
      return htmlToText([it.ExternalDescriptionStr, it.ExternalResponsibilitiesStr, it.ExternalQualificationsStr, it.CorporateDescriptionStr].filter(Boolean).join("\n\n"));
    },
  },
  {
    id: "atlassian", match: /atlassian\.icims\.com\/jobs\/\d+/,
    feed: null,
    async fetch(url) {
      if (!this.feed) this.feed = JSON.parse(await get("https://www.atlassian.com/endpoint/careers/listings", "application/json"));
      const id = url.match(/\/jobs\/(\d+)/)[1];
      const j = this.feed.find((x) => String(x.portalJobPost?.portalUrl ?? "").includes(`/jobs/${id}/`) || String(x.applyUrl ?? "").includes(`/jobs/${id}/`));
      return j ? htmlToText([j.overview, j.responsibilities, j.qualifications].filter(Boolean).join("\n\n")) : "";
    },
  },
  {
    // Built In job pages: a schema.org JobPosting in an ld+json script whose type attribute is
    // entity-encoded ("ld&#x2B;json"), which generic JSON-LD readers miss.
    id: "builtin", match: /^https:\/\/(www\.)?builtin[a-z]*\.com\/job\//,
    async fetch(url) {
      const h = await get(url);
      for (const m of h.matchAll(/<script[^>]*type="application\/ld(?:\+|&#x2B;)json"[^>]*>([\s\S]*?)<\/script>/gi)) {
        let d; try { d = JSON.parse(m[1]); } catch { continue; }
        const nodes = [d, ...(Array.isArray(d["@graph"]) ? d["@graph"] : [])];
        const jp = nodes.find((n) => n && n["@type"] === "JobPosting");
        if (!jp) continue;
        const bs = jp.baseSalary?.value;
        const pay = bs && bs.minValue && bs.maxValue ? `\nBase salary: $${Number(bs.minValue).toLocaleString("en-US")} - $${Number(bs.maxValue).toLocaleString("en-US")} per ${String(bs.unitText ?? "year").toLowerCase()}` : "";
        return htmlToText(jp.description ?? "") + pay;
      }
      return "";
    },
  },
  {
    // schema.org JobPosting on the page, through career-ops' own fetch-jd.mjs.
    id: "fetch-jd", match: /apply\.careers\.microsoft\.com\//,
    async fetch(url) {
      const wait = last + 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const p = spawnSync(process.execPath, [path.join(HERE, "..", "fetch-jd.mjs"), url], { encoding: "utf8", timeout: 60000 });
      return p.status === 0 ? p.stdout : "";
    },
  },
];

export async function jdFetch({ root = getCareerOpsRoot(), limit = 2000, all = false, log = () => {} } = {}) {
  const file = path.join(root, "data", "cache", "hunt-jd", "sites.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, "utf8")).postings ?? {}; } catch {}
  const rows = parsePipeline(fs.readFileSync(path.join(root, "data", "pipeline.md"), "utf8"));
  const want = rows.filter((r) => SITES.some((s) => s.match.test(r.url))).filter((r) => {
    if (all) return true;
    const tier = locationTier(r.location);
    const lv = levelFit(r.role, r.company).key;
    return [1, 2, 5, 3].includes(tier) && ["senior", "dual", "mid"].includes(lv);
  });
  const counts = { candidates: want.length, cached: 0, fetched: 0, empty: 0, errors: 0 };
  let n = 0;
  const limited = new Map(); // site id -> consecutive 429s; a site that keeps answering 429 is left for the next run
  for (const r of want) {
    const c = cache[r.url];
    if (c && Date.now() - c.fetchedAt < TTL && (c.text || (c.error && !/HTTP 429/.test(c.error)))) { counts.cached++; continue; }
    const site = SITES.find((s) => s.match.test(r.url));
    if ((limited.get(site.id) ?? 0) >= 3) { counts.deferred = (counts.deferred ?? 0) + 1; continue; }
    if (n++ >= limit) break;
    try {
      const text = clip((await site.fetch(r.url, r)).trim());
      cache[r.url] = { fetchedAt: Date.now(), site: site.id, text };
      if (text.length < 300) counts.empty++; else counts.fetched++;
      limited.set(site.id, 0);
    } catch (e) {
      cache[r.url] = { fetchedAt: Date.now(), site: site.id, text: "", error: String(e.message ?? e).slice(0, 120) };
      counts.errors++;
      if (/HTTP 429/.test(String(e.message))) limited.set(site.id, (limited.get(site.id) ?? 0) + 1);
    }
    if (n % 25 === 0) { fs.writeFileSync(file, JSON.stringify({ postings: cache })); log(`  ${n} fetched so far`); }
  }
  fs.writeFileSync(file, JSON.stringify({ postings: cache }));
  return counts;
}

if (isMainModule(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) exitOnHelp(import.meta.url);
  const i = process.argv.indexOf("--limit");
  const r = await jdFetch({ limit: i > 0 ? Number(process.argv[i + 1]) : 2000, all: process.argv.includes("--all"), log: console.log });
  console.log(`hunt-jd-fetch: ${r.candidates} candidates, ${r.cached} cached, ${r.fetched} fetched, ${r.empty} empty, ${r.errors} errors, ${r.deferred ?? 0} deferred (rate-limited)`);
}
