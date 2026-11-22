// Tests for scripts/onboard.mjs: every preset builds valid YAML with the answers in place, files
// are written into the profile directory, and existing files are kept unless --force.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { buildProfileFiles, writeProfileFiles, docxXmlToText, cvMarkdown, setTop, setNested, PRESETS } from "../scripts/onboard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboard-"));
  fs.cpSync(path.join(ROOT, "presets"), path.join(dir, "presets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "config"));
  fs.copyFileSync(path.join(ROOT, "config", "profile.example.yml"), path.join(dir, "config", "profile.example.yml"));
  return dir;
}

const answers = { name: "Sam Example", email: "sam@example.com", home: "Denver", home_words: ["Denver", "Boulder"], secondary: ["Austin"], base_floor: 95000, currency: "USD" };

for (const preset of Object.keys(PRESETS)) {
  test(`preset ${preset}: every YAML file parses and carries the answers`, () => {
    const { files } = buildProfileFiles({ ...answers, preset, target_roles: preset === "generic" ? ["Registered Nurse"] : [] }, { codeRoot: ROOT, cvText: "Experience\n- did things" });
    for (const [rel, text] of Object.entries(files)) if (rel.endsWith(".yml")) assert.doesNotThrow(() => yaml.load(text), rel);
    const person = yaml.load(files["config/person.yml"]);
    const ranking = yaml.load(files["config/ranking.yml"]);
    const portals = yaml.load(files["portals.yml"]);
    const profile = yaml.load(files["config/profile.yml"]);
    assert.equal(person.name, "Sam Example");
    assert.equal(person.first_name, "Sam");
    assert.equal(person.base_floor, 95000);
    assert.equal(ranking.base_floor, 95000);
    assert.deepEqual(ranking.profile_rules.location.home, ["Denver", "Boulder"]);
    assert.deepEqual(ranking.profile_rules.location.secondary, ["Austin"]);
    assert.ok(portals.location_filter.always_allow.includes("Boulder"));
    assert.equal(profile.candidate.full_name, "Sam Example");
    assert.match(files["cv.md"], /^# Sam Example/);
    if (preset === "generic") assert.deepEqual(portals.title_filter.positive, ["Registered Nurse"]);
  });
}

test("files land in profiles/<id>/ and existing files are kept without force", () => {
  const dir = tmpRoot();
  const built = buildProfileFiles({ ...answers, preset: "recruiting", profile: "sam" }, { codeRoot: dir, cvText: "x" });
  assert.equal(built.dir, path.join(dir, "profiles", "sam"));
  const first = writeProfileFiles(built);
  assert.ok(first.written.includes("cv.md") && first.written.includes("config/ranking.yml"));
  assert.ok(fs.existsSync(path.join(dir, "profiles", "sam", "data")));
  const second = writeProfileFiles(built);
  assert.equal(second.written.length, 0);
  assert.ok(second.kept.includes("portals.yml"));
  assert.ok(writeProfileFiles(built, { force: true }).written.includes("portals.yml"));
});

test("bad profile ids are refused", () => {
  assert.throws(() => buildProfileFiles({ ...answers, preset: "swe", profile: "../x" }, { codeRoot: ROOT }), /bad profile id/);
});

test("docx XML and plain text become Markdown", () => {
  const xml = '<w:p><w:r><w:t>Jordan Lee</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Hired 40 engineers &amp; PMs</w:t></w:r></w:p>';
  assert.equal(docxXmlToText(xml), "Jordan Lee\n- Hired 40 engineers & PMs\n");
  assert.equal(cvMarkdown("Jordan Lee", "Summary\r\nText"), "# Jordan Lee\n\nSummary\nText\n");
  assert.equal(cvMarkdown("x", "# Already\nbody"), "# Already\nbody\n");
});

test("setTop / setNested keep trailing comments", () => {
  assert.equal(setTop("a: 1   # note\nb: 2\n", "a", "5"), "a: 5   # note\nb: 2\n");
  assert.equal(setNested("x:\n  home: []   # c\ny:\n  home: []\n", "y", "home", '["Z"]'), 'x:\n  home: []   # c\ny:\n  home: ["Z"]\n');
});

test("migrate-legacy-names: dry run by default, renames with apply, never overwrites", async () => {
  const { migrate } = await import("../scripts/migrate-legacy-names.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
  fs.mkdirSync(path.join(dir, "config"));
  fs.mkdirSync(path.join(dir, "data", "cache", "oldname-jd"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "oldname-ranking.yml"), "weights: {}\n");
  fs.writeFileSync(path.join(dir, "data", "oldname-enrich.json"), "{}");
  fs.writeFileSync(path.join(dir, "data", "oldname-quick.json"), "{}");
  fs.writeFileSync(path.join(dir, "data", "hunt-quick.json"), "{\"keep\":1}");
  const dry = migrate(dir, { prefix: "oldname-" });
  assert.equal(dry.planned.length, 3);
  assert.ok(fs.existsSync(path.join(dir, "data", "oldname-enrich.json")), "dry run changes nothing");
  assert.deepEqual(migrate(dir, { prefix: "" }).planned, [], "no prefix, nothing to do");
  const r = migrate(dir, { apply: true, prefix: "oldname-" });
  assert.equal(r.renamed.length, 3);
  assert.ok(fs.existsSync(path.join(dir, "config", "ranking.yml")));
  assert.ok(fs.existsSync(path.join(dir, "data", "cache", "hunt-jd")));
  assert.equal(fs.readFileSync(path.join(dir, "data", "hunt-quick.json"), "utf8"), "{\"keep\":1}");
  assert.match(r.skipped[0], /oldname-quick\.json.*target exists/);
});
