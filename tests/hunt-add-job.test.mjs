// Tests for scripts/hunt-add-job.mjs: dedupe hit, new add, unfetchable URL.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addJob, companyFromUrl, pipelineRows } from "../scripts/hunt-add-job.mjs";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-add-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(path.join(root, "portals.yml"), "tracked_companies:\n  - name: Affirm\n    careers_url: https://job-boards.greenhouse.io/affirm\n  - name: Stripe\n    careers_url: https://stripe.com/jobs\n");
  fs.writeFileSync(path.join(root, "data", "pipeline.md"), "# Pipeline\n\n## Pending\n\n- [ ] https://job-boards.greenhouse.io/affirm/jobs/111 | Affirm | Senior Software Engineer, Backend (Consumer) | Remote US | posted: 2026-11-09\n\n## Processed\n");
  fs.writeFileSync(path.join(root, "data", "applications.md"), "# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n| 1 | 2026-11-20 | Stripe | Backend / API Engineer, Radar | 4.1/5 | Evaluated | ❌ | — | https://stripe.com/jobs/search?gh_jid=8301253 |\n");
  fs.writeFileSync(path.join(root, "data", "scan-history.tsv"), "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n");
  return root;
}
const noFetch = async () => null;

test("duplicate: same posting URL in the inbox", async () => {
  const root = tmpRoot();
  const r = await addJob({ url: "https://job-boards.greenhouse.io/affirm/jobs/111" }, { root, enrich: false, fetchJd: noFetch });
  assert.equal(r.status, "duplicate");
  assert.equal(r.reason, "same posting URL");
  assert.equal(r.match.company, "Affirm");
});

test("duplicate: same company and title under a different URL (tracker)", async () => {
  const root = tmpRoot();
  const r = await addJob({ url: "https://www.linkedin.com/jobs/view/4300000001/", company: "Stripe", title: "Backend / API Engineer, Radar" }, { root, enrich: false, fetchJd: noFetch });
  assert.equal(r.status, "duplicate");
  assert.match(r.reason, /same company/);
  assert.equal(r.match.num, 1);
});

test("new add: title and JD from the ATS, written through scan.mjs's writers", async () => {
  const root = tmpRoot();
  const fetchJd = async () => ({ title: "Senior Software Engineer, Payments", text: "Own payments and checkout. Base pay $200,000 - $260,000 (WA, NY, CA).", ats: "greenhouse" });
  const r = await addJob({ url: "https://job-boards.greenhouse.io/affirm/jobs/222", location: "Seattle, WA" }, { root, enrich: false, fetchJd, today: "2026-11-21" });
  assert.equal(r.status, "added", JSON.stringify(r));
  assert.equal(r.job.company, "Affirm");
  assert.equal(r.job.title, "Senior Software Engineer, Payments");
  const rows = pipelineRows(fs.readFileSync(path.join(root, "data", "pipeline.md"), "utf8"));
  assert.ok(rows.some((x) => x.url === "https://job-boards.greenhouse.io/affirm/jobs/222" && x.role === "Senior Software Engineer, Payments"));
  assert.match(fs.readFileSync(path.join(root, "data", "scan-history.tsv"), "utf8"), /affirm\/jobs\/222\t2026-11-21/);
  const jd = JSON.parse(fs.readFileSync(path.join(root, "data", "cache", "hunt-jd", "manual.json"), "utf8"));
  assert.match(jd.texts["https://job-boards.greenhouse.io/affirm/jobs/222"], /checkout/);
  const again = await addJob({ url: "https://job-boards.greenhouse.io/affirm/jobs/222" }, { root, enrich: false, fetchJd });
  assert.equal(again.status, "duplicate", "a second add is caught");
});

test("unfetchable URL: asks for company and title, then adds and still dedupes", async () => {
  const root = tmpRoot();
  const first = await addJob({ url: "https://www.linkedin.com/jobs/view/4300000002/" }, { root, enrich: false, fetchJd: noFetch });
  assert.equal(first.status, "need-details");
  assert.match(first.message, /LinkedIn/);
  const second = await addJob({ url: "https://www.linkedin.com/jobs/view/4300000002/", company: "Hex", title: "Senior Software Engineer, Backend", jd: "Backend product work." }, { root, enrich: false, fetchJd: noFetch, today: "2026-11-21" });
  assert.equal(second.status, "added");
  const third = await addJob({ url: "https://hex.tech/careers/senior-backend", company: "Hex", title: "Senior Software Engineer, Backend" }, { root, enrich: false, fetchJd: noFetch });
  assert.equal(third.status, "duplicate", "same company + title from another URL");
});

test("bad input and company lookup", async () => {
  const root = tmpRoot();
  assert.equal((await addJob({ url: "not a url" }, { root, enrich: false, fetchJd: noFetch })).status, "error");
  const portals = fs.readFileSync(path.join(root, "portals.yml"), "utf8");
  assert.equal(companyFromUrl("https://job-boards.greenhouse.io/affirm/jobs/1", portals), "Affirm");
  assert.equal(companyFromUrl("https://stripe.com/jobs/search?gh_jid=1", portals), "Stripe");
  assert.equal(companyFromUrl("https://jobs.ashbyhq.com/some-co/uuid", portals), "Some Co");
});
