// Display helpers for tool text: tracker rows read "ID N" (never "#N"), and times are told in
// the user's time zone (CAREER_OPS_TZ, an IANA name such as "America/Chicago"; default the
// system zone) with its short name ("Sun, Nov 22, 9:15 AM PST").

function fmt(tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

/** "2026-11-22T17:15:12Z" -> "Sun, Nov 22, 12:15 PM EST" (in CAREER_OPS_TZ). Non-timestamps pass through unchanged. */
export function localWhen(value, tz = process.env.CAREER_OPS_TZ) {
  if (value == null || value === "") return value;
  const s = String(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s;
  return fmt(tz).format(t).replace(/ /g, " ");
}

/** Tracker number as shown everywhere: "ID 54". */
export const trackerLabel = (n) => `ID ${n}`;

/** Accepts "54", "#54", "ID 54", "id:54", "tracker:54"; returns "54" or null. */
export function parseTrackerRef(ref) {
  const m = /^(?:#|id[\s:#]*|tracker:)?\s*(\d+)$/i.exec(String(ref ?? "").trim());
  return m ? m[1] : null;
}
