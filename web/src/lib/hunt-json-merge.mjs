/**
 * hunt: read-modify-write for small JSON state files (data/message-marks.json,
 * data/study-state.json) that keeps what this code doesn't know about.
 *
 * The routes normalize a file to the keys they understand, apply an op, and used to write
 * that normalized object back, which dropped any top-level key or per-item field another
 * writer (a script, the MCP server, a newer build) had added. mergeKnown() lays the new
 * known state over the raw document instead:
 *  - unknown top-level keys are kept as they were;
 *  - for each map key in `maps`, an item present in `next` is merged over the raw item
 *    (so unknown per-item fields survive), an item the normalizer understood but `next`
 *    dropped is deleted, and an item the normalizer couldn't read is kept untouched.
 */
import fs from "node:fs";
import path from "node:path";

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The file's JSON object, or {} when it is missing, unreadable or not an object. */
export function readRawObject(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

function mergeMap(raw, prev, next) {
  const r = isObj(raw) ? raw : {};
  const p = isObj(prev) ? prev : {};
  const n = isObj(next) ? next : {};
  const out = {};
  for (const [id, v] of Object.entries(r)) {
    if (Object.hasOwn(n, id)) out[id] = isObj(v) && isObj(n[id]) ? { ...v, ...n[id] } : n[id];
    else if (!Object.hasOwn(p, id)) out[id] = v; // not understood by the normalizer: leave it alone
    // else: understood and removed by the op → deleted
  }
  for (const [id, v] of Object.entries(n)) if (!Object.hasOwn(out, id)) out[id] = v;
  return out;
}

/**
 * raw: the document as read from disk; prev: its normalized form; next: the normalized form
 * after the op. Returns the document to write.
 */
export function mergeKnown(raw, prev, next, maps = []) {
  const base = isObj(raw) ? raw : {};
  const out = { ...base, ...next };
  for (const k of maps) out[k] = mergeMap(base[k], prev?.[k], next?.[k]);
  return out;
}

/** Write JSON atomically: a temp file in the same directory, then rename over the target. */
export function writeJsonAtomic(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Read raw, normalize, apply, merge over the raw document, write atomically. `maps` names the
 * per-item maps (e.g. ["marks", "kindOverrides"]). Returns the normalized next state, or null
 * (nothing written) when apply() rejects the op.
 * @template T
 * @param {string} file
 * @param {(raw: any) => T} normalize
 * @param {(prev: T) => T | null} apply
 * @param {string[]} [maps]
 * @returns {T | null}
 */
export function updateJsonFile(file, normalize, apply, maps = []) {
  const raw = readRawObject(file);
  const prev = normalize(raw);
  const next = apply(prev);
  if (!next) return null;
  writeJsonAtomic(file, mergeKnown(raw, prev, next, maps));
  return next;
}

export const MARKS_MAPS = Object.freeze(["marks", "kindOverrides"]);
export const STUDY_MAPS = Object.freeze(["ticks", "flags", "reviewed"]);
