import { Radar } from "lucide-react";
import path from "node:path";
import { PortalsView } from "@/components/portals-view";
import { careerOpsRoot, portalsConfigPath } from "@/lib/career-ops";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { loadPortalsDocument, watchedCompanies, type WatchedCompany } from "@/lib/portals-config.mjs";
import { readPortalSources } from "@/lib/hunt-portals-sources.mjs";
import { pipelineSummary } from "@/lib/career-ops";
import { pendingInbox } from "@/lib/inbox-pending.mjs";
import { readHuntEnrichment } from "@/lib/hunt-data";
import { atsBoard, companyHref, companyKey } from "@/lib/hunt-company-filter.mjs";

/**
 * hunt: name (lowercased) -> the Jobs link filtered to that company and how many open jobs
 * it has there now (the pending Jobs list, closed postings left out), for every company shown.
 */
function companyLinks(names: { name: string; boards?: string[] }[]): Record<string, { href: string; count: number }> {
  const byKey = new Map<string, number>();
  const byBoard = new Map<string, string[]>();
  try {
    const enrich = readHuntEnrichment().jobs;
    for (const j of pendingInbox(pipelineSummary().inbox)) {
      if (enrich[j.url]?.closed) continue;
      const k = companyKey(j.company);
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
      const b = atsBoard(j.url);
      if (b) byBoard.set(b, [...(byBoard.get(b) ?? []), k]);
    }
  } catch { /* counts are a nicety: links still work */ }
  const out: Record<string, { href: string; count: number }> = {};
  for (const { name, boards = [] } of names) {
    const k = companyKey(name);
    const count = (byKey.get(k) ?? 0) + boards.reduce((n, b) => n + (byBoard.get(b) ?? []).filter((x) => x !== k).length, 0);
    out[name.trim().toLowerCase()] = { href: companyHref(name, boards), count };
  }
  return out;
}

export const dynamic = "force-dynamic";

function readWatched(): { watched: WatchedCompany[]; missing: boolean; error: string | null } {
  const root = careerOpsRoot();
  try {
    // The template ships with the code, which a data-only CAREER_OPS_ROOT does not hold.
    const template = path.join(resolveCodeRoot(process.cwd(), process.env), "templates", "portals.example.yml");
    const { doc, seeded } = loadPortalsDocument(portalsConfigPath(root), template);
    return { watched: seeded ? [] : watchedCompanies(doc), missing: seeded, error: null };
  } catch (e) {
    return { watched: [], missing: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function PortalsPage() {
  const { watched, missing, error } = readWatched();
  // hunt: every list the scans read (portals.yml + the discovery files), with where each company comes from.
  let sourced = null;
  try {
    sourced = readPortalSources(careerOpsRoot());
  } catch {
    sourced = null;
  }
  const boardsOf = new Map((sourced?.companies ?? []).map((c) => [c.name.toLowerCase(), c.boards]));
  const links = companyLinks([
    ...(sourced?.companies ?? []).map((c) => ({ name: c.name, boards: c.boards })),
    ...watched.filter((w) => !boardsOf.has(w.name.toLowerCase())).map((w) => ({ name: w.name })),
  ]);
  // Name the file the page reads, which CAREER_OPS_PORTALS can move.
  const target = process.env.CAREER_OPS_PORTALS?.trim() ? portalsConfigPath(careerOpsRoot()) : "portals.yml";
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex items-center gap-3">
        <Radar className="size-6 text-brand-text" />
        <h1 className="font-display text-2xl tracking-tight text-landing">Portals</h1>
      </div>
      <p className="mt-1.5 max-w-xl text-sm text-muted">
        The companies career-ops watches for new roles. Run a health check to catch company boards that have quietly
        broken — a broken link means that company silently disappears from every future scan.
      </p>
      <p className="mt-1.5 text-xs text-faint">
        Backed by <code className="text-muted">portals.yml</code> — edit it directly or ask the assistant.
      </p>
      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400">
          Could not read <code>portals.yml</code>: {error}
        </p>
      )}
      <div className="mt-6">
        <PortalsView watched={watched} missing={missing} target={target} sourced={sourced && sourced.total > watched.length ? sourced : null} links={links} />
      </div>
    </div>
  );
}
