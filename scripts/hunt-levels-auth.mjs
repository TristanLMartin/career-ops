#!/usr/bin/env node
// One-time Levels.fyi sign-in for scripts/hunt-levels-refresh.mjs.
// Standard MCP OAuth: dynamic client registration + PKCE. The person signs in in their own
// browser; this machine only ever receives a token (never a password).
//
// 1. node scripts/hunt-levels-auth.mjs   (prints a link, waits up to 15 minutes)
// 2. Open the link in a browser, sign in, Allow. The sign-in redirects to localhost:8976, so if
//    career-ops runs on another machine, forward that port first from the machine with the
//    browser: ssh -L 8976:localhost:8976 <server>
// The token is saved to data/cache/levels-oauth.json (mode 600, gitignored); the refresh script
// sends it and renews it with the refresh token.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { getCareerOpsRoot } from "../path-resolver.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

export const ISSUER = "https://mcp.levels.fyi/";
const PORT = 8976;
const REDIRECT = `http://localhost:${PORT}/callback`;
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const tokenFile = (root = getCareerOpsRoot()) => path.join(root, "data", "cache", "levels-oauth.json");

export function saveToken(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

async function metadata() {
  const r = await fetch(new URL("/.well-known/oauth-authorization-server", ISSUER), { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`metadata HTTP ${r.status}`);
  return r.json();
}

/** Exchanges a code or a refresh token at the token endpoint. */
export async function tokenRequest(meta, params) {
  const r = await fetch(meta.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`token HTTP ${r.status}: ${text.slice(0, 200)}`);
  const t = JSON.parse(text);
  return { access_token: t.access_token, refresh_token: t.refresh_token ?? params.refresh_token ?? null, expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null, token_type: t.token_type ?? "Bearer" };
}

/** Renews the saved token with its refresh token; returns the new doc. */
export async function refreshToken(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!doc.refresh_token) throw new Error("no refresh token; run scripts/hunt-levels-auth.mjs again");
  const meta = await metadata();
  const t = await tokenRequest(meta, { grant_type: "refresh_token", refresh_token: doc.refresh_token, client_id: doc.client_id, resource: ISSUER });
  const next = { ...doc, ...t, refreshed_at: new Date().toISOString() };
  saveToken(file, next);
  return next;
}

async function main() {
  const file = tokenFile();
  const meta = await metadata();
  const reg = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ client_name: "career-ops", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp" }) });
  if (!reg.ok) throw new Error(`registration HTTP ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
  const client = await reg.json();
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "mcp", state, resource: ISSUER })) url.searchParams.set(k, v);
  console.log(`\nOpen this link in a browser (on another machine, run ssh -L ${PORT}:localhost:${PORT} <this host> first):\n\n${url}\n\nWaiting up to 15 minutes...`);

  const done = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { server.close(); reject(new Error("timed out after 15 minutes")); }, 15 * 60 * 1000);
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const finish = (code, msg) => { res.writeHead(code, { "content-type": "text/plain" }).end(msg); };
      if (u.searchParams.get("state") !== state) return finish(400, "State mismatch; run the script again.");
      if (u.searchParams.get("error")) { finish(400, `Levels.fyi said: ${u.searchParams.get("error")}`); clearTimeout(timer); server.close(); return reject(new Error(u.searchParams.get("error"))); }
      try {
        const t = await tokenRequest(meta, { grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier, resource: ISSUER });
        saveToken(file, { client_id: client.client_id, ...t, signed_in_at: new Date().toISOString() });
        finish(200, "Signed in. You can close this tab.");
        clearTimeout(timer); server.close(); resolve(true);
      } catch (e) { finish(500, "Token exchange failed; see the terminal."); clearTimeout(timer); server.close(); reject(e); }
    });
    server.listen(PORT, "127.0.0.1");
  });
  if (done) console.log(`Signed in. Token saved to ${file} (mode 600).`);
}

if (isMainModule(import.meta.url)) main().catch((e) => { console.error(`levels auth failed: ${e.message}`); process.exit(1); });
