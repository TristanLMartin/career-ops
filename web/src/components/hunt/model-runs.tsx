"use client";
// hunt: "Model runs" on the Workers page: every model run in one list, whoever started it
// (this dashboard, the cron scripts, bulk re-evaluations, Opus spot-checks), newest first, with
// status, model, job and cost. Reads /api/profile/model-runs; refreshes while anything runs.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ChevronRight, Clock, Loader2, OctagonPause } from "lucide-react";

type Run = { id: string; type?: undefined; at: string; kind: string; model: string; state: "queued" | "running" | "done" | "failed"; error: string | null; secs: number | null; costUsd: number | null; report: number | null; company: string; role: string; url: string };
// one bulk batch (scripts/hunt-reeval.mjs --batch-id): a parent row that expands to its job rows
type Batch = { id: string; type: "batch"; batch: string; label: string; model: string; at: string; startedAt: string | null; finishedAt: string | null; state: "running" | "done" | "failed" | "stopped"; status: string; total: number; done: number; failed: number; costUsd: number; capUsd: number | null; projectedUsd: number | null; spotchecks: number; children: Run[] };
type Row = Run | Batch;

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const money = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;

function StateIcon({ state }: { state: string }) {
  return state === "running" ? <Loader2 className="size-4 shrink-0 motion-safe:animate-spin text-brand-text" aria-label="running" />
    : state === "queued" ? <Clock className="size-4 shrink-0 text-faint" aria-label="queued" />
    : state === "failed" ? <AlertTriangle className="size-4 shrink-0 text-red-500" aria-label="failed" />
    : state === "stopped" ? <OctagonPause className="size-4 shrink-0 text-amber-800 dark:text-amber-400" aria-label="stopped" />
    : <Check className="size-4 shrink-0 text-emerald-800 dark:text-emerald-400" aria-label="done" />;
}

function RunRow({ r, nested = false }: { r: Run; nested?: boolean }) {
  const job = [r.company, r.role].filter(Boolean).join(" — ");
  return (
    <li className={`flex items-center gap-3 py-2.5 ${nested ? "pl-11 pr-4" : "px-4"}`}>
      <StateIcon state={r.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          {nested ? (
            <>{r.kind === "Opus spot-check" && <span className="font-medium text-foreground">Opus spot-check · </span>}<span className="text-foreground">{job}</span></>
          ) : (
            <><span className="font-medium text-foreground">{r.kind}</span><span className="text-muted"> · {r.model}</span>{job && <span className="text-foreground"> · {job}</span>}</>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {r.state === "failed" && r.error ? <span className="text-red-700 dark:text-red-400">{r.error}</span> : <>{when(r.at)}{r.secs ? ` · ${r.secs}s` : ""}{r.url ? <> · <Link href={`/pipeline/posting?url=${encodeURIComponent(r.url)}`} className="underline hover:text-brand-text">{r.report ? `report #${r.report}` : "job"}</Link></> : null}</>}
        </div>
      </div>
      <span className="shrink-0 text-xs capitalize text-faint max-sm:hidden">{r.state}</span>
      <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">{r.costUsd != null ? money(r.costUsd) : ""}</span>
    </li>
  );
}

function BatchRow({ b }: { b: Batch }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const pct = b.total ? Math.min(100, Math.round(((b.done + b.failed) / b.total) * 100)) : 0;
  const capPct = b.capUsd ? Math.min(100, Math.round((b.costUsd / b.capUsd) * 100)) : null;
  const kids = all ? b.children : b.children.slice(0, 30);
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface/70 max-sm:min-h-[44px]">
        <StateIcon state={b.state} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
            <span className="truncate font-medium text-foreground">{b.label}</span>
            <span className="shrink-0 text-xs text-faint">batch</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs tabular-nums text-muted">
            <span>{b.done}/{b.total} done</span>
            {b.failed > 0 && <span className="text-red-700 dark:text-red-400">{b.failed} failed</span>}
            <span>{money(b.costUsd)}{b.capUsd != null ? ` of $${b.capUsd} cap` : ""}</span>
            {b.state === "running" && b.projectedUsd != null && <span className="text-faint">~{money(b.projectedUsd)} projected</span>}
            {b.spotchecks > 0 && <span>{b.spotchecks} spot-checks</span>}
            {b.startedAt && <span className="text-faint">started {when(b.startedAt)}</span>}
            <span className="capitalize text-faint sm:hidden">{b.status || b.state}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="batch progress">
            <div className="h-full rounded-full bg-brand-text/70" style={{ width: `${pct}%` }} />
          </div>
          {capPct != null && capPct >= 90 && b.state === "running" && <div className="mt-1 text-xs text-amber-900 dark:text-amber-300">{capPct}% of the cap spent</div>}
        </div>
        <span className="shrink-0 text-xs capitalize text-faint max-sm:hidden">{b.status || b.state}</span>
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border bg-surface/20">
          {kids.length === 0 ? <li className="py-2.5 pl-11 text-xs text-muted">No job rows yet.</li> : kids.map((r) => <RunRow key={r.id} r={r} nested />)}
          {b.children.length > 30 && (
            <li className="py-2 pl-11"><button type="button" onClick={() => setAll(!all)} className="text-xs text-muted underline hover:text-brand-text max-sm:min-h-[44px]">{all ? "Show fewer" : `Show all ${b.children.length}`}</button></li>
          )}
        </ul>
      )}
    </li>
  );
}

export function ModelRuns() {
  const [data, setData] = useState<{ runs: Row[]; todayCost: number } | null>(null);
  const [all, setAll] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/profile/model-runs", { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } catch { /* offline: keep the last list */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = data?.runs.some((r) => r.state === "running" || r.state === "queued");
  useEffect(() => {
    const t = setInterval(load, active ? 5000 : 30000);
    return () => clearInterval(t);
  }, [active, load]);
  if (!data) return null;
  const runs = all ? data.runs : data.runs.slice(0, 40);
  return (
    <section aria-label="Model runs" className="mt-10">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl tracking-tight text-landing">Model runs</h2>
          <p className="mt-1 text-sm text-muted">Every AI run: quick scores, evaluations, Deep dives, Opus spot-checks and the nightly jobs. Today: <span className="tabular-nums">${data.todayCost.toFixed(2)}</span>.</p>
        </div>
      </div>
      {runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No model runs logged yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
          {runs.map((r) => (r.type === "batch" ? <BatchRow key={r.id} b={r} /> : <RunRow key={r.id} r={r} />))}
        </ul>
      )}
      {data.runs.length > 40 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-2 text-xs text-muted underline hover:text-brand-text max-sm:min-h-[44px]">{all ? "Show fewer" : `Show all ${data.runs.length}`}</button>
      )}
    </section>
  );
}
