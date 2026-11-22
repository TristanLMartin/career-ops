// Tests for scripts/hunt-discover-wide.mjs: slug verification,
// YC listing parser, VC portals file, funding RSS parser and candidate filter.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normName, namesMatch, candidateSlugs, probeSlug, findBoard, mergeDiscoveredBoards, recruiterCompanies,
  parseYcPage, vcPortals, fundingCompany, fundingRound, fundingAmount, parseFundingRss, fundingCandidates,
  companyDomain, contextWords,
} from "../scripts/hunt-discover-wide.mjs";

/** A fake GET keyed by URL; anything unknown is a 404. */
const fakeGet = (routes) => async (url) => (url in routes ? { status: 200, text: routes[url] } : { status: 404, text: "Not Found" });

test("names match after normalizing, and short or unrelated names do not", () => {
  assert.equal(normName("The Voleon Group"), "voleon");
  assert.ok(namesMatch("Voleon", "The Voleon Group"));
  assert.ok(namesMatch("Cadence", "Cadence Health"));
  assert.ok(namesMatch("Brightloop", "Brightloop"));
  assert.ok(!namesMatch("Hex", "Hexagon Manufacturing"));
  assert.ok(!namesMatch("Vale", "Openings at Vale Concepts"));
  assert.ok(!namesMatch("", "Anything"));
});

test("candidateSlugs puts hints first and keeps only safe slugs", () => {
  const s = candidateSlugs("The Voleon Group", ["voleon"]);
  assert.equal(s[0], "voleon");
  assert.ok(s.includes("voleongroup") && s.includes("voleon-group"));
  assert.ok(s.every((x) => /^[a-z0-9][a-z0-9_-]+$/.test(x)));
});

test("probeSlug accepts a Greenhouse board only when its API names the company", async () => {
  const get = fakeGet({ "https://boards-api.greenhouse.io/v1/boards/brightloop": JSON.stringify({ name: "Brightloop" }) });
  const b = await probeSlug("Brightloop", "brightloop", { get });
  assert.equal(b.provider, "greenhouse");
  assert.equal(b.careers_url, "https://job-boards.greenhouse.io/brightloop");
  assert.equal(await probeSlug("Hex", "brightloop", { get }), null);
});

test("probeSlug reads Ashby's own name/website and flags a board with the posting API off", async () => {
  const page = '<title>Hex Jobs</title>..."name":"Hex","publicWebsite":"https://hex.tech/"...';
  const on = await probeSlug("Hex", "hex", { get: fakeGet({ "https://jobs.ashbyhq.com/hex": page, "https://api.ashbyhq.com/posting-api/job-board/hex": "{\"jobs\":[]}" }) });
  assert.equal(on.provider, "ashby");
  assert.equal(on.unreadable, undefined);
  const off = await probeSlug("Hex", "hex", { get: fakeGet({ "https://jobs.ashbyhq.com/hex": page }) });
  assert.match(off.unreadable, /posting API is off/);
});

test("probeSlug accepts a Breezy board by the company's domain, and Workable needs real jobs", async () => {
  const get = fakeGet({
    "https://vale-concepts.breezy.hr/json": JSON.stringify([{ name: "Full Stack Engineer" }]),
    "https://vale-concepts.breezy.hr/": "<title>Openings at Vale Concepts</title> visit valenow.com",
    "https://apply.workable.com/api/v1/widget/accounts/vale": JSON.stringify({ name: "Vale", jobs: [] }),
  });
  assert.equal(await probeSlug("Vale", "vale", { get }), null); // Workable account with no jobs
  const b = await probeSlug("Vale", "vale-concepts", { get, domain: "valenow.com" });
  assert.equal(b.provider, "breezy");
});

test("strict probes (funding) need the company's domain or the article's words on the board", async () => {
  const routes = {
    "https://boards-api.greenhouse.io/v1/boards/avante": JSON.stringify({ name: "Avante" }),
    "https://boards-api.greenhouse.io/v1/boards/avante/jobs?content=true": JSON.stringify({ jobs: [{ content: "We build AI agents for corporate benefits teams." }] }),
  };
  const yes = await probeSlug("Avante", "avante", { get: fakeGet(routes), requireDomain: true, context: "Seattle startup Avante raises $30M to bring AI agents to corporate benefits teams" });
  assert.ok(yes && /article words/.test(yes.verifiedBy));
  const no = await probeSlug("Avante", "avante", { get: fakeGet(routes), requireDomain: true, context: "Avante raises $9M for satellite radar imaging" });
  assert.equal(no, null);
  assert.equal(await probeSlug("Avante", "avante", { get: fakeGet(routes), requireDomain: true }), null);
});

