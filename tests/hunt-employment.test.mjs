import assert from "node:assert/strict";
import { test } from "node:test";
import { employmentType } from "../lib/hunt-employment.mjs";

const type = (title, text = "") => employmentType(title, text)?.type ?? null;

test("titles that say contract, part-time, temporary, freelance or intern are flagged", () => {
  assert.equal(type("Senior Backend Engineer (Contract)"), "contract");
  assert.equal(type("Software Engineer - Contract to Hire"), "contract");
  assert.equal(type("Full Stack Developer, W2 Contractor"), "contract");
  assert.equal(type("Senior Software Engineer (6 month)"), "temporary");
  assert.equal(type("Backend Engineer, Part-Time"), "part-time");
  assert.equal(type("Freelance AI Engineer"), "freelance");
  assert.equal(type("Software Engineering Intern"), "internship");
});

test("explicit employment-type phrases in the posting are flagged", () => {
  assert.equal(type("Senior Software Engineer", "Location: Remote\nEmployment Type: Contract\n..."), "contract");
  assert.equal(type("Senior Software Engineer", "This is a 12-month contract role with possible extension."), "contract");
  assert.equal(type("Backend Engineer", "Open to W2 only. No C2C."), "contract");
  assert.equal(type("Backend Engineer", "Job type: Part-time, 20 hours a week"), "part-time");
});

test("full-time roles and loose mentions are not flagged", () => {
  assert.equal(type("Smart Contract Engineer"), null);
  assert.equal(type("Senior Engineer, Contracts Platform"), null);
  assert.equal(type("Senior Software Engineer", "You'll work with contractors and vendors. Employment type: Full-time."), null);
  assert.equal(type("Senior Software Engineer", "We review every contract our customers sign."), null);
  assert.equal(type("Senior Software Engineer (Full-time, contract-to-hire option)"), null);
  assert.equal(type("Staff Engineer, Internal Tools"), null); // "Internal" is not "intern"
  assert.equal(type("Senior Engineer, 2026 roadmap"), null);
});
