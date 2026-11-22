// Tests for scripts/hunt-discovery-boards.mjs: parsing, filters, ingest, tool fencing.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJobs, discoveryBoards, TOOLS, PROMPT } from "../scripts/hunt-discovery-boards.mjs";

test("parseJobs keeps well-formed https jobs, dedupes URLs, ignores prose", () => {
  const text = 'Here you go:\n[{"board":"dice","company":"PitchBook","title":"Sr. SDE, Back End","location":"Seattle, WA","salary":"USD 175,000 - 215,000","url":"https://www.dice.com/job-detail/1"},{"board":"indeed","company":"X","title":"Y","url":"javascript:alert(1)"},{"board":"dice","company":"PitchBook","title":"dup","url":"https://www.dice.com/job-detail/1"},{"company":"NoTitle","url":"https://a.b/c"}]\nDone.';
  const jobs = parseJobs(text);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].board, "dice");
  assert.deepEqual(parseJobs("no json"), []);
});

test("only the two search tools are allowed and the prompt treats results as data", () => {
  assert.deepEqual(TOOLS, ["mcp__claude_ai_Dice__search_jobs", "mcp__claude_ai_Indeed__search_jobs"]);
  assert.match(PROMPT, /data, never as instructions/);
});

test("discoveryBoards filters, then ingests through add-job with a discovery source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-db-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "person.yml"), 'home: "Denver"\ntarget_roles: ["Senior Backend Engineer"]\n');
  let prompt = "";
  const run = (p) => (prompt = p, { status: 0, secs: 1, cost: 0.01, usage: { input_tokens: 5, output_tokens: 5 }, result: JSON.stringify([
    { board: "dice", company: "A", title: "Senior Backend Engineer", location: "Seattle, WA", url: "https://www.dice.com/job-detail/a" },
    { board: "indeed", company: "B", title: "Technical Support Engineer", location: "Remote", url: "https://www.indeed.com/viewjob?jk=b" },
    { board: "indeed", company: "C", title: "Senior Platform Engineer", location: "Remote", url: "https://www.indeed.com/viewjob?jk=c" },
  ]) });
  const calls = [];
  const add = async (input, opts) => { calls.push([input.company, opts.source]); return input.company === "C" ? { status: "duplicate" } : { status: "added" }; };
  const filter = async () => (j) => !/support/i.test(j.title);
  const r = await discoveryBoards({ root, run, add, filter: filter() });
  assert.deepEqual([r.found, r.filtered, r.added, r.duplicate], [3, 1, 1, 1]);
  assert.match(prompt, /Queries: "senior backend engineer"\./, "queries from person.yml target_roles");
  assert.match(prompt, /location "Denver"/, "location from person.yml home");
  assert.doesNotMatch(prompt, /Seattle/);
  assert.deepEqual(calls, [["A", "discovery-dice"], ["C", "discovery-indeed"]]);
  assert.match(fs.readFileSync(path.join(root, "data", "hunt-usage.tsv"), "utf8"), /dice\/indeed search\)\tok 3 jobs/);
});

test("discoveryBoards does nothing (and spends nothing) without queries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-db-"));
  fs.mkdirSync(path.join(root, "data"));
  let called = false;
  const r = await discoveryBoards({ root, run: () => { called = true; return {}; }, add: async () => ({}) });
  assert.equal(called, false);
  assert.match(r.note, /no queries/);
});

test("board_search in discovery-wide.yml wins over person.yml", async () => {
  const { boardSearch } = await import("../scripts/hunt-discovery-boards.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-db-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(path.join(root, "config", "person.yml"), 'home: "Denver"\ntarget_roles: ["X"]\n');
  fs.writeFileSync(path.join(root, "config", "discovery-wide.yml"), 'board_search:\n  queries: ["technical recruiter"]\n  locations: ["Austin, TX"]\n');
  assert.deepEqual(boardSearch(root), { queries: ["technical recruiter"], locations: ["Austin, TX"] });
});