test("findBoard walks the slugs until one verifies", async () => {
  const get = fakeGet({ "https://boards-api.greenhouse.io/v1/boards/cadencehealth": JSON.stringify({ name: "Cadence Health" }) });
  const b = await findBoard({ name: "Cadence", slugs: ["cadencehealth"] }, { get, pause: 0 });
  assert.equal(b.slug, "cadencehealth");
  assert.equal(await findBoard({ name: "Nobody Corp" }, { get, pause: 0 }), null);
});

test("mergeDiscoveredBoards skips watched, unreadable and known boards and keeps the source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-wide-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "portals.yml"), "tracked_companies:\n  - name: Acme Rockets\n    careers_url: https://job-boards.greenhouse.io/acmerockets\n");
  fs.writeFileSync(path.join(root, "data", "hunt-discovery.json"), JSON.stringify({ boards: [{ provider: "ashby", slug: "old", name: "Old", careers_url: "https://jobs.ashbyhq.com/old" }] }));
  const r = mergeDiscoveredBoards(root, [
    { provider: "greenhouse", slug: "brightloop", careers_url: "https://job-boards.greenhouse.io/brightloop", name: "Brightloop", source: "recruiter" },
    { provider: "greenhouse", slug: "acmerockets", careers_url: "https://job-boards.greenhouse.io/acmerockets", name: "Acme Rockets", source: "recruiter" },
    { provider: "ashby", slug: "whatnot", careers_url: "https://jobs.ashbyhq.com/whatnot", name: "Whatnot", source: "recruiter", unreadable: "Ashby public posting API is off for this board" },
    { provider: "ashby", slug: "old", careers_url: "https://jobs.ashbyhq.com/old", name: "Old", source: "recruiter" },
  ]);
  assert.deepEqual(r.added.map((b) => b.slug), ["brightloop"]);
  assert.equal(r.skipped.length, 3);
  const state = JSON.parse(fs.readFileSync(path.join(root, "data", "hunt-discovery.json"), "utf8"));
  assert.equal(state.boards.find((b) => b.slug === "brightloop").source, "recruiter");
});

test("recruiterCompanies reads company names from the message feeds, not automated mail", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-wide-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "data", "hunt-messages.jsonl"), [JSON.stringify({ company: "Salesforce", automated: true }), JSON.stringify({ company: "Hex" }), "not json"].join("\n"));
  fs.writeFileSync(path.join(root, "data", "hunt-messages.linkedin-manual.jsonl"), JSON.stringify({ company: "Rippling" }) + "\n" + JSON.stringify({ company: null }));
  assert.deepEqual(recruiterCompanies(root).sort(), ["Hex", "Rippling"]);
});

test("parseYcPage reads the data-page JSON and keeps full-time postings with absolute URLs", () => {
  const data = { props: { jobPostings: [
    { title: "Senior Software Engineer - AI & Platform", url: "/companies/arketa/jobs/YqbQ3Ye-senior", companyName: "Arketa", location: "New York, NY, US", type: "Full-time", salaryRange: "$130K - $180K" },
    { title: "Intern", url: "/companies/x/jobs/1", companyName: "X", type: "Internship" },
    { title: "Bad", url: "https://evil.example/jobs/1", companyName: "Y", type: "Full-time" },
  ] } };
  const html = `<div data-page="${JSON.stringify(data).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`;
  const jobs = parseYcPage(html);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://www.ycombinator.com/companies/arketa/jobs/YqbQ3Ye-senior");
  assert.equal(jobs[0].title, "Senior Software Engineer - AI & Platform");
  assert.equal(jobs[0].salary, "$130K - $180K");
  assert.deepEqual(parseYcPage("<html>no data</html>"), []);
});

