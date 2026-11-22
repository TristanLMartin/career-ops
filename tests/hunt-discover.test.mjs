// Tests for scripts/hunt-discover.mjs and the HN/location helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boardsInText, hnCompany, watchedSlugs, watchedNames, harvestHn, discover } from "../scripts/hunt-discover.mjs";
import { parseHnHeader, locationTier } from "../lib/hunt-rank.mjs";

test("boardsInText finds Greenhouse, Lever, Ashby and Workable boards in HN HTML", () => {
  const html = 'Acme | Senior Backend | Remote (US)<p>Apply: <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;acme&#x2F;123">jobs.ashbyhq.com/acme</a> or https://job-boards.greenhouse.io/acmeco/jobs/9 and https://jobs.lever.co/acme-labs/abc, https://apply.workable.com/acme-w/j/1';
  const b = boardsInText(html).map((x) => `${x.provider}:${x.slug}`).sort();
  assert.deepEqual(b, ["ashby:acme", "greenhouse:acmeco", "lever:acme-labs", "workable:acme-w"]);
  assert.equal(hnCompany(html), "Acme");
  assert.equal(hnCompany("Postscript (YC W19) | Senior SWE | REMOTE"), "Postscript");
});

test("watched boards and names from portals.yml are not rediscovered", () => {
  const portals = "tracked_companies:\n  - name: Anthropic\n    careers_url: https://job-boards.greenhouse.io/anthropic\n    api: https://boards-api.greenhouse.io/v1/boards/anthropic/jobs\n  - name: OpenAI\n    careers_url: https://jobs.ashbyhq.com/openai\n";
  const w = watchedSlugs(portals);
  assert.ok(w.has("greenhouse:anthropic") && w.has("ashby:openai"));
  assert.ok(watchedNames(portals).has("openai"));
});

test("harvestHn reads the latest two threads and collects boards (stubbed Algolia)", async () => {
  const fake = async (url) => {
    if (url.includes("search_by_date")) return { hits: [{ objectID: "2", title: "Ask HN: Who is hiring? (November 2026)" }, { objectID: "9", title: "Ask HN: Who wants to be hired? (November 2026)" }, { objectID: "1", title: "Ask HN: Who is hiring? (October 2026)" }, { objectID: "0", title: "Ask HN: Who is hiring? (September 2026)" }] };
    if (url.endsWith("/2")) return { children: [{ text: "Beta | SWE | Seattle<p>https://jobs.ashbyhq.com/beta" }, { deleted: true }] };
    if (url.endsWith("/1")) return { children: [{ text: "Gamma | FDE | Remote https://jobs.lever.co/gamma" }, { text: "Beta again https://jobs.ashbyhq.com/beta" }] };
    throw new Error(`unexpected ${url}`);
  };
  const r = await harvestHn(fake);
  assert.deepEqual(r.threads.map((t) => t.id), ["2", "1"]);
  assert.deepEqual(r.boards.map((b) => `${b.provider}:${b.slug}:${b.name}`).sort(), ["ashby:beta:Beta", "lever:gamma:Gamma"]);
});

test("discover writes separate portals files with the same filters and never touches portals.yml", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-disc-"));
  fs.mkdirSync(path.join(root, "data"));
  const portals = "title_filter:\n  positive: [\"Engineer\"]\nlocation_filter:\n  allow: [\"Seattle\"]\ntracked_companies:\n  - name: Watched\n    careers_url: https://jobs.ashbyhq.com/watched\n";
  fs.writeFileSync(path.join(root, "portals.yml"), portals);
  fs.writeFileSync(path.join(root, "data", "scan-history.tsv"), "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://jobs.lever.co/handpicked/1\t2026-11-21\tmanual\tSWE\tHandpicked\tadded\n");
  const fake = async (url) => url.includes("search_by_date") ? { hits: [{ objectID: "5", title: "Ask HN: Who is hiring? (November 2026)" }] } : { children: [{ text: "New Co | SWE https://jobs.ashbyhq.com/newco" }, { text: "Watched | SWE https://jobs.ashbyhq.com/watched" }] };
  const r = await discover({ root, fetchJson: fake, now: new Date("2026-11-21T12:00:00Z") });
  assert.equal(r.boards, 2, "newco from HN + handpicked from a manual add; watched skipped");
  const boards = JSON.parse(fs.readFileSync(path.join(root, "data", "discovery-boards.yml"), "utf8").split("\n").slice(1).join("\n"));
  assert.deepEqual(boards.title_filter, { positive: ["Engineer"] });
  assert.deepEqual(boards.tracked_companies.map((t) => t.name).sort(), ["Handpicked", "New Co"]);
  const hn = JSON.parse(fs.readFileSync(path.join(root, "data", "discovery-hn.yml"), "utf8").split("\n").slice(1).join("\n"));
  assert.equal(hn.tracked_companies[0].provider, "hackernews");
  assert.equal(fs.readFileSync(path.join(root, "portals.yml"), "utf8"), portals, "portals.yml unchanged");
});

test("parseHnHeader and global-remote location tier", () => {
  const h = parseHnHeader("Postscript (YC W19) / Senior Software Engineer, Full Stack / REMOTE (US, Canada) / Full-time / $180K to $220K base + equity", "Postscript (YC W19)");
  assert.equal(h.role, "Senior Software Engineer, Full Stack");
  assert.deepEqual([h.pay.annualMin, h.pay.annualMax], [180000, 220000]);
  assert.equal(h.contract, false);
  assert.equal(parseHnHeader("Collabify / Senior Full-Stack Engineer / REMOTE (worldwide) / Contract, 4–5 months", "Collabify").contract, true);
  assert.equal(parseHnHeader("Senior Software Engineer, Backend", "Affirm"), null);
  assert.equal(locationTier("Remote, Global"), 5);
  assert.equal(locationTier("REMOTE (EU)"), 4);
  assert.equal(locationTier("Remote - USA"), 2);
});
