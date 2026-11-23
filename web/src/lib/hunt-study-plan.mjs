/**
 * edits to the study plan (data/study/days.md) and the flashcard deck
 * (data/study/cards.jsonl). Pure text in, text out; the dashboard's POST /api/profile/study-plan
 * writes the result, snapshots the old file and logs the edit.
 *
 * Done state survives every edit: the first edit writes each bullet's current id into the file
 * as `<!-- id:xxxx -->` (materialize), and from then on an item keeps its id when its text,
 * type, day or position changes, and when days are inserted and renumbered. Archiving marks the
 * id (`<!-- id:xxxx archived -->`); nothing is ever deleted.
 */
import { ITEM_MARKER, parseDays, splitItem } from "./hunt-study-days.mjs";
import { stableId } from "./hunt-study.mjs";

const DAY_HEAD = /^###\s+(Fast-track\s+)?Day\s+(\d+)(?::\s*(.*))?\s*$/i;
const H2 = /^##\s+(?!#)(.*)$/;
const ANY_HEAD = /^#{2,3}\s+/;
const BULLET = /^\s*-\s+(.*)$/;
const TYPE_RE = /^[A-Z][A-Za-z0-9#+]*(?: [A-Za-z0-9#+]+){0,3}$/;

export class PlanError extends Error {}
const fail = (msg) => { throw new PlanError(msg); };

const split = (md) => String(md ?? "").replace(/\r\n/g, "\n").split("\n");

/** Day blocks in file order: { key, n, fast, head, end (exclusive), section, theme }. */
function blocks(lines) {
  const out = [];
  let section = "";
  let cur = null;
  lines.forEach((line, i) => {
    const h2 = line.match(H2);
    if (h2 || ANY_HEAD.test(line)) { if (cur) { cur.end = i; cur = null; } }
    if (h2) { section = h2[1].trim(); return; }
    const d = line.match(DAY_HEAD);
    if (d) {
      cur = { key: `${d[1] ? "ft" : "d"}${Number(d[2])}`, n: Number(d[2]), fast: !!d[1], head: i, end: lines.length, section, theme: (d[3] ?? "").trim() };
      out.push(cur);
    }
  });
  return out;
}

/** Bullets of one block: [{ line, id, archived }]. */
function bullets(lines, b) {
  const out = [];
  for (let i = b.head + 1; i < b.end; i++) {
    const m = lines[i].match(BULLET);
    if (!m) continue;
    const mk = m[1].match(ITEM_MARKER);
    out.push({ line: i, id: mk?.[1] ?? null, archived: !!mk?.[2] });
  }
  return out;
}

/** Writes every bullet's current id into the file; ids (and so ticks) are unchanged. */
export function materialize(md) {
  const lines = split(md);
  for (const b of blocks(lines)) {
    bullets(lines, b).forEach((bl, index) => {
      if (!bl.id) lines[bl.line] = `${lines[bl.line].replace(/\s+$/, "")} <!-- id:${stableId("days", b.key, index)} -->`;
    });
  }
  return lines.join("\n");
}

/** "3" / 3 -> regular day 3; "ft2" -> fast-track day 2; "d3" -> day 3. */
function findDay(lines, ref) {
  const s = String(ref ?? "").trim().toLowerCase();
  const key = /^\d+$/.test(s) ? `d${Number(s)}` : /^(d|ft)\d+$/.test(s) ? s.replace(/^(d|ft)0*(\d)/, "$1$2") : null;
  const b = key && blocks(lines).find((x) => x.key === key);
  if (!b) fail(`No study day "${ref}". Days are numbers (3) or fast-track days (ft2).`);
  return b;
}

function findItem(lines, id) {
  for (const b of blocks(lines)) {
    const bl = bullets(lines, b).find((x) => x.id === id);
    if (bl) return { b, bl };
  }
  fail(`No study task "${id}". Use get_study_plan for task ids.`);
}

function cleanText(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) fail("Task text is empty.");
  if (t.length > 500) fail("Task text is over 500 characters.");
  if (/<!--|-->/.test(t)) fail("Task text can't contain HTML comments.");
  return t;
}

