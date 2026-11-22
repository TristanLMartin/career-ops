/**
 * hunt: the Study page's pure helpers, testable without React.
 * Sources: data/study/study-plan.md (read-only plan) and data/study/cards.jsonl (flashcards).
 *
 * Item ids are a stable hash of the heading path plus the item text, so a revised plan that
 * keeps an item's wording (and its heading) keeps its tick.
 */

/** 64-bit-ish FNV-1a (two 32-bit lanes), base36. Stable across runs and machines. */
export function stableId(...parts) {
  const s = parts.map((p) => String(p ?? "").replace(/\s+/g, " ").trim()).join("␟");
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

const strip = (s) => String(s ?? "").replace(/\*\*/g, "").trim();

// ── markdown → blocks (headings, paragraphs, lists, tables, quotes) ───────────

/** Split a "| a | b |" row into trimmed cells. */
export function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Parse the plan into a tree: [{level, title, path, blocks: [...], children: [...]}].
 * Blocks: {type:"p", text} · {type:"ul"|"ol", items:[text]} · {type:"table", head:[..], rows:[[..]]} · {type:"quote", text}.
 * The plan's tables have no |---| separator row: the first row is the header (a separator row is skipped if present).
 */
export function parsePlan(md) {
  const root = { level: 0, title: "", path: [], blocks: [], children: [] };
  const stack = [root];
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const cur = () => stack[stack.length - 1];
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      while (stack.length > 1 && cur().level >= level) stack.pop();
      const node = { level, title: h[2].trim(), path: [...cur().path, h[2].trim()], blocks: [], children: [] };
      cur().children.push(node);
      stack.push(node);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = tableCells(lines[i]);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      cur().blocks.push({ type: "table", head: rows[0] ?? [], rows: rows.slice(1) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      cur().blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      cur().blocks.push({ type: "ol", items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const parts = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { parts.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      cur().blocks.push({ type: "quote", text: parts.join(" ") });
      continue;
    }
    if (line.trim()) cur().blocks.push({ type: "p", text: line.trim() });
    i++;
  }
  return root.children;
}

function findSection(tree, re) {
  for (const n of tree) {
    if (re.test(n.title)) return n;
    const f = findSection(n.children, re);
    if (f) return f;
  }
  return null;
}

/** Bullets under a section, keeping the bold label paragraph that precedes each list ("**Ask the recruiter**"). */
function bulletsWithLabels(node) {
  const out = [];
  let label = "";
  for (const b of node.blocks) {
    if (b.type === "p" && /^\*\*[^*]+\*\*$/.test(b.text)) label = strip(b.text);
    if (b.type === "ul") for (const it of b.items) out.push({ label, text: it });
  }
  return out;
}

/**
 * Tickable checklist groups from the plan:
 *  - Part 3: one item per row of the 12-day table, with Coding / Design / Stories as sub-checks
 *  - Part 4: one item per LeetCode problem (with its number; ★ kept), grouped by day
 *  - Part 6: each bullet
 *  - Part 7: each week row and each gap drill
 * Returns [{id, title, items: [{id, text, note?, star?, subs?: [{id, label, text}]}]}].
 */
export function buildChecklist(md) {
  const tree = parsePlan(md);
  const groups = [];

  const p3 = findSection(tree, /^Part 3\b/);
  if (p3) {
    const t = p3.blocks.find((b) => b.type === "table");
    if (t) {
      const head = t.head.map(strip);
      const items = t.rows.filter((r) => r.length >= 4).map((r) => {
        const text = `Day ${strip(r[0])}`;
        const base = [...p3.path, text];
        const subs = [1, 2, 3].map((c) => ({ id: stableId(...base, head[c], r[c]), label: head[c].replace(/\s*\(.*\)$/, ""), text: strip(r[c]) }));
        return { id: stableId(...base), text, subs };
      });
      groups.push({ id: stableId(...p3.path), title: "12-day plan", items });
    }
  }

  const p4 = findSection(tree, /^Part 4\b/);
  const list = p4 && findSection(p4.children, /^Problem list/);
  if (list) {
    const t = list.blocks.find((b) => b.type === "table");
    const items = [];
    for (const r of t?.rows ?? []) {
      if (r.length < 3) continue;
      const day = `Day ${strip(r[0])} · ${strip(r[1])}`;
      for (const raw of r[2].split(/\s+·\s+/)) {
        const text = raw.trim();
        if (!text) continue;
        const star = text.startsWith("★");
        items.push({ id: stableId(...list.path, day, text), text: text.replace(/^★\s*/, ""), star, note: day, number: text.match(/\((\d{1,4})\b/)?.[1] ?? null });
      }
    }
    groups.push({ id: stableId(...list.path), title: "LeetCode problems", items });
  }

  const p6 = findSection(tree, /^Part 6\b/);
  if (p6) {
    const items = bulletsWithLabels(p6).map((b) => ({ id: stableId(...p6.path, b.label, b.text), text: strip(b.text), note: b.label }));
    groups.push({ id: stableId(...p6.path), title: "Before the loop", items });
  }

  const p7 = findSection(tree, /^Part 7\b/);
  if (p7) {
    const weeks = findSection(p7.children, /^Weeks after/);
    const drills = findSection(p7.children, /^Gap drills/);
    const items = [];
    const t = weeks?.blocks.find((b) => b.type === "table");
    for (const r of t?.rows ?? []) {
      if (r.length < 3) continue;
      const text = `Week ${strip(r[0])}: ${strip(r[1])}`;
      items.push({ id: stableId(...weeks.path, text), text, note: strip(r[2]) });
    }
    for (const b of drills ? bulletsWithLabels(drills) : []) {
      const m = b.text.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
      items.push({ id: stableId(...drills.path, b.text), text: m ? strip(m[1]) : strip(b.text), note: m ? strip(m[2]).replace(/^[:\-–\s]+/, "") : undefined });
    }
    groups.push({ id: stableId(...p7.path), title: "Beyond Microsoft", items });
  }
  return groups;
}

/** Ticked when the item is ticked, or every sub-check is. */
export function isDone(item, ticks) {
  if (ticks?.[item.id]) return true;
  return Array.isArray(item.subs) && item.subs.length > 0 && item.subs.every((s) => ticks?.[s.id]);
}

/** The first unticked 12-day item, or null. */
export function nextUp(groups, ticks) {
  const plan = groups.find((g) => g.title === "12-day plan");
  return plan?.items.find((it) => !isDone(it, ticks)) ?? null;
}

// ── flashcards ─────────────────────────────────────────────────────────────

/** cards.jsonl -> [{id, c, q, one, b}]; bad lines are skipped. */
export function parseCards(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o.q !== "string" || typeof o.one !== "string") continue;
    out.push({ id: stableId("card", o.c ?? "", o.q), c: String(o.c ?? "Other"), q: o.q, one: o.one, b: Array.isArray(o.b) ? o.b.map(String) : [] });
  }
  return out;
}

// Split after . ! ? (optionally closed by a quote) when the next word starts with a capital.
const sentences = (s) => String(s).split(/(?<=[.!?]["\u201d]?)\s+(?=["\u201c]?[A-Z])/).map((x) => x.trim()).filter(Boolean);

/** "Lessons" cards from the study plan's Part 7 "Lessons from ..." bullets (e.g. after a real screen). */
export function beyondCards(md) {
  const tree = parsePlan(md);
  const p7 = findSection(tree, /^Part 7\b/);
  const lessons = p7 && findSection(p7.children, /^Lessons from/);
  if (!lessons) return [];
  const out = [];
  for (const b of lessons.blocks.filter((x) => x.type === "ul").flatMap((x) => x.items)) {
    const m = b.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
    if (!m) continue;
    const q = m[1].replace(/[:.]\s*$/, "");
    const rest = m[2].trim();
    let parts = /\(1\)/.test(rest) ? rest.split(/\s*\(\d\)\s*/).filter(Boolean).map((x) => x.replace(/,\s*$/, "").trim()) : sentences(rest);
    if (!parts.length) continue;
    const one = parts.length > 1 && /\(1\)/.test(rest) ? `${parts.length} layers` : parts[0];
    const bullets = /\(1\)/.test(rest) ? parts.map((p, i) => `${i + 1}. ${p.replace(/^[a-z]/, (c) => c.toUpperCase())}`) : parts.slice(1);
    out.push({ id: stableId("card", "Lessons", q), c: "Lessons", q, one: one.replace(/^[a-z]/, (c) => c.toUpperCase()), b: bullets });
  }
  return out;
}

// Suggested categories for data/study/cards.jsonl ("c" field). The page shows whatever categories
// the cards actually use, in this order first.
export const CARD_CATEGORIES = Object.freeze(["Opening", "Experience", "Behavioral", "Design", "Close", "Lessons"]);

// ── state ──────────────────────────────────────────────────────────────────

/** Normalize a state document: {ticks:{id:true}, flags:{id:true}, reviewed:{id:true}, updatedAt}. */
export function normalizeState(doc) {
  const pick = (o) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k, v]) => /^[a-z0-9]{2,40}$/.test(k) && v === true));
  return {
    ticks: pick(doc?.ticks), flags: pick(doc?.flags), reviewed: pick(doc?.reviewed),
    // hunt: study days (data/study/days.md): when Day 1 started (unset until he presses Start) and the fast-track switch
    startDate: typeof doc?.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(doc.startDate) ? doc.startDate : null,
    fastTrack: doc?.fastTrack === true,
    updatedAt: typeof doc?.updatedAt === "string" ? doc.updatedAt : null,
  };
}

