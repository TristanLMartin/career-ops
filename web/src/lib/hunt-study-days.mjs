/**
 * hunt: the study days (data/study/days.md) and the study docs around them. Pure; testable.
 *
 * days.md: "## Phase …" > optional "### Week …" > "### Day N: theme" / "### Fast-track Day N",
 * each followed by "- " bullets. Every bullet is one tickable item, keyed by day + bullet index
 * (stableId), stored with the other ticks in data/study-state.json.
 */
import { stableId } from "./hunt-study.mjs";

export const ITEM_TYPES = Object.freeze(["Coding", "Design", "Stories", "Drill", "Company", "Mock", "Read", "Project", "Rest", "AI round practice", "Python refresher first"]);

/** "Coding: ★ Two Sum (1)" -> { type: "Coding", text: "★ Two Sum (1)", star: true }. */
export function splitItem(line) {
  const s = String(line ?? "").trim();
  const m = s.match(/^([A-Z][A-Za-z ]{1,30}?):\s+(.*)$/);
  const type = m && ITEM_TYPES.includes(m[1]) ? m[1] : null;
  const text = type ? m[2] : s;
  return { type: type === "Python refresher first" ? "Coding" : type, text: type === "Python refresher first" ? `Python refresher first: ${m[2]}` : text, star: /★/.test(text) };
}

/** Parse days.md -> { intro, sections: [{ title, weeks: [{ title, days: [...] }] }], days: [...] } (days in order). */
export function parseDays(md) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  const days = [];
  const intro = [];
  let section = null, week = null, day = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    const h3 = line.match(/^###\s+(.*)$/);
    if (h2 && !line.startsWith("###")) {
      section = { title: h2[1].trim(), weeks: [] };
      sections.push(section);
      week = null; day = null;
      continue;
    }
    if (h3) {
      const title = h3[1].trim();
      const dm = title.match(/^(Fast-track\s+)?Day\s+(\d+)(?::\s*(.*))?$/i);
      if (dm) {
        const fast = !!dm[1];
        const n = Number(dm[2]);
        const key = `${fast ? "ft" : "d"}${n}`;
        if (!section) { section = { title: "", weeks: [] }; sections.push(section); }
        if (!week) { week = { title: "", days: [] }; section.weeks.push(week); }
        day = { key, n, fast, theme: (dm[3] ?? "").trim() || (fast ? `Fast-track day ${n}` : ""), title, items: [], section: section.title, week: week.title };
        week.days.push(day);
        days.push(day);
      } else {
        week = { title, days: [] };
        if (!section) { section = { title: "", weeks: [] }; sections.push(section); }
        section.weeks.push(week);
        day = null;
      }
      continue;
    }
    const b = line.match(/^\s*-\s+(.*)$/);
    if (b && day) {
      const index = day.items.length;
      day.items.push({ id: stableId("days", day.key, index), index, ...splitItem(b[1]) });
      continue;
    }
    if (!section && line.trim() && !line.startsWith("#")) intro.push(line.trim());
  }
  return { intro, sections, days };
}

export const isDayDone = (day, ticks) => day.items.length > 0 && day.items.every((i) => ticks?.[i.id]);

/** The current day in a track: the first day not fully ticked (missed calendar days never skip content). */
export function currentDay(days, ticks, { fastTrack = false } = {}) {
  const track = days.filter((d) => d.fast === fastTrack);
  return track.find((d) => !isDayDone(d, ticks)) ?? null;
}

export function trackProgress(days, ticks, { fastTrack = false } = {}) {
  const track = days.filter((d) => d.fast === fastTrack);
  return { done: track.filter((d) => isDayDone(d, ticks)).length, total: track.length };
}

/** The next n unticked items of a day. */
export const nextItems = (day, ticks, n = 3) => (day?.items ?? []).filter((i) => !ticks?.[i.id]).slice(0, n);

// ── LeetCode links ─────────────────────────────────────────────────────────

/** Names whose LeetCode slug isn't the plain slug of the name, by problem number. */
export const SLUG_OVERRIDES = Object.freeze({
  103: "binary-tree-zigzag-level-order-traversal",
  208: "implement-trie-prefix-tree",
  2043: "simple-bank-system",
  380: "insert-delete-getrandom-o1",
});

