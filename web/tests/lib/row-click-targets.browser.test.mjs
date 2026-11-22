// Whole-row click targets (hunt): a click or tap anywhere on a row that isn't one of its own
// buttons must land on THAT row's own link (.row-link), at desktop and at phone size, for every
// row on every page — never on another row's overlay, never on a page section.
// The click is intercepted in the capture phase, so nothing navigates or changes.
//
// Generate a root with node tests/fixtures/row-clicks.mjs, serve it, and set ROW_CLICK_TEST_URL.
// Any running server works too (e.g. the real dashboard), since nothing is written.
// CHROMIUM_PATH runs it on a Chromium binary when Google Chrome isn't installed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { liveServerSkip } from "../helpers/live-server.mjs";

const base = process.env.ROW_CLICK_TEST_URL;
const PAGES = [
  { path: "/", min: 1 },
  { path: "/pipeline", min: 1 },
  { path: "/pipeline?tab=ALL", min: 1 },
  { path: "/tracker", min: 1 },
  { path: "/explore", min: 0 },
  { path: "/messages", min: 0 },
  { path: "/followups", min: 0 },
];
const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 900 }, touch: false },
  { name: "phone", viewport: { width: 390, height: 844 }, touch: true },
];

const CONTROL = "input, select, textarea, summary, .row-above, .tap-44, button:not(.row-link), a:not(.row-link)";

test("every row's click lands on its own link, desktop and phone", { skip: liveServerSkip("ROW_CLICK_TEST_URL"), timeout: 600_000 }, async (t) => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chrome", headless: true });
  t.after(() => browser.close());
  const failures = [];
  let checked = 0;
  for (const size of SIZES) {
    const ctx = await browser.newContext({ viewport: size.viewport, hasTouch: size.touch, isMobile: size.touch });
    // Never leave the page: external postings and LinkedIn are not fetched.
    await ctx.route((u) => !u.href.startsWith(new URL(base).origin), (r) => r.abort());
    // Read-only by construction: no POST (marks, status, study ticks) can reach the server.
    await ctx.route((u) => u.pathname.startsWith("/api/"), (r) => (r.request().method() === "GET" ? r.continue() : r.abort()));
    const page = await ctx.newPage();
    for (const { path, min } of PAGES) {
      await page.goto(new URL(path, base).href, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        window.__hits = [];
        window.addEventListener("click", (e) => {
          const el = e.target instanceof Element ? e.target : null;
          const hit = el?.closest("a, button, input, select, summary") ?? null;
          // By value, not identity: windowed lists may re-render a row between measuring and clicking.
          window.__hits.push(hit ? { rowLink: hit.classList.contains("row-link"), href: hit.getAttribute("href"), label: hit.textContent.trim().slice(0, 50) } : null);
          e.preventDefault();
          e.stopPropagation();
        }, true);
      });
      const total = await page.evaluate(() => document.querySelectorAll(".tap-row").length);
      let visible = 0;
      for (let i = 0; i < total; i++) {
        // Find a point on the row that is not one of its own controls.
        const spot = await page.evaluate(({ i, CONTROL }) => {
          const row = document.querySelectorAll(".tap-row")[i];
          const link = row.querySelector(".row-link");
          const r0 = row.getBoundingClientRect();
          // Rows inside a closed <details> or a display:none breakpoint aren't on screen to click.
          if (!link || r0.width === 0 || r0.height === 0 || !row.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return { hidden: true };
          if (getComputedStyle(row).position !== "relative") return { error: "row is not position:relative (overlay can escape)" };
          row.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          const r = row.getBoundingClientRect();
          const y = r.top + r.height / 2;
          const xs = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.9].map((f) => r.left + r.width * f);
          for (const x of xs) {
            if (x < 1 || x > window.innerWidth - 1) continue;
            const el = document.elementFromPoint(x, y);
            if (!el) continue;
            const owner = el.closest(".tap-row");
            if (owner && owner !== row) return { error: `centre of row is covered by another row (${owner.textContent.slice(0, 40)})` };
            if (!row.contains(el)) return { error: `row is covered by ${el.tagName}.${String(el.className).slice(0, 40)}` };
            if (el.closest(CONTROL) && el.closest(CONTROL) !== link && row.contains(el.closest(CONTROL))) continue;
            return { x, y, label: link.textContent.trim().slice(0, 50), href: link.getAttribute("href") };
          }
          return { error: "no free spot on the row (every point is a control)" };
        }, { i, CONTROL });
        if (spot.hidden) continue;
        visible++;
        const where = `${size.name} ${path} row ${i}`;
        if (spot.error) { failures.push(`${where}: ${spot.error}`); continue; }
        if (size.touch) await page.touchscreen.tap(spot.x, spot.y); else await page.mouse.click(spot.x, spot.y);
        const hit = await page.evaluate(() => window.__hits.pop() ?? null);
        const ok = !!hit && hit.rowLink && hit.href === spot.href && hit.label === spot.label;
        checked++;
        if (!ok) failures.push(`${where} "${spot.label}": click did not land on the row's own link (${spot.href}); hit ${JSON.stringify(hit)}`);
        if (spot.href && /^\/jobs(\/|$)/.test(spot.href)) failures.push(`${where} "${spot.label}": row opens a worker page (${spot.href}), not the job`);
      }
      if (visible < min) failures.push(`${size.name} ${path}: expected at least ${min} clickable row(s), found ${visible}`);
    }
    await ctx.close();
  }
  assert.deepEqual(failures, [], `${failures.length} of ${checked} row clicks failed`);
  t.diagnostic(`${checked} row clicks checked`);
});