/** Apply {op:"tick"|"flag", id, value} to a state; returns a new state or null for a bad op. */
export function applyOp(state, op, now = new Date()) {
  const s = normalizeState(state);
  // {op:"start", value:"YYYY-MM-DD"|null} sets or clears the start date; {op:"fast", value:bool} the fast-track switch
  if (op?.op === "start") {
    if (op.value !== null && !(typeof op.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(op.value))) return null;
    return { ...s, startDate: op.value, updatedAt: now.toISOString() };
  }
  if (op?.op === "fast") return { ...s, fastTrack: op.value === true, updatedAt: now.toISOString() };
  if (!op || !["tick", "flag", "review"].includes(op.op) || typeof op.id !== "string" || !/^[a-z0-9]{2,40}$/.test(op.id)) return null;
  const key = op.op === "tick" ? "ticks" : op.op === "flag" ? "flags" : "reviewed"; // review: a card answered "Got it" in Quick review
  const next = { ...s[key] };
  if (op.value) next[op.id] = true; else delete next[op.id];
  return { ...s, [key]: next, updatedAt: now.toISOString() };
}

// ── Plan digest: summaries, lead-ins, search ───────────────────────────────

const plain = (s) => String(s ?? "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
const firstSentence = (s) => sentences(plain(s))[0] ?? plain(s);
function clip(s, n = 120) {
  const t = plain(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).replace(/[,;:\s]+$/, "")}…`;
}

/** One line for a collapsed section: its first sentence, a table's columns, or its sub-section titles. */
export function sectionSummary(section) {
  for (const b of section?.blocks ?? []) {
    if (b.type === "p" || b.type === "quote") {
      if (/^\*\*[^*]+\*\*:?$/.test(b.text.trim())) continue; // a bold label, not content
      return clip(firstSentence(b.text));
    }
    if ((b.type === "ul" || b.type === "ol") && b.items.length) {
      const lead = splitLeadIn(b.items[0]);
      return clip(lead.lead ? `${lead.lead} ${firstSentence(lead.rest)}` : firstSentence(b.items[0]));
    }
    if (b.type === "table") return clip(`${b.rows.length} rows: ${b.head.map(plain).join(", ")}`);
  }
  const kids = (section?.children ?? []).map((c) => c.title);
  return kids.length ? clip(kids.join(" · ")) : "";
}

/** "**Lead.** rest" → {lead: "Lead.", rest}; no bold lead-in → {lead: "", rest: text}. */
export function splitLeadIn(text) {
  const m = String(text ?? "").match(/^\*\*([^*]+)\*\*\s*([\s\S]*)$/);
  return m ? { lead: m[1].trim(), rest: m[2].trim() } : { lead: "", rest: String(text ?? "") };
}

/** A bullet worth folding: a bold lead-in followed by a long body. */
export function isFoldable(text, min = 120) {
  const { lead, rest } = splitLeadIn(text);
  return !!lead && rest.length > 0 && plain(text).length > min;
}

/** Blocks of a section that mention every query word, with list items narrowed to the matching ones. */
function matchBlocks(blocks, words) {
  const hit = (s) => { const t = plain(s).toLowerCase(); return words.every((w) => t.includes(w)); };
  const out = [];
  for (const b of blocks) {
    if (b.type === "p" || b.type === "quote") { if (hit(b.text)) out.push(b); }
    else if (b.type === "ul" || b.type === "ol") { const items = b.items.filter(hit); if (items.length) out.push({ ...b, items }); }
    else if (b.type === "table") { const rows = b.rows.filter((r) => hit(r.join(" "))); if (rows.length) out.push({ ...b, rows }); }
  }
  return out;
}

/**
 * Search the plan: [{path, title, blocks}] for every section whose title or content matches all
 * query words (case-insensitive). A title match keeps the whole section's own blocks.
 */
export function searchPlan(plan, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  const walk = (n) => {
    const titleHit = words.every((w) => n.title.toLowerCase().includes(w));
    const blocks = titleHit ? n.blocks : matchBlocks(n.blocks, words);
    if (titleHit || blocks.length) out.push({ path: n.path, title: n.title, blocks });
    n.children.forEach(walk);
  };
  (plan ?? []).forEach(walk);
  return out;
}

/** Cards whose question, one-liner or bullets match all query words. */
export function searchCards(cards, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (cards ?? []).filter((c) => { const t = [c.c, c.q, c.one, ...(c.b ?? [])].join(" ").toLowerCase(); return words.every((w) => t.includes(w)); });
}

// ── Quick review queue ─────────────────────────────────────────────────────

/** Flagged cards first (in deck order), then the rest. Returns ids. */
export function reviewQueue(cards, flags) {
  const f = (cards ?? []).filter((c) => flags?.[c.id]);
  const r = (cards ?? []).filter((c) => !flags?.[c.id]);
  return [...f, ...r].map((c) => c.id);
}

/** "Got it" drops the head; "Again" moves it back `gap` places (or to the end). */
export function answerQueue(queue, again, gap = 4) {
  if (!queue.length) return queue;
  const [head, ...rest] = queue;
  if (!again) return rest;
  const at = Math.min(gap, rest.length);
  return [...rest.slice(0, at), head, ...rest.slice(at)];
}
