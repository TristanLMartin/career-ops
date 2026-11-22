// hunt: the header profile switcher's data (server only). Instances are listed in the
// checkout's config/profile-instances.yml; each shows its person's first name from that
// profile's config/person.yml. The current one is the profile this server reads (careerOpsRoot()).
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

export type ProfileSwitchItem = { id: string; name: string; port: number; current: boolean };

function readYaml(file: string): Record<string, unknown> | null {
  try { const d = yaml.load(fs.readFileSync(file, "utf8")); return d && typeof d === "object" ? (d as Record<string, unknown>) : null; } catch { return null; }
}

/** The instances to switch between, or [] when there is only one (no switcher then). */
export function readProfileSwitch(): ProfileSwitchItem[] {
  const codeRoot = resolveCodeRoot(process.cwd(), process.env);
  const doc = readYaml(path.join(codeRoot, "config", "profile-instances.yml"));
  const list = Array.isArray(doc?.instances) ? (doc!.instances as Record<string, unknown>[]) : [];
  const here = path.resolve(careerOpsRoot());
  const items = list
    .filter((i) => typeof i?.id === "string" && Number.isFinite(Number(i?.port)))
    .map((i) => {
      const dir = path.resolve(codeRoot, String(i.dir ?? "."));
      const person = readYaml(path.join(dir, "config", "person.yml"));
      const first = typeof person?.first_name === "string" && person.first_name.trim() ? person.first_name.trim() : "";
      return { id: String(i.id), name: first || String(i.label ?? i.id), port: Number(i.port), current: dir === here };
    });
  return items.length > 1 ? items : [];
}
