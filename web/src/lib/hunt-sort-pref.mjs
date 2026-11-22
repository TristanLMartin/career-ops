/**
 * The inbox sort choice. Same contract as
 * inbox-sort-pref.mjs, plus the "rank" mode, which is the default. Kept in its
 * own key so the upstream "fit"/"newest" preference stays untouched.
 */
export const HUNT_SORT_STORAGE_KEY = "hunt:inbox-sort";
// rank = Best overall (the # everywhere), fit = Best fit, pay = Highest pay, newest = first seen.
export const HUNT_SORT_MODES = Object.freeze(["rank", "fit", "pay", "newest"]);
export const DEFAULT_HUNT_SORT = "rank";
export const HUNT_RANK_KEY_STORAGE = "hunt:inbox-rank-key";
export const HUNT_RANK_KEYS = Object.freeze(["true", "composite", "fit", "level", "relevance", "pay", "location", "benefits"]);

/** @returns {"rank" | "fit" | "pay" | "newest"} */
export function parseHuntSort(value) {
  return HUNT_SORT_MODES.includes(/** @type {string} */ (value)) ? /** @type {any} */ (value) : DEFAULT_HUNT_SORT;
}

export function readHuntSort(storage) {
  try {
    return parseHuntSort(storage?.getItem(HUNT_SORT_STORAGE_KEY));
  } catch {
    return DEFAULT_HUNT_SORT;
  }
}

export function writeHuntSort(storage, mode) {
  if (!storage || !HUNT_SORT_MODES.includes(mode)) return false;
  try {
    storage.setItem(HUNT_SORT_STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function readRankKey(storage) {
  try {
    const v = storage?.getItem(HUNT_RANK_KEY_STORAGE);
    return HUNT_RANK_KEYS.includes(v) ? v : "true";
  } catch {
    return "true";
  }
}

export function writeRankKey(storage, key) {
  if (!storage || !HUNT_RANK_KEYS.includes(key)) return;
  try { storage.setItem(HUNT_RANK_KEY_STORAGE, key); } catch { /* ignore */ }
}

/**
 * Stable sort by a rank value, highest first; rows with no value keep their
 * incoming (fit) order after the ranked ones.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => number | null | undefined} value
 * @returns {T[]}
 */
export function orderByRank(rows, value) {
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const ar = a.v != null && Number.isFinite(a.v);
      const br = b.v != null && Number.isFinite(b.v);
      if (ar !== br) return ar ? -1 : 1;
      if (ar && br && a.v !== b.v) return /** @type {number} */ (b.v) - /** @type {number} */ (a.v);
      return a.index - b.index;
    })
    .map((x) => x.row);
}