test("vcPortals keeps portals.yml filters and builds job_boards and mined boards", () => {
  const cfg = { vc_boards: [{ name: "Madrona portfolio", provider: "getro", careers_url: "https://jobs.madrona.com/jobs" }, { name: "a16z speedrun", provider: "a16z-speedrun-talent" }], builtin: [{ name: "Built In Seattle", host: "www.builtinseattle.com", categories: ["dev-engineering"] }] };
  const portals = { title_filter: { positive: ["Engineer"] }, location_filter: { allow: ["Seattle"] }, tracked_companies: [{ name: "Watched" }], job_boards: [{ name: "x" }] };
  const y = vcPortals(cfg, portals, [{ provider: "greenhouse", slug: "discord", careers_url: "https://job-boards.greenhouse.io/discord", name: "Discord", source: "vc-greylock" }]);
  assert.deepEqual(y.title_filter, portals.title_filter);
  assert.equal(y.job_boards.length, 3);
  assert.equal(y.job_boards[2].builtin.host, "www.builtinseattle.com");
  assert.ok(!("careers_url" in y.job_boards[1]));
  assert.deepEqual(y.tracked_companies, [{ name: "Discord", careers_url: "https://job-boards.greenhouse.io/discord", api: "https://boards-api.greenhouse.io/v1/boards/discord/jobs", enabled: true, notes: "discovery:vc-greylock" }]);
});

test("fundingCompany pulls the company out of the usual headline shapes", () => {
  assert.equal(fundingCompany("StepSecurity, led by two Microsoft vets, raises $20M to defend developers"), "StepSecurity");
  assert.equal(fundingCompany("Seattle startup Aarden raises $8M to help landowners"), "Aarden");
  assert.equal(fundingCompany("Filing: Chip startup Powerlattice raises $86M"), "Powerlattice");
  assert.equal(fundingCompany("Seattle’s Kivo Health raises $10M to bring lung disease rehab home"), "Kivo Health");
  assert.equal(fundingCompany("Watching fruit ripen pays off: Seattle ag-tech startup Strella lands $4.25M"), "Strella");
  assert.equal(fundingCompany("Proximal Ventures raises debut fund"), null);
  assert.equal(fundingCompany("Anthropic rival says companies can skip the pricey models"), null);
});

test("fundingRound and fundingAmount", () => {
  assert.equal(fundingRound("a $30M Series B led by Madrona"), "B");
  assert.equal(fundingRound("its seed round"), "seed");
  assert.equal(fundingRound("a Series D at a $2B valuation"), "late");
  assert.equal(fundingRound("raised money"), null);
  assert.equal(fundingAmount("raises $4.5M"), 4.5);
  assert.equal(fundingAmount("a $1.1B fund"), 1100);
  assert.equal(fundingAmount("no number"), null);
});

const rss = (items) => `<rss><channel>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${i.date}</pubDate><description><![CDATA[${i.desc ?? ""}]]></description><content:encoded><![CDATA[${i.body ?? ""}]]></content:encoded></item>`).join("")}</channel></rss>`;

test("parseFundingRss keeps the window, and fundingCandidates keeps Series A-C in target sectors", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const xml = rss([
    { title: "Seattle startup Avante raises $30M to bring AI agents to corporate benefits teams", link: "https://g/1", date: "Tue, 27 Oct 2026 10:00:00 GMT", desc: "The Series A round", body: '<a href="https://www.avante.ai/">Avante</a> builds an agents platform' },
    { title: "Payco raises $12M for checkout", link: "https://g/2", date: "Tue, 03 Nov 2026 10:00:00 GMT", body: "payments infrastructure" },
    { title: "SeedCo raises $3M seed round for payments", link: "https://g/3", date: "Tue, 03 Nov 2026 10:00:00 GMT" },
    { title: "BioCo raises $40M Series B for drug discovery", link: "https://g/4", date: "Tue, 03 Nov 2026 10:00:00 GMT" },
    { title: "OldCo raises $20M Series A for payments", link: "https://g/5", date: "Tue, 03 Feb 2026 10:00:00 GMT" },
  ]);
  const items = parseFundingRss(xml, { now, days: 90 });
  assert.equal(items.length, 4);
  assert.equal(items[0].company, "Avante");
  assert.equal(items[0].round, "A");
  assert.equal(items[0].domain, "avante.ai");
  const c = fundingCandidates(items, ["payment", "checkout", "agents", "platform"]).map((i) => i.company);
  assert.deepEqual(c, ["Avante", "Payco"]); // seed, off-sector and out-of-window dropped
});

test("companyDomain and contextWords", () => {
  assert.equal(companyDomain("Kivo Health", '<a href="https://www.cdc.gov/x">CDC</a> <a href="https://kivohealth.com/">Kivo</a>'), "kivohealth.com");
  assert.equal(companyDomain("Fairly", '<a href="https://www.vacasa.com">v</a>'), "");
  assert.deepEqual(contextWords("Seattle startup Avante raises $30M to bring AI agents to corporate benefits teams", "Avante"), ["bring", "agents", "corporate", "benefits", "teams"]);
});
