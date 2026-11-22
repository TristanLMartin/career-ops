import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveProfile, ToolError } from "../src/config.mjs";

const cfgFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture", "profiles.json");

test("config resolves relative data dirs against the config file", () => {
  const c = loadConfig(cfgFile);
  assert.equal(c.defaultProfile, "me");
  assert.ok(path.isAbsolute(c.profiles.me.dataDir));
  assert.ok(c.profiles.me.dataDir.endsWith(path.join("fixture", "root")));
  assert.equal(c.profiles.me.host, "127.0.0.1");
});

test("no profile means the default", () => {
  const c = loadConfig(cfgFile);
  assert.equal(resolveProfile(c, undefined).id, "me");
  assert.equal(resolveProfile(c, "").id, "me");
  assert.equal(resolveProfile(c, "me").id, "me");
});

test("unknown, disabled and dataless profiles give clear errors", () => {
  const c = loadConfig(cfgFile);
  assert.throws(() => resolveProfile(c, "bob"), (e) => e instanceof ToolError && /Unknown profile "bob".*me, partner/.test(e.message));
  assert.throws(() => resolveProfile(c, "off"), (e) => e instanceof ToolError && /turned off/.test(e.message));
  assert.throws(() => resolveProfile(c, "partner"), (e) => e instanceof ToolError && /inactive/.test(e.message));
});

test("without a profiles.json, profiles come from CAREER_OPS_MCP_PROFILES", async () => {
  const { configFromEnv } = await import("../src/config.mjs");
  const c = configFromEnv({ CAREER_OPS_CODE_ROOT: "/srv/career-ops", CAREER_OPS_MCP_PROFILES: "sam=.@http://127.0.0.1:3000, alex=profiles/alex@https://dash.example.test/" });
  assert.equal(c.defaultProfile, "sam");
  assert.equal(c.profiles.sam.dataDir, "/srv/career-ops");
  assert.equal(c.profiles.sam.profileDir, null);
  assert.equal(c.profiles.sam.url, "http://127.0.0.1:3000");
  assert.equal(c.profiles.alex.dataDir, path.join("/srv/career-ops", "profiles", "alex"));
  assert.equal(c.profiles.alex.profileDir, "profiles/alex");
  assert.equal(c.profiles.alex.url, "https://dash.example.test");
  assert.equal(configFromEnv({ CAREER_OPS_WEB_PORT: "4100" }).profiles.me.url, "http://127.0.0.1:4100");
  assert.throws(() => configFromEnv({ CAREER_OPS_MCP_PROFILES: "bad entry" }), /can't read/);
});

test("profiles.json entries with host/port get a dashboard url", () => {
  const c = loadConfig(cfgFile);
  assert.equal(c.profiles.me.url, "http://127.0.0.1:1");
});

test("setup adds a token once, keeps it, and rotates on request", async () => {
  const { withToken } = await import("../scripts/setup.mjs");
  const a = withToken("CAREER_OPS_MCP_TOKEN=\nCAREER_OPS_MCP_PORT=8765\n", { token: "t".repeat(43) });
  assert.equal(a.changed, true);
  assert.match(a.text, /^CAREER_OPS_MCP_TOKEN=t{43}\nCAREER_OPS_MCP_PORT=8765\n$/);
  assert.equal(withToken(a.text).changed, false, "an existing token is kept");
  assert.notEqual(withToken(a.text, { rotate: true }).text, a.text);
  assert.match(withToken("X=1\n", { token: "u".repeat(30) }).text, /^CAREER_OPS_MCP_TOKEN=u{30}\nX=1\n$/);
});