/** Lowercase, hyphens, punctuation dropped: "Insert Delete GetRandom O(1)" -> "insert-delete-getrandom-o1". */
export function slugify(name) {
  return String(name ?? "").toLowerCase().replace(/['’().,:!?]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function leetcodeSlug(name, number) {
  return SLUG_OVERRIDES[Number(number)] ?? slugify(name);
}

/**
 * Split an item's text into plain and LeetCode-link segments. A problem is "Name (number)"; the
 * name runs back to the start, a comma, "then", "★", or a "label:" prefix.
 * -> [{ text } | { text, problem: { name, number, url, star } }]
 */
export function linkProblems(text) {
  const s = String(text ?? "");
  const out = [];
  const re = /\s\((\d{1,4})\)/g; // " (146)": a space before, so "O(1)" stays part of the name
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    let before = s.slice(last, m.index);
    let lead = "";
    // the name starts after the last delimiter: start, ", ", "then ", ": ", "★", or " and " between two problems
    const cuts = [", ", "then ", ": ", "★"].map((d) => { const i = before.lastIndexOf(d); return i < 0 ? -1 : i + d.length; });
    let start = Math.max(0, ...cuts);
    if (last > 0 && /^\s+and\s+/.test(before) && start === 0) start = before.match(/^\s+and\s+/)[0].length;
    lead = before.slice(0, start);
    let name = before.slice(start).trim();
    const verb = name.match(/^(solve|rewrite|redo|build|write)\s+/i);
    if (verb) { lead += verb[0]; name = name.slice(verb[0].length); }
    if (!name) { continue; }
    const star = /★\s*$/.test(lead);
    if (star) lead = lead.replace(/★\s*$/, "");
    if (lead) out.push({ text: lead });
    out.push({ text: `${name} (${m[1]})`, problem: { name, number: Number(m[1]), url: `https://leetcode.com/problems/${leetcodeSlug(name, m[1])}/`, star } });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out.length ? out : [{ text: s }];
}

// ── docs: anchors and cross-links ───────────────────────────────────────────

/** Heading -> URL anchor: "Search over a user's mail" -> "search-over-a-users-mail". */
export const anchor = (title) => slugify(String(title ?? "").replace(/\(.*?\)/g, ""));

/** Design prompt titles (## and ### headings of design-prompts.md) -> anchors. */
export function designPromptIndex(md) {
  const out = [];
  for (const line of String(md ?? "").split("\n")) {
    const h = line.match(/^#{2,3}\s+(.*)$/);
    if (h && !/^Design prompts$/i.test(h[1])) out.push({ title: h[1].trim(), anchor: anchor(h[1]) });
  }
  return out;
}

const DOC_TABS = Object.freeze({ "stories.md": "stories", "resources.md": "notes", "company-prep.md": "companies", "lessons.md": "notes", "nov17-lessons.md": "notes", "checkpoints.md": "notes", "design-prompts.md": "design" });
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Cross-links inside an item: quoted design prompt names -> /study/design#anchor; "FDE
 * decomposition drill N" -> its drill; "stories.md" etc. -> their tab.
 * Returns [{ text, href? }] over the given text (after LeetCode linking, plain segments only).
 */
export function linkRefs(text, prompts) {
  const s = String(text ?? "");
  const marks = [];
  for (const m of s.matchAll(/"([^"]{3,80})"/g)) {
    const q = norm(m[1]).replace(/^design a /, "").replace(/^low latency /, "");
    const hit = prompts.find((p) => norm(p.title) === q) ?? prompts.find((p) => norm(p.title).startsWith(q) || q.startsWith(norm(p.title).replace(/ databricks.*$/, "")) || norm(p.title).includes(q));
    if (hit) marks.push({ start: m.index, end: m.index + m[0].length, href: `/study/design#${hit.anchor}` });
  }
  for (const m of s.matchAll(/FDE decomposition drills?\s+(\d)/gi)) {
    const hit = prompts.find((p) => new RegExp(`^Drill ${m[1]}\\b`, "i").test(p.title));
    if (hit) marks.push({ start: m.index, end: m.index + m[0].length, href: `/study/design#${hit.anchor}` });
  }
  for (const m of s.matchAll(/\b(stories|resources|company-prep|lessons|nov17-lessons|checkpoints|design-prompts)\.md\b/g)) {
    marks.push({ start: m.index, end: m.index + m[0].length, href: `/study/${DOC_TABS[m[0]]}` });
  }
  marks.sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const mk of marks) {
    if (mk.start < at) continue;
    if (mk.start > at) out.push({ text: s.slice(at, mk.start) });
    out.push({ text: s.slice(mk.start, mk.end), href: mk.href });
    at = mk.end;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** checkpoints.md -> [{ day, text }] for "End of Day N: …" bullets. */
export function parseCheckpoints(md) {
  return String(md ?? "").split("\n").map((l) => l.match(/^\s*-\s+End of Day\s+(\d+):\s*(.*)$/)).filter(Boolean).map((m) => ({ day: Number(m[1]), text: m[2].trim() }));
}

/** The next checkpoint at or after day n. */
export const nextCheckpoint = (checkpoints, n) => (checkpoints ?? []).find((c) => c.day >= (n ?? 1)) ?? null;

/** company-prep.md "## Company: …" headings -> [{ title, anchor, company }]. */
export function companySections(md) {
  return String(md ?? "").split("\n").map((l) => l.match(/^##\s+(.*)$/)).filter(Boolean).map((m) => ({ title: m[1].trim(), anchor: anchor(m[1]), company: m[1].split(":")[0].trim() }));
}

/** The company-prep section for a tracker company, or null. */
export function companyAnchor(sections, company) {
  const c = norm(company).replace(/\s*\(.*$/, "");
  if (!c || c === "unknown") return null;
  return sections.find((s) => norm(s.company).startsWith(c) || c.startsWith(norm(s.company)))?.anchor ?? null;
}
