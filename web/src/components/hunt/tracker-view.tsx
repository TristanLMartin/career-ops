"use client";
// hunt: the Tracker table. Table on desktop, one card per job on a phone.
// Status and Next step save through /api/status (set-status.mjs), then the page refreshes.
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronRight, Download, ExternalLink, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { TRACKER_STATUSES, payLabel, sortRows, trackerCsvText } from "@/lib/hunt-tracker.mjs";

export type TrackerRow = {
  n: string; company: string; role: string; status: string; applied: string; appliedApprox: boolean; updated: string;
  next: string; nextRaw: string; base: [number, number] | null; tc: number | null; location: string; url: string; score: string; notes: string;
};

type SortKey = "company" | "role" | "status" | "applied" | "updated" | "next" | "pay" | "location";

const PILL: Record<string, string> = {
  Offer: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  Hired: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  Interview: "bg-violet-500/15 text-violet-800 dark:text-violet-300",
  Assessment: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  Responded: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  Applied: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  Speculative: "bg-pink-500/15 text-pink-800 dark:text-pink-300",
  Rejected: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};
const pill = (s: string) => PILL[s] ?? "bg-surface-hover text-muted";
const STATUS_CHOICES = ["Evaluated", ...TRACKER_STATUSES, "Discarded"];

const COLS: { key: SortKey; label: string }[] = [
  { key: "company", label: "Company" },
  { key: "role", label: "Role" },
  { key: "status", label: "Status" },
  { key: "applied", label: "Applied" },
  { key: "updated", label: "Last update" },
  { key: "next", label: "Next step" },
  { key: "pay", label: "Base / TC" },
  { key: "location", label: "Location" },
];