function cleanType(type) {
  if (type == null || type === "") return null;
  const t = String(type).replace(/\s+/g, " ").trim();
  const cap = t.charAt(0).toUpperCase() + t.slice(1);
  if (!TYPE_RE.test(cap)) fail(`Task type "${type}" should be one to four words, e.g. Coding, Design, Inference.`);
  return cap;
}

function bulletLine({ type, text, star, id, archived }) {
  const body = String(text).replace(/★\s*/g, "").trim();
  return `- ${type ? `${type}: ` : ""}${star ? "★ " : ""}${body} <!-- id:${id}${archived ? " archived" : ""} -->`;
}

/** Index to insert a bullet at 1-based `position` among a day's visible items (default: last). */
function insertAt(lines, b, position) {
  const bl = bullets(lines, b);
  const visible = bl.filter((x) => !x.archived);
  if (position != null) {
    const p = Number(position);
    if (!Number.isInteger(p) || p < 1) fail("position is 1 for the first task of the day.");
    if (p <= visible.length) return visible[p - 1].line;
  }
  return bl.length ? bl.at(-1).line + 1 : b.head + 1;
}

function renumber(lines) {
  let n = 0;
  for (const b of blocks(lines)) {
    if (b.fast) continue;
    n += 1;
    if (b.n !== n) lines[b.head] = `### Day ${n}${b.theme ? `: ${b.theme}` : ""}`;
  }
}

const itemOut = (lines, id) => {
  const days = parseDays(lines.join("\n")).days;
  for (const d of days) {
    const it = [...d.items, ...d.archived].find((i) => i.id === id);
    if (it) return { id: it.id, day: d.fast ? `ft${d.n}` : d.n, type: it.type, text: it.text, star: it.star, archived: !!it.archived, position: d.items.findIndex((i) => i.id === id) + 1 || null };
  }
  return null;
};

/** @param {string} md @param {{ day?: any, type?: any, text?: any, star?: any, position?: any }} [opts] @param {Date} [now] */
export function addTask(md, { day, type, text, star = false, position } = {}, now = new Date()) {
  const lines = split(materialize(md));
  const b = findDay(lines, day);
  const id = stableId("task", now.toISOString(), String(text), Math.random().toString(36));
  const line = bulletLine({ type: cleanType(type), text: cleanText(text), star: !!star, id, archived: false });
  lines.splice(insertAt(lines, b, position), 0, line);
  return { md: lines.join("\n"), task: itemOut(lines, id) };
}

/** @param {string} md @param {string} id @param {{ text?: any, type?: any, star?: any, day?: any, position?: any }} [opts] */
export function updateTask(md, id, { text, type, star, day, position } = {}) {
  const lines = split(materialize(md));
  const { b, bl } = findItem(lines, id);
  const cur = splitItem(lines[bl.line].match(BULLET)[1]);
  const next = {
    id,
    archived: bl.archived,
    type: type === undefined ? cur.type : cleanType(type),
    text: text === undefined ? cur.text : cleanText(text),
    star: star === undefined ? cur.star : !!star,
  };
  const line = bulletLine(next);
  if (day === undefined && position === undefined) {
    lines[bl.line] = line;
  } else {
    lines.splice(bl.line, 1);
    const target = findDay(lines, day === undefined ? (b.fast ? `ft${b.n}` : b.n) : day);
    lines.splice(insertAt(lines, target, position), 0, line);
  }
  return { md: lines.join("\n"), task: itemOut(lines, id) };
}

export function setArchived(md, id, archived) {
  const lines = split(materialize(md));
  const { bl } = findItem(lines, id);
  lines[bl.line] = lines[bl.line].replace(ITEM_MARKER, ` <!-- id:${id}${archived ? " archived" : ""} -->`);
  return { md: lines.join("\n"), task: itemOut(lines, id) };
}

function sectionEnd(lines, title) {
  const want = String(title).trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(H2);
    if (!h) continue;
    if (start >= 0) return i;
    if (h[1].trim().toLowerCase() === want || h[1].trim().toLowerCase().startsWith(want)) start = i;
  }
  if (start < 0) fail(`No section "${title}". Sections: ${lines.filter((l) => H2.test(l)).map((l) => l.replace(/^##\s+/, "")).join("; ")}.`);
  return lines.length;
}

