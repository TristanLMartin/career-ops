"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Radar, Wrench } from "lucide-react";
import { CompanyLogo } from "@/components/company-logo";
import { useJobs, type Job } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";
import type { WatchedCompany } from "@/lib/portals-config.mjs";
import { showPortalsSetup } from "@/lib/portals-setup.mjs";

// hunt: built server-side by readPortalSources (lib/hunt-portals-sources.mjs, which reads files).
type SourcedCompany = { name: string; enabled: boolean; host: string; sources: string[]; boards?: string[] };
type Links = Record<string, { href: string; count: number }>;

/** hunt: a company name that opens Jobs filtered to it, with its open-job count. */
function CompanyName({ name, links, className }: { name: string; links?: Links; className?: string }) {
  const l = links?.[name.trim().toLowerCase()];
  if (!l) return <span className={cn("text-sm font-medium", className)}>{name}</span>;
  return (
    <Link href={l.href} className={cn("inline-flex min-w-0 items-baseline gap-1.5 text-sm font-medium hover:text-brand-text hover:underline max-sm:min-h-[36px] max-sm:items-center", className)} title={`Show ${name}'s jobs in Jobs`} data-company-link>
      <span className="truncate">{name}</span>
      <span className="shrink-0 text-[11px] font-normal tabular-nums text-faint">{l.count} job{l.count === 1 ? "" : "s"}</span>
    </Link>
  );
}
type Sourced = { companies: SourcedCompany[]; totals: Record<string, number>; vcBoards: number; total: number; labels: { key: string; label: string }[] };

type Company = { name: string; status: string; detail: string };
type Result = { available: boolean; configured: boolean; companies: Company[]; error?: string };

