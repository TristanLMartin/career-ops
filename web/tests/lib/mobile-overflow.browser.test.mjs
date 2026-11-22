// Mobile layout (hunt): no page scrolls sideways, and no visible element sticks out past
// the viewport, at 375×812 and 390×844 in standalone (home-screen web app) display mode.
// Content that scrolls inside its own container (a wide table in an overflow-x box) is fine;
// only the page itself must not overflow. Read-only: every non-GET API call is blocked.
//
// Set MOBILE_OVERFLOW_TEST_URL (any running server, or the row-clicks fixture). CHROMIUM_PATH
// runs it on a Chromium binary when Google Chrome isn't installed. MOBILE_SHOTS_DIR, when set,
// saves a screenshot of every page there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { liveServerSkip } from "../helpers/live-server.mjs";

const base = process.env.MOBILE_OVERFLOW_TEST_URL;
const shots = process.env.MOBILE_SHOTS_DIR;
export const PAGES = [
  "/", "/pipeline", "/pipeline?tab=ALL", "/pipeline/map", "@report", "/tracker", "/messages", "/followups", "@followup", "/followups?full=1",
  "/study", "/study/plan", "/study/design", "/study/companies", "/study/stories", "/study/cards", "/study/notes", "/explore", "/config", "/cv", "/portals", "/analytics",
  "/scheduled-scans", "/documents", "/jobs",
];
const SIZES = [{ width: 375, height: 812 }, { width: 390, height: 844 }];

test("no horizontal overflow on any page at phone widths (standalone)", { skip: liveServerSkip("MOBILE_OVERFLOW_TEST_URL"), timeout: 900_000 }, async (t) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome", headless: true });
  t.after(() => browser.close());
  const failures = [];
  let checked = 0;
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: size, hasTouch: true, isMobile: true, deviceScaleFactor: shots ? 2 : 1 });
    await ctx.route((u) => !u.href.startsWith(new URL(base).origin), (r) => r.abort());
    await ctx.route((u) => u.pathname.startsWith("/api/"), (r) => (r.request().method() === "GET" ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    try {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] });
    } catch { /* older Chromium: plain mobile emulation still checks the layout */ }
    for (const entry of PAGES) {
      let p = entry;
      if (entry === "@report") {
        await page.goto(new URL("/pipeline?tab=ALL", base).href, { waitUntil: "networkidle" });
        p = await page.evaluate(() => [...document.querySelectorAll('a[href^="/pipeline/"]')].map((a) => a.getAttribute("href")).find((h) => /^\/pipeline\/\d/.test(h ?? "")) ?? null);
        if (!p) continue; // an empty profile has no tracked jobs, so no report to open
      }
      if (entry === "@followup") {
        await page.goto(new URL("/followups", base).href, { waitUntil: "networkidle" });
        p = await page.evaluate(() => document.querySelector('a.row-link[href^="/followups/"]')?.getAttribute("href") ?? null);
        if (!p) continue; // nothing to follow up on in this profile
      }
      const res = await page.goto(new URL(p, base).href, { waitUntil: "networkidle" });
      if (!res || res.status() >= 400) { failures.push(`${size.width} ${p}: HTTP ${res?.status()}`); continue; }
      await page.waitForTimeout(150);
      checked++;
      const found = await page.evaluate(() => {
        const vw = window.innerWidth;
        const out = [];
        const sw = document.scrollingElement.scrollWidth;
        if (sw > vw) out.push(`page scrollWidth ${sw} > ${vw}`);
        // Contained = inside an in-viewport box that SCROLLS sideways (auto/scroll), or inside an
        // intentional ellipsis. overflow:hidden alone is not containment: that is how content gets
        // silently cut off on a phone (the shell's <main> is overflow-x:hidden).
        const contained = (el) => {
          for (let a = el; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (a !== el && /(auto|scroll)/.test(cs.overflowX)) {
              const r = a.getBoundingClientRect();
              if (r.left >= -1 && r.right <= vw + 1) return true;
            }
            if (cs.textOverflow === "ellipsis" && /(hidden|clip)/.test(cs.overflowX)) return true;
          }
          return false;
        };
        for (const el of document.body.querySelectorAll("*")) {
          if (out.length > 12) break;
          if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
          if (el.closest("[inert], [aria-hidden='true'], .sr-only, dialog:not([open])")) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= vw + 1 && r.left >= -1) continue;
          if (contained(el)) continue;
          const name = `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(/\s+/).slice(0, 3).join(".")}`;
          out.push(`${name} spans ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${vw}) "${(el.textContent ?? "").trim().slice(0, 30)}"`);
        }
        return out;
      });
      for (const f of found) failures.push(`${size.width} ${p}: ${f}`);
      if (shots && size.width === 390) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `${p.replace(/^\//, "").replace(/[/?=&]+/g, "-") || "home"}.png`) });
      }
    }
    await ctx.close();
  }
  assert.deepEqual(failures, [], `${failures.length} overflow problem(s) on ${checked} page loads`);
  t.diagnostic(`${checked} page loads checked`);
});
