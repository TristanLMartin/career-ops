// hunt: the Portals page lists every monitored company (portals.yml + discovery lists).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePortalSources } from "../../src/lib/hunt-portals-sources.mjs";

test("merges sources, dedupes by name and counts each source", () => {
  const r = mergePortalSources({
    portals: "tracked_companies:\n  - { name: Stripe, careers_url: https://stripe.com/jobs }\n  - { name: Ramp, careers_url: https://jobs.ashbyhq.com/ramp, enabled: false }\n",
    targets: "tracked_companies:\n  - { name: stripe, careers_url: https://stripe.com/jobs }\n  - { name: Google, careers_url: https://careers.google.com }\n",
    vc: "job_boards: [{ name: a }, { name: b }]\ntracked_companies: []\n",
  });
  assert.equal(r.total, 3);
  assert.deepEqual(r.totals, { portals: 2, targets: 2, vc: 0 });
  assert.equal(r.vcBoards, 2);
  assert.deepEqual(r.companies.find((c) => c.name === "Stripe").sources, ["portals", "targets"]);
  assert.equal(r.companies.at(-1).name, "Ramp"); // paused last
});

test("a missing or broken file is skipped", () => {
  const r = mergePortalSources({ portals: "tracked_companies: [{ name: A }]", boards: "a: [unclosed" });
  assert.equal(r.total, 1);
  assert.deepEqual(r.totals, { portals: 1 });
});
