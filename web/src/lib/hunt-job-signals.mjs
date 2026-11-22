/**
 * hunt: per-job signals layered over data/hunt-enrich.json when the web reads it, so a
 * change takes effect on the next page load without re-running scripts/hunt-enrich.mjs.
 *
 *   data/hunt-ratings.json   {"ratings": {url: {rating: 1-5, note?, at}}}   the user's own rating
 *   data/hunt-liveness.json  {"checks": {url: {verdict: "active"|"expired"|"uncertain", at}}}
 *   postedAt (enrich row)       the board's posting date -> postedDays
 *
 * Pure: no fs. The caller reads the files (see readHuntEnrichment in hunt-data.ts).
 */

/** Postings older than this get the "Posted Nmo ago" chip and are demoted in Best overall. */
export const STALE_DAYS = 60;

const DAY = 86_400_000;

/** {url: {rating, note}} from the ratings doc; bad entries dropped. */
export function normalizeRatings(doc) {
  const out = {};
  for (const [url, v] of Object.entries(doc?.ratings ?? {})) {
    const r = Math.round(Number(v?.rating));
    // source: "manual" = set on the job page; anything else (written from chat comments, or unknown) is "inferred".
    if (r >= 1 && r <= 5) out[url] = { rating: r, note: typeof v.note === "string" && v.note.trim() ? v.note.trim().slice(0, 200) : undefined, at: v.at, source: v.source === "manual" ? "manual" : "inferred" };
  }
  return out;
}

/**
 * Mutates and returns `jobs`: sets my_rating / my_rating_note (on the rated URL and the rest of
 * its duplicate group), postedDays, and closed (the posting URL answered expired).
 */
export function applySignals(jobs, { ratings = {}, liveness = {}, now = Date.now() } = {}) {
  if (!jobs || typeof jobs !== "object") return jobs;
  const rated = normalizeRatings({ ratings });
  const byGroup = new Map();
  for (const [url, e] of Object.entries(jobs)) if (e?.group) (byGroup.get(e.group) ?? byGroup.set(e.group, []).get(e.group)).push(url);
  for (const [url, r] of Object.entries(rated)) {
    const e = jobs[url];
    if (!e) continue;
    // An inferred rating (from a chat comment, not set by the user on the job page) is only a note:
    // it never moves Best overall, which would make the order circular.
    if (r.source !== "manual") {
      e.my_rating_said = `You said: ${r.rating >= 4 ? "looked good" : r.rating <= 2 ? "meh" : "not sure"}${r.note && !/^(good|meh)\b/i.test(r.note) ? ` (${r.note})` : ""}`;
      continue;
    }
    for (const u of e.group ? byGroup.get(e.group) ?? [url] : [url]) {
      // A URL rated in its own right keeps its own rating; a member with its own 4.0+ evaluation
      // is ranked as its own job (standsAlone in hunt-rank-order.mjs), so it is not rated by proxy.
      if (u !== url && (rated[u] || (typeof jobs[u].fit === "number" && jobs[u].fit >= 4.0 && jobs[u].fitVia !== "group"))) continue;
      jobs[u].my_rating = r.rating;
      jobs[u].my_rating_note = r.note;
    }
  }
  for (const [url, e] of Object.entries(jobs)) {
    if (!e) continue;
    if (e.postedAt) {
      const t = Date.parse(`${e.postedAt}T00:00:00Z`);
      if (Number.isFinite(t)) e.postedDays = Math.max(0, Math.floor((now - t) / DAY));
    }
    const live = liveness?.[url];
    if (live?.verdict === "expired") e.closed = true;
    else if (live?.verdict === "active" && live.at) e.liveAt = live.at;
  }
  return jobs;
}

/** "Posted 29mo ago" for a posting older than STALE_DAYS, else null. */
export function staleChip(e) {
  const d = e?.postedDays;
  if (!(Number.isFinite(d) && d > STALE_DAYS)) return null;
  const live = e.liveAt ? ` Still open: the posting answered live on ${e.liveAt}.` : " Not liveness-checked yet: confirm it is open before applying.";
  return { label: `Posted ${Math.floor(d / 30)}mo ago`, title: `Posted on ${e.postedAt}, ${d} days ago. Age alone does not lower its rank; only a closed posting leaves Best overall.${live}` };
}

/** Best overall places lost for a meh rating (3, 2, 1); good ratings (4, 5) lift instead. */
export function ratingPenalty(r) {
  return { 3: 15, 2: 35, 1: 200 }[r] ?? 0;
}

/**
 * The ratings doc normalized to what this code writes: {ratings: {url: {rating, note?, at}}}.
 * @returns {{ ratings: Record<string, { rating: number, note?: string, at?: string, source?: string }> }}
 */
export function normalizeRatingsDoc(raw) {
  /** @type {Record<string, { rating: number, note?: string, at?: string, source?: string }>} */
  const ratings = {};
  for (const [url, v] of Object.entries(normalizeRatings(raw))) ratings[url] = { rating: v.rating, ...(v.note ? { note: v.note } : {}), ...(v.at ? { at: v.at } : {}), source: v.source };
  return { ratings };
}

/**
 * One rating change. rating 1-5 sets it (note optional), rating null clears it. Returns the next
 * doc, or null for a bad op (unknown URL shape, out-of-range rating).
 * @param {{ ratings?: Record<string, any> } | null | undefined} prev
 * @param {{ url?: unknown, rating?: unknown, note?: string, at?: string }} op
 * @returns {{ ratings: Record<string, { rating: number, note?: string, at: string, source?: string }> } | null}
 */
export function applyRatingOp(prev, { url, rating, note, at = new Date().toISOString().slice(0, 10) } = {}) {
  if (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url) || url.length > 2000) return null;
  const ratings = { ...(prev?.ratings ?? {}) };
  if (rating === null) { delete ratings[url]; return { ratings }; }
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return null;
  const n = typeof note === "string" ? note.trim().slice(0, 200) : ratings[url]?.note;
  ratings[url] = { rating: r, ...(n ? { note: n } : {}), at, source: "manual" };
  return { ratings };
}
