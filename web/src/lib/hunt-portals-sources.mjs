/**
 * hunt: every company a profile monitors, not only portals.yml. scan.mjs also reads the
 * discovery portals files (scripts/hunt-discover.mjs, scripts/hunt-discover-wide.mjs)
 * through CAREER_OPS_PORTALS, so the Portals page lists them all with where each one comes from.
 * A file a profile does not have is skipped (a second profile has only portals.yml).
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { atsBoard } from "./hunt-company-filter.mjs";

/** Source key -> data-root-relative file and label, in display order. */
export const PORTAL_SOURCES = Object.freeze([
  { key: "portals", file: "portals.yml", label: "Watchlist" },
  { key: "targets", file: "data/discovery-targets.yml", label: "Targets" },
  { key: "boards", file: "data/discovery-boards.yml", label: "Discovered" },
  { key: "vc", file: "data/discovery-vc.yml", label: "VC" },
  { key: "hn", file: "data/discovery-hn.yml", label: "HN" },
]);

const hostOf = (url) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return "";
  }
};
const norm = (s) => String(s ?? "").trim().toLowerCase();

/**
 * @typedef {{ name: string, enabled: boolean, host: string, sources: string[], boards: string[] }} SourcedCompany
 * @param {Record<string, string>} texts source key -> raw YAML (missing keys are skipped)
 * @returns {{ companies: SourcedCompany[], totals: Record<string, number>, vcBoards: number, total: number, labels: { key: string, label: string }[] }}
 */
export function mergePortalSources(texts) {
  /** @type {Map<string, SourcedCompany>} */
  const byName = new Map();
  /** @type {Record<string, number>} */
  const totals = {};
  let vcBoards = 0;
  for (const { key } of PORTAL_SOURCES) {
    const text = texts[key];
    if (typeof text !== "string") continue;
    let doc;
    try {
      doc = yaml.load(text);
    } catch {
      continue;
    }
    const list = Array.isArray(doc?.tracked_companies) ? doc.tracked_companies : [];
    if (key === "vc" && Array.isArray(doc?.job_boards)) vcBoards = doc.job_boards.length;
    let n = 0;
    for (const c of list) {
      if (!c || typeof c.name !== "string" || !c.name.trim()) continue;
      n++;
      const k = norm(c.name);
      const prev = byName.get(k);
      const board = atsBoard(c.careers_url) ?? atsBoard(c.api);
      if (prev && board && !prev.boards.includes(board)) prev.boards.push(board);
      if (prev) {
        if (!prev.sources.includes(key)) prev.sources.push(key);
        prev.enabled = prev.enabled || c.enabled !== false;
        if (!prev.host) prev.host = hostOf(c.careers_url ?? c.api);
      } else {
        byName.set(k, { name: c.name.trim(), enabled: c.enabled !== false, host: hostOf(c.careers_url ?? c.api), sources: [key], boards: board ? [board] : [] });
      }
    }
    totals[key] = n;
  }
  const companies = [...byName.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  const labels = PORTAL_SOURCES.filter((s) => totals[s.key]).map(({ key, label }) => ({ key, label }));
  return { companies, totals, vcBoards, total: companies.length, labels };
}

/** Reads the source files under `root` and merges them. */
export function readPortalSources(root) {
  /** @type {Record<string, string>} */
  const texts = {};
  for (const { key, file } of PORTAL_SOURCES) {
    try {
      texts[key] = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      /* not part of this profile */
    }
  }
  return mergePortalSources(texts);
}