function shortDate(d: string) {
  if (!d) return "—";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

async function save(body: Record<string, string>) {
  const r = await fetch("/api/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.ok !== true) throw new Error(typeof j?.error === "string" ? j.error : "Could not save. Try again.");
}

export function TrackerView({ rows }: { rows: TrackerRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("All");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "status", dir: "asc" });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  const statuses = useMemo(() => TRACKER_STATUSES.filter((s: string) => rows.some((r) => r.status === s)), [rows]);
  const shown = useMemo(() => sortRows(rows.filter((r) => filter === "All" || r.status === filter), sort.key, sort.dir) as TrackerRow[], [rows, filter, sort]);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "updated" || key === "applied" || key === "pay" ? "desc" : "asc" }));

  async function setStatus(r: TrackerRow, status: string) {
    if (status === r.status) return;
    setError("");
    try { await save({ n: r.n, status }); router.refresh(); } catch (e) { setError(`${r.company}: ${(e as Error).message}`); throw e; }
  }
  async function setNext(r: TrackerRow, text: string) {
    setError("");
    try {
      await save({ n: r.n, status: r.status, note: `Next: ${text}`, ...(r.nextRaw ? { replaceNote: r.nextRaw } : {}) });
      router.refresh();
    } catch (e) { setError(`${r.company}: ${(e as Error).message}`); throw e; }
  }

  function downloadCsv() {
    const url = URL.createObjectURL(new Blob([trackerCsvText(shown)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `tracker-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (!rows.length) {
    return <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-sm text-muted">Nothing in flight yet. When a job moves past Evaluated (Applied, Interview…), it shows up here.</p>;
  }

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-2">
        {["All", ...statuses].map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter === s}
            onClick={() => setFilter(s)}
            className={cn("inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-xs", filter === s ? "border-brand-text bg-brand-soft font-medium text-brand-text" : "border-border text-muted hover:text-foreground")}
          >
            {s}<span className="text-faint">{s === "All" ? rows.length : rows.filter((r) => r.status === s).length}</span>
          </button>
        ))}
        <button type="button" onClick={downloadCsv} className="ml-auto inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted hover:text-foreground">
          <Download className="size-3.5" />Download CSV
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}

      {/* Phone: cards */}
      <div className="mt-4 space-y-3 md:hidden">
        <label className="flex items-center gap-2 text-xs text-faint">
          Sort
          <select value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(":"); setSort({ key: key as SortKey, dir: dir as "asc" | "desc" }); }} className="min-h-[36px] rounded-md border border-border bg-surface px-2 text-xs text-foreground">
            <option value="status:asc">Stage</option>
            <option value="updated:desc">Last update</option>
            <option value="applied:desc">Applied</option>
            <option value="company:asc">Company</option>
            <option value="pay:desc">Pay</option>
          </select>
        </label>
        {shown.map((r) => (
          <div key={r.n} className="tap-row rounded-xl border border-border bg-surface p-4">
            <button type="button" onClick={() => setOpen(open === r.n ? null : r.n)} aria-expanded={open === r.n} className="row-link flex w-full items-start gap-2 text-left">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground">{r.company}</p>
                <p className="text-sm leading-snug text-muted">{r.role}</p>
              </div>
              <ChevronRight className={cn("mt-1 size-4 shrink-0 text-faint transition-transform", open === r.n && "rotate-90")} />
            </button>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="row-above"><StatusPill r={r} onChange={setStatus} /></span>
              <span className="text-xs text-faint">Applied {shortDate(r.applied)}{r.appliedApprox ? "?" : ""} · updated {shortDate(r.updated)}</span>
            </div>
            <div className="row-above mt-3"><NextEdit r={r} onSave={setNext} /></div>
            {open === r.n && <div className="row-above cursor-auto"><RowDetails r={r} /></div>}
          </div>
        ))}
      </div>

      {/* Desktop: table */}
      <div className="mt-4 hidden overflow-x-auto rounded-xl border border-border md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-surface-hover/60 text-xs text-muted">
            <tr>
              {COLS.map((c) => (
                <th key={c.key} scope="col" aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className="px-3 py-2 font-medium">
                  <button type="button" onClick={() => onSort(c.key)} className="inline-flex items-center gap-1 hover:text-foreground">
                    {c.label}
                    {sort.key === c.key && (sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                  </button>
                </th>
              ))}
              <th scope="col" className="px-3 py-2 font-medium"><span className="sr-only">Link</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <Fragment key={r.n}>
                <tr className="tap-row border-t border-border align-top hover:bg-surface-hover/40">
                  <td className="px-3 py-2.5">
                    <button type="button" onClick={() => setOpen(open === r.n ? null : r.n)} aria-expanded={open === r.n} className="row-link inline-flex items-start gap-1 text-left font-medium text-foreground">
                      <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-faint transition-transform", open === r.n && "rotate-90")} />{r.company}
                    </button>
                  </td>
                  <td className="min-w-[13rem] max-w-[20rem] px-3 py-2.5 text-muted">{r.role}</td>
                  <td className="row-above px-3 py-2.5"><StatusPill r={r} onChange={setStatus} /></td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted" title={r.appliedApprox ? "From the tracker date; no applied date was recorded" : undefined}>{shortDate(r.applied)}{r.appliedApprox ? "?" : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted">{shortDate(r.updated)}</td>
                  <td className="row-above min-w-[12rem] px-3 py-1.5"><NextEdit r={r} onSave={setNext} /></td>
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted">{payLabel(r) || "—"}</td>
                  <td className="max-w-[12rem] px-3 py-2.5 text-xs text-muted"><span className="line-clamp-2" title={r.location}>{r.location || "—"}</span></td>
                  <td className="px-3 py-2.5">
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="tap-44 inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">Posting<ExternalLink className="size-3" /></a> : <span className="text-xs text-faint">—</span>}
                  </td>
                </tr>
                {open === r.n && (
                  <tr className="border-t border-border bg-surface-hover/30"><td colSpan={9} className="px-6 py-3"><RowDetails r={r} /></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ r, onChange }: { r: TrackerRow; onChange: (r: TrackerRow, s: string) => Promise<void> }) {
  const [value, setValue] = useState(r.status);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(r.status), [r.status]);
  return (
    <span className="relative inline-flex items-center">
      <select
        aria-label={`Status for ${r.company}`}
        value={value}
        disabled={busy}
        onChange={async (e) => {
          const next = e.target.value;
          setValue(next); setBusy(true);
          try { await onChange(r, next); } catch { setValue(r.status); } finally { setBusy(false); }
        }}
        className={cn("min-h-[32px] cursor-pointer appearance-none rounded-full border-0 py-1 pl-3 pr-3 text-xs font-medium", pill(value))}
      >
        {STATUS_CHOICES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {busy && <Loader2 className="ml-1 size-3.5 animate-spin text-faint" />}
    </span>
  );
}

function NextEdit({ r, onSave }: { r: TrackerRow; onSave: (r: TrackerRow, text: string) => Promise<void> }) {
  const [text, setText] = useState(r.next);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => setText(r.next), [r.next]);
  async function commit() {
    const t = text.trim().replace(/[|\r\n]+/g, " ");
    if (t === r.next.trim()) return;
    if (!t) { setText(r.next); return; } // set-status appends or replaces notes; it never blanks one
    setState("saving");
    try { await onSave(r, t); setState("saved"); setTimeout(() => setState("idle"), 1500); } catch { setText(r.next); setState("idle"); }
  }
  return (
    <span className="flex items-center gap-1.5">
      <input
        aria-label={`Next step for ${r.company}`}
        value={text}
        placeholder="Add a next step"
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setText(r.next); (e.target as HTMLInputElement).blur(); } }}
        className="min-h-[36px] w-full rounded-md border border-transparent bg-transparent px-2 text-sm text-foreground placeholder:text-faint hover:border-border focus:border-border focus:bg-surface focus:outline-none"
      />
      {state === "saving" && <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" />}
      {state === "saved" && <span className="shrink-0 text-xs text-emerald-800 dark:text-emerald-400">Saved</span>}
    </span>
  );
}

function RowDetails({ r }: { r: TrackerRow }) {
  return (
    <div className="mt-3 space-y-2 text-sm md:mt-0">
      <p className="text-xs text-faint">
        ID {r.n}{r.score && r.score !== "N/A" ? ` · score ${r.score}` : ""}{payLabel(r) ? ` · ${payLabel(r)}` : ""}{r.location ? ` · ${r.location}` : ""}
      </p>
      {r.notes && <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">{r.notes}</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        <Link href={`/pipeline/${encodeURIComponent(r.n)}`} className="tap-44 text-brand-text underline-offset-2 hover:underline">Open evaluation</Link>
        {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="tap-44 inline-flex items-center gap-1 text-muted hover:text-foreground">Posting<ExternalLink className="size-3" /></a>}
      </div>
    </div>
  );
}
