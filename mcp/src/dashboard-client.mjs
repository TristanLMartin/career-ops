// Writes go through the running dashboard's own HTTP endpoints (loopback), so the dashboard's
// locks, validation and atomic writes apply and this server never races it.
import { ToolError } from "./config.mjs";

const base = (profile) => profile.url ?? `http://${profile.host}:${profile.port}`;

export async function dashboardPost(profile, route, body, { timeoutMs = 30_000 } = {}) {
  const url = `${base(profile)}${route}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? "timed out" : "is not answering";
    throw new ToolError(`The ${profile.id} dashboard (${base(profile)}) ${why}; nothing was changed${why === "timed out" ? " as far as this server knows (check before retrying)" : ""}.`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json };
}

/** GET a read-only dashboard JSON route. Any failure is a ToolError naming the route; there is no fallback. */
export async function dashboardGetJson(profile, route, { timeoutMs = 20_000 } = {}) {
  const url = `${base(profile)}${route}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err?.name === "TimeoutError" ? "timed out" : "is not answering";
    throw new ToolError(`The ${profile.id} dashboard (${base(profile)}) ${why} (GET ${route}).`);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !json) throw new ToolError(`The ${profile.id} dashboard's ${route} failed: ${json?.error ?? `HTTP ${res.status}${json ? "" : ", not JSON"}`}.`);
  return json;
}
