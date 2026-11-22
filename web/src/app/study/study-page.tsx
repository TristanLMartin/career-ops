// hunt: the Study page body, shared by /study (Home tab) and /study/<tab>.
// Sources: data/study/days.md (the days), design-prompts.md, company-prep.md, stories.md,
// lessons.md, checkpoints.md, resources.md, cards.jsonl, and the original study-plan.md
// (kept under Notes). Progress: data/study-state.json.
import fs from "node:fs";
import path from "node:path";
import { PageFrame } from "@/components/page-frame";
import { careerOpsRoot, readApplications, readApplicationStatusLog } from "@/lib/career-ops";
import { beyondCards, buildChecklist, normalizeState, parseCards, parsePlan } from "@/lib/hunt-study.mjs";
import { companyAnchor, companySections, designPromptIndex, parseCheckpoints, parseDays } from "@/lib/hunt-study-days.mjs";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { parseStatusLog, trackerRows } from "@/lib/hunt-tracker.mjs";
import { StudyApp, type StudyTab } from "@/components/hunt/study-app";
import type { DaysDoc, Interview2, Prompt } from "@/components/hunt/study-v2";

function read(rel: string): string {
  try { return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8"); } catch { return ""; }
}

/** Tracker rows in Interview / Assessment, each linked to its company-prep section when there is one. */
function interviews(companiesMd: string): Interview2[] {
  try {
    let log = "";
    try { log = readApplicationStatusLog() ?? ""; } catch { /* dates fall back */ }
    const sections = companySections(companiesMd);
    const rows = trackerRows(readApplications(), parseStatusLog(log), readHuntEnrichment().jobs) as { n: string; company: string; role: string; status: string; next: string }[];
    return rows
      .filter((r) => ["Interview", "Assessment"].includes(r.status))
      .map((r) => {
        const a = companyAnchor(sections, r.company);
        return { n: r.n, company: r.company, role: r.role, next: r.next, prepHref: a ? `/study/companies#${a}` : null };
      });
  } catch {
    return [];
  }
}

export function StudyPageBody({ tab = "home" }: { tab?: StudyTab }) {
  const days = read("data/study/days.md");
  const plan = read("data/study/study-plan.md");
  const docs = {
    design: read("data/study/design-prompts.md"),
    companies: read("data/study/company-prep.md"),
    stories: read("data/study/stories.md"),
    lessons: read("data/study/lessons.md") || read("data/study/nov17-lessons.md"),
    checkpoints: read("data/study/checkpoints.md"),
    resources: read("data/study/resources.md"),
  };
  const cards = [...parseCards(read("data/study/cards.jsonl")), ...beyondCards(plan)];
  let state = normalizeState({});
  try { state = normalizeState(JSON.parse(read("data/study-state.json"))); } catch { /* fresh */ }
  return (
    <PageFrame>
      <h1 className="font-display text-2xl tracking-tight text-landing">Study</h1>
      {!days && !plan ? (
        <p className="mt-4 rounded-lg border border-border p-4 text-sm text-muted">No study plan yet. It lives in data/study/days.md.</p>
      ) : (
        <StudyApp
          groups={plan ? buildChecklist(plan) : []}
          cards={cards}
          plan={plan ? parsePlan(plan) : []}
          initialState={state}
          daysDoc={parseDays(days) as DaysDoc}
          docs={docs}
          prompts={designPromptIndex(docs.design) as Prompt[]}
          checkpoints={parseCheckpoints(docs.checkpoints)}
          interviews={interviews(docs.companies)}
          initialTab={tab}
        />
      )}
    </PageFrame>
  );
}
