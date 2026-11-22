// node tests/fixtures/row-clicks.mjs prints a fresh disposable, fictional data root for
// row-click-targets.browser.test.mjs: inbox postings (one fit-scored WITH a tracker row, one
// fit-scored WITHOUT a report or worker run, one unscored), tracker rows past Evaluated, and
// hunt enrichment so Home has top picks. The tracker # and report # deliberately differ.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-row-clicks-"));
for (const dir of ["data", "reports"]) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, ".row-clicks-fixture"), "fictional-only\n");
const A = "https://example.com/fixture-alpha";
const B = "https://example.com/fixture-beta";
const C = "https://example.com/fixture-gamma";
fs.writeFileSync(path.join(root, "data/pipeline.md"), `# Fictional inbox

## Pending
- [ ] ${A} | Fixture Alpha | Engineer | Toronto
- [ ] ${B} | Fixture Beta | Designer | Montreal
- [ ] ${C} | Fixture Gamma | Analyst | Ottawa
`);
fs.writeFileSync(path.join(root, "data/applications.md"), `# Fictional browser fixture

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 2 | 2026-10-02 | Fixture Alpha | Engineer | 4.2/5 | Evaluated | — | [9](../reports/009-fixture-alpha.md) | Fictional fixture only |
| 3 | 2026-10-02 | Fixture Delta | Platform Engineer | 3.8/5 | Applied | — | | Fictional fixture only; Next: call 2026-10-20 |
| 4 | 2026-10-02 | Fixture Epsilon | Backend Engineer | 4.0/5 | Interview | — | | Fictional fixture only |
`);
fs.writeFileSync(path.join(root, "reports/009-fixture-alpha.md"), "# Fixture Alpha — Engineer\n\nFictional browser test report.\n");
const job = (company, role, extra) => ({
  company, role, location: "Remote", status: null, pay: null, locationTier: 2, benefits: null, relevance: 80,
  level: { key: "senior", label: "Senior", factor: 1 }, parts: {}, composite: 80, hasDescription: true, source: "inbox", groupLeader: true, shortlist: true, groupShortlist: true, ...extra,
});
fs.writeFileSync(path.join(root, "data/hunt-enrich.json"), JSON.stringify({
  generatedAt: "2026-10-02T00:00:00Z",
  weights: {},
  jobs: {
    [A]: job("Fixture Alpha", "Engineer", { fit: 4.2, composite: 90, report: { n: "9", tracker: "2", decision: "Apply", why: "Fictional.", gap: "", strength: "", nextAction: "" } }),
    [B]: job("Fixture Beta", "Designer", { fit: 4.0, composite: 85 }),
    [C]: job("Fixture Gamma", "Analyst", { fit: null, composite: 70 }),
  },
}));
fs.writeFileSync(path.join(root, "cv.md"), "# Fictional browser fixture\n\nNot a real candidate.\n");
console.log(root);