const TONE: Record<string, { dot: string; label: string; chip: string }> = {
  live: { dot: "bg-emerald-500", label: "live", chip: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-400" },
  empty: { dot: "bg-amber-500", label: "live · empty", chip: "bg-amber-500/15 text-amber-800 dark:text-amber-400" },
  broken: { dot: "bg-red-500", label: "broken", chip: "bg-red-500/15 text-red-700 dark:text-red-400" },
  skipped: { dot: "bg-zinc-400", label: "no ATS", chip: "bg-surface-hover text-muted" },
};
const ORDER: Record<string, number> = { broken: 0, empty: 1, live: 2, skipped: 3 };

export function PortalsView({
  watched,
  missing = false,
  target = "portals.yml",
  sourced = null,
  links,
}: {
  watched: WatchedCompany[];
  missing?: boolean;
  target?: string;
  sourced?: Sourced | null;
  links?: Links;
}) {
  const [res, setRes] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const { jobs, startJob } = useJobs();

  // map the agentic "fix-portal" workers to the company they're repairing
  const fixByCompany = useMemo(() => {
    const m = new Map<string, (typeof jobs)[number]>();
    for (const j of jobs) {
      if (j.kind !== "fix-portal" || !j.input) continue;
      const ex = m.get(j.input);
      if (!ex || j.startedAt > ex.startedAt) m.set(j.input, j);
    }
    return m;
  }, [jobs]);

  function check() {
    setLoading(true);
    fetch("/api/portals/verify")
      .then((r) => r.json())
      .then(setRes)
      .catch(() => setRes({ available: false, configured: false, companies: [] }))
      .finally(() => setLoading(false));
  }

  const companies = res?.companies ?? [];
  const broken = companies.filter((c) => c.status === "broken");
  const liveN = companies.filter((c) => c.status === "live" || c.status === "empty").length;
  const sorted = [...companies].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          onClick={check}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Radar className="size-4" />}
          Check portal health
        </button>
        {loading && <span className="text-xs text-faint">Probing each company&apos;s ATS… (~30–60s)</span>}
      </div>

      {!res && sourced && <SourcedList sourced={sourced} links={links} />}
      {!res && !sourced && watched.length > 0 && <WatchedList watched={watched} links={links} />}

      {res && !res.available && !res.error && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          <code className="text-foreground">verify-portals.mjs</code> not found — this needs a complete career-ops
          checkout (the web orchestrates the core&apos;s validator).
        </p>
      )}
      {res && !res.available && res.error && (
        <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-muted">
          <span className="font-medium text-red-700 dark:text-red-400">The portal check did not finish</span> — no
          portal was verified, so none is shown as healthy. Try again, or run{" "}
          <code className="text-foreground">node verify-portals.mjs</code> to see why.{" "}
          <code className="break-all font-mono text-xs text-faint">{res.error}</code>
        </p>
      )}
      {showPortalsSetup(missing, res) && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
          No <code className="break-all text-foreground">{target}</code> yet. Copy{" "}
          <code className="text-foreground">templates/portals.example.yml</code> to{" "}
          <code className="break-all text-foreground">{target}</code> and list the companies to watch. A health check does not create that file.
        </p>
      )}

      {res && res.configured && (
        <div className="mt-5">
          <p className="text-sm text-muted">
            <span className="tabular-nums text-emerald-800 dark:text-emerald-400">{liveN}</span> live ·{" "}
            <span className="tabular-nums text-red-700 dark:text-red-400">{broken.length}</span> broken ·{" "}
            <span className="tabular-nums">{companies.length}</span> tracked
          </p>
          {broken.length > 0 && (
            <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
              <span className="font-medium text-red-700 dark:text-red-400">
                {broken.length} {broken.length === 1 ? "company silently drops" : "companies silently drop"} from every
                scan
              </span>{" "}
              <span className="text-muted">
                — their careers link is broken. Fix the <code>careers_url</code> in <code>portals.yml</code> (or ask the
                assistant to repair them).
              </span>
            </div>
          )}
          <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
            {sorted.map((c) => {
              const t = TONE[c.status] ?? TONE.skipped;
              return (
                <li key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                  <CompanyLogo name={c.name} size={20} />
                  <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
                  <CompanyName name={c.name} links={links} className="shrink-0" />
                  <span className="truncate font-mono text-xs text-faint">{c.detail}</span>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {c.status === "broken" && <FixAffordance company={c.name} job={fixByCompany.get(c.name)} onFix={() => startJob({ title: `Fix · ${c.name}`, subtitle: "repair portal slug", kind: "fix-portal", input: c.name, page: "/portals" })} />}
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", t.chip)}>{t.label}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function FixAffordance({ company, job, onFix }: { company: string; job?: Job; onFix: () => void }) {
  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-brand-text">
        <Loader2 className="size-3 animate-spin" /> Fixing…
      </Link>
    );
  if (job?.status === "done")
    return (
      <Link href={`/jobs/${job.id}`} className="text-xs font-medium text-emerald-800 dark:text-emerald-400">
        repaired · re-check
      </Link>
    );
  return (
    <button
      onClick={onFix}
      title={`Have the agent repair ${company}'s portal slug`}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:text-brand-text"
    >
      <Wrench className="size-3" /> Fix
    </button>
  );
}

function WatchedList({ watched, links }: { watched: WatchedCompany[]; links?: Links }) {
  const scanned = watched.filter((c) => c.enabled).length;
  return (
    <div className="mt-5">
      <p className="text-sm text-muted">
        <span className="tabular-nums text-foreground">{scanned}</span> scanned ·{" "}
        <span className="tabular-nums">{watched.length - scanned}</span> paused · run a health check to see which boards
        still answer
      </p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {watched.map((c, i) => (
          <li key={`${i}-${c.name}`} className={cn("flex items-center gap-3 px-4 py-2.5", !c.enabled && "opacity-60")}>
            <CompanyLogo name={c.name} size={20} />
            <CompanyName name={c.name} links={links} className="shrink-0" />
            <span className="truncate font-mono text-xs text-faint">{c.host}</span>
            {!c.enabled && (
              <span className="ml-auto shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                paused
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** hunt: every monitored company (portals.yml + discovery lists), each with its source(s). */
function SourcedList({ sourced, links }: { sourced: Sourced; links?: Links }) {
  const [filter, setFilter] = useState<string | null>(null);
  const shown = filter ? sourced.companies.filter((c) => c.sources.includes(filter)) : sourced.companies;
  const labelOf = Object.fromEntries(sourced.labels.map((s) => [s.key, s.label]));
  return (
    <div className="mt-5">
      <p className="text-sm text-muted">
        <span className="tabular-nums font-medium text-foreground">{sourced.total}</span> companies monitored
        {sourced.vcBoards > 0 && (
          <>
            {" "}· plus <span className="tabular-nums">{sourced.vcBoards}</span> VC job boards
          </>
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          onClick={() => setFilter(null)}
          className={cn("rounded-full border px-2.5 py-1 text-xs max-sm:min-h-[36px]", !filter ? "border-brand/50 bg-brand/10 text-brand-text" : "border-border text-muted")}
        >
          All {sourced.total}
        </button>
        {sourced.labels.map((s) => (
          <button
            key={s.key}
            onClick={() => setFilter(filter === s.key ? null : s.key)}
            className={cn("rounded-full border px-2.5 py-1 text-xs max-sm:min-h-[36px]", filter === s.key ? "border-brand/50 bg-brand/10 text-brand-text" : "border-border text-muted")}
          >
            {s.label} <span className="tabular-nums">{sourced.totals[s.key]}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-faint">
        Also searched without a company list: HN Who&apos;s Hiring, Dice, Indeed, Built In, YC, VC boards and funding news.
        The health check above probes the Watchlist (portals.yml) only.
      </p>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {shown.map((c) => (
          <li key={c.name} className={cn("flex items-center gap-3 px-4 py-2.5", !c.enabled && "opacity-60")}>
            <CompanyLogo name={c.name} size={20} />
            <CompanyName name={c.name} links={links} className="min-w-0" />
            <span className="hidden truncate font-mono text-xs text-faint sm:inline">{c.host}</span>
            <span className="ml-auto flex shrink-0 gap-1">
              {c.sources.map((s) => (
                <span key={s} className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                  {labelOf[s] ?? s}
                </span>
              ))}
              {!c.enabled && <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold text-muted">paused</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