function insertBlock(lines, at, block) {
  const before = at > 0 && lines[at - 1].trim() !== "" ? [""] : [];
  const after = at < lines.length && lines[at].trim() !== "" ? [""] : [];
  lines.splice(at, 0, ...before, ...block, ...after);
}

/** @param {string} md @param {{ after_day?: any, theme?: any, title?: any, section?: any }} [opts] */
export function addDay(md, { after_day, theme, title, section } = {}) {
  const name = String(theme ?? title ?? "").replace(/\s+/g, " ").trim();
  if (!name) fail("A new day needs a theme (its title after \"Day N:\").");
  if (/<!--|-->|\n/.test(name)) fail("The day's theme can't contain HTML comments.");
  const lines = split(materialize(md));
  let at;
  if (after_day != null && after_day !== "") {
    if (String(after_day) === "0") {
      const first = blocks(lines).find((x) => !x.fast);
      if (!first) fail("There is no Day 1 to insert before.");
      at = first.head;
    } else {
      at = findDay(lines, after_day).end;
    }
  } else if (section) {
    at = sectionEnd(lines, section);
  } else {
    fail("Pass after_day (0 = before Day 1) or a section.");
  }
  while (at > 0 && lines[at - 1].trim() === "" && at - 1 > 0 && !ANY_HEAD.test(lines[at - 1])) at -= 1;
  insertBlock(lines, at, ["### Day 0: " + name]);
  renumber(lines);
  const added = blocks(lines).find((x) => !x.fast && x.theme === name && bullets(lines, x).length === 0);
  return { md: lines.join("\n"), day: added ? added.n : null };
}

/** @param {string} md @param {any} day @param {{ theme?: any, title?: any, section?: any }} [opts] */
export function updateDay(md, day, { theme, title, section } = {}) {
  const lines = split(materialize(md));
  const b = findDay(lines, day);
  const name = theme ?? title;
  if (name != null) {
    const t = String(name).replace(/\s+/g, " ").trim();
    if (!t || /<!--|-->/.test(t)) fail("The day's theme can't be empty or contain HTML comments.");
    lines[b.head] = `### ${b.fast ? "Fast-track " : ""}Day ${b.n}: ${t}`;
  }
  let movedTo = null;
  if (section != null && String(section).trim().toLowerCase() !== b.section.toLowerCase()) {
    const cur = findDay(lines, b.fast ? `ft${b.n}` : b.n);
    const block = lines.splice(cur.head, cur.end - cur.head);
    while (block.length && block.at(-1).trim() === "") block.pop();
    insertBlock(lines, sectionEnd(lines, section), block);
    movedTo = section;
  }
  renumber(lines);
  return { md: lines.join("\n"), moved_to: movedTo };
}

const normQ = (q) => String(q ?? "").toLowerCase().replace(/[^a-z0-9#+]+/g, " ").trim();

/** Appends cards in the deck's format ({c, q, one, b}); a card whose front matches one already in the deck is skipped. */
/** @param {string} jsonl @param {any[]} [cards] */
export function addCards(jsonl, cards = []) {
  if (!Array.isArray(cards) || !cards.length) fail("No cards given.");
  const have = new Set();
  for (const line of String(jsonl ?? "").split("\n")) {
    try { const o = JSON.parse(line); if (o?.q) have.add(normQ(o.q)); } catch { /* skip */ }
  }
  const added = [];
  const skipped = [];
  const out = [];
  for (const card of cards) {
    const front = String(card?.front ?? "").trim();
    const back = String(card?.back ?? "").trim();
    if (!front || !back) fail("Every card needs a front and a back.");
    const key = normQ(front);
    if (have.has(key)) { skipped.push(front); continue; }
    have.add(key);
    const parts = back.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    const tags = Array.isArray(card.tags) ? card.tags.map(String).filter(Boolean) : [];
    const c = tags[0] ?? "General";
    out.push(JSON.stringify({ c, q: front, one: parts[0], b: parts.slice(1) }));
    added.push({ id: stableId("card", c, front), front, category: c });
  }
  const base = String(jsonl ?? "");
  const text = out.length ? `${base}${base && !base.endsWith("\n") ? "\n" : ""}${out.join("\n")}\n` : base;
  return { jsonl: text, added, skipped };
}
