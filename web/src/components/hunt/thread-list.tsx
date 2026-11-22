"use client";
// hunt: compact one-row-per-thread list for Messages and Follow-ups. Whole row opens the
// thread (stretched link); Done / Won't respond sit above it as 44px icon buttons. Marks live
// on the server (data/message-marks.json via /api/profile/marks), so phone and laptop agree.
// Nothing here sends or replies to anything.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, CornerUpLeft, EyeOff, Undo2 } from "lucide-react";
import type { ThreadRow } from "@/lib/hunt-data";
import { dueChip, shortWhen } from "@/lib/hunt-message-kinds.mjs";
import { cn } from "@/lib/cn";

type Mark = { mark: string; at: string; lastDate: string } | null;
const MARK_LABEL: Record<string, string> = { done: "Done", wont: "Won't respond" };
const KIND_LABEL: Record<string, string> = { recruiter: "Recruiter", job_lead: "Job lead", other: "Other", unclear: "Kind?" };

async function post(body: Record<string, unknown>) {
  const res = await fetch("/api/profile/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(String(res.status));
}

export function ThreadList({ rows, otherLabel = "Other messages", emptyText, showKinds = true }: { rows: ThreadRow[]; otherLabel?: string; emptyText: string; showKinds?: boolean }) {
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ id: string; name: string; mark: string; prev: Mark } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const view = rows.map((r) => {
    const m = r.id in marks ? marks[r.id] : (r.archived ? r.mark ?? null : null);
    return { ...r, kind: kinds[r.id] ?? r.kind, mark: m, archived: !!m };
  });
  const main = view.filter((r) => !r.archived && r.kind !== "other");
  const other = view.filter((r) => !r.archived && r.kind === "other");
  const archived = view.filter((r) => r.archived).sort((a, b) => String(b.mark?.at).localeCompare(String(a.mark?.at)));

  const setMark = async (r: ThreadRow, mark: string | null, prev: Mark, showToast = true) => {
    setError(null);
    setMarks((s) => ({ ...s, [r.id]: mark ? { mark, at: new Date().toISOString(), lastDate: r.date } : null }));
    if (showToast && mark) {
      if (timer.current) clearTimeout(timer.current);
      setToast({ id: r.id, name: r.name, mark, prev });
      timer.current = setTimeout(() => setToast(null), 5000);
    }
    try {
      await post({ op: "mark", id: r.id, mark, lastDate: r.date });
    } catch {
      setMarks((s) => ({ ...s, [r.id]: prev }));
      setError("Couldn't save that. Try again.");
    }
  };

  const setKind = async (r: ThreadRow, kind: string) => {
    const prev = kinds[r.id];
    setKinds((s) => ({ ...s, [r.id]: kind }));
    try { await post({ op: "kind", id: r.id, kind }); } catch {
      setKinds((s) => { const n = { ...s }; if (prev) n[r.id] = prev; else delete n[r.id]; return n; });
      setError("Couldn't save that. Try again.");
    }
  };

  const undo = () => {
    if (!toast) return;
    const r = rows.find((x) => x.id === toast.id);
    if (r) void setMark(r, toast.prev?.mark ?? null, { mark: toast.mark, at: "", lastDate: r.date }, false);
    setToast(null);
  };

  const row = (r: ThreadRow & { mark: Mark }, archivedRow = false) => {
    const due = dueChip(r.due ?? null);
    const status = r.newReply ? "new reply" : r.owe ? "you owe a reply" : r.kind === "application" ? (r.status || "") : r.answeredVia ? `answered via ${r.answeredVia}` : r.lastFromMe ? "waiting on them" : "";
    const title = (
      <span className="block truncate text-sm">
        <span className="font-semibold text-foreground">{r.name}</span>
        {r.about && <span className="font-medium text-muted"> · {r.about}</span>}
      </span>
    );
    return (
      <li key={r.id} className="tap-row flex items-center gap-2 px-3 py-1.5 sm:px-4">
        <div className="min-w-0 flex-1 py-0.5">
          <div className="flex items-center gap-2">
            {r.external ? (
              <a href={r.href} target="_blank" rel="noreferrer" className="row-link min-w-0 flex-1">{title}</a>
            ) : (
              <Link href={r.href} className="row-link min-w-0 flex-1">{title}</Link>
            )}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            {due && <span className={cn("shrink-0 rounded px-1.5 py-px font-medium", due.overdue ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-surface-hover text-muted")}>{due.label}</span>}
            {archivedRow && r.mark ? (
              <span className="shrink-0 text-faint" suppressHydrationWarning>{MARK_LABEL[r.mark.mark]} · {shortWhen(r.mark.at)}</span>
            ) : status ? (
              <span className={cn("inline-flex shrink-0 items-center gap-0.5", r.owe || r.newReply ? "font-medium text-brand-text" : "text-faint")}>
                {r.owe && !r.newReply && <CornerUpLeft aria-hidden className="size-3" />}
                {status}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-muted">{r.snippet}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col-reverse items-end gap-0.5">
              {showKinds && r.kind !== "application" && (r.kind === "recruiter" || r.kind === "job_lead" || r.kind === "unclear" || archivedRow || r.kind === "other") && (
                <label className="row-above relative shrink-0">
                  <span className="sr-only">Kind of thread from {r.name}</span>
                  <select
                    value={r.kind}
                    onChange={(e) => void setKind(r, e.target.value)}
                    title={r.why ? `Why: ${r.why}. Change it if it's wrong.` : "Change the kind"}
                    className={cn(
                      "cursor-pointer appearance-none rounded-full px-2 py-0.5 text-[10px] font-medium leading-4",
                      r.kind === "recruiter" ? "bg-brand-soft text-brand-text" : r.kind === "job_lead" ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-400" : "bg-surface-hover text-faint",
                    )}
                  >
                    {r.kind === "unclear" && <option value="unclear" disabled>Kind?</option>}
                    <option value="recruiter">Recruiter</option>
                    <option value="job_lead">Job lead</option>
                    <option value="other">Other</option>
                  </select>
                </label>
              )}
              <span className="shrink-0 text-xs tabular-nums text-faint" title={r.date ? new Date(r.date).toLocaleString() : undefined} suppressHydrationWarning>
                {shortWhen(r.date)}
              </span>
        </div>
        <div className="row-above flex shrink-0 items-center">
          {archivedRow ? (
            <button type="button" onClick={() => void setMark(r, null, r.mark, false)} className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-2 text-xs font-medium text-brand-text hover:bg-surface-hover" aria-label={`Undo ${r.mark ? MARK_LABEL[r.mark.mark] : "mark"} for ${r.name}`}>
              <Undo2 className="size-3.5" /> Undo
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void setMark(r, "done", null)} title="Done" aria-label={`Mark ${r.name} done`} className="inline-flex size-11 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-hover hover:text-emerald-700 dark:hover:text-emerald-400">
                <Check className="size-4" />
              </button>
              <button type="button" onClick={() => void setMark(r, "wont", null)} title="Won't respond" aria-label={`Won't respond to ${r.name}`} className="inline-flex size-11 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-hover hover:text-foreground">
                <EyeOff className="size-4" />
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  const group = (label: string, list: typeof view, archivedRows = false) =>
    list.length > 0 && (
      <details className="group mt-3 rounded-lg border border-border">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-sm text-muted hover:text-foreground sm:px-4">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          {label} ({list.length})
        </summary>
        <ul className="divide-y divide-border border-t border-border">{list.map((r) => row(r, archivedRows))}</ul>
      </details>
    );

  return (
    <div>
      {main.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">{main.map((r) => row(r))}</ul>
      )}
      {group(otherLabel, other)}
      {group("Archived", archived, true)}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {toast && (
        <div role="status" className="safe-b fixed inset-x-0 bottom-24 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-full border border-border bg-surface px-4 py-1 text-sm shadow-lg">
          <span className="truncate">{MARK_LABEL[toast.mark]}: {toast.name}</span>
          <button type="button" onClick={undo} className="min-h-[44px] px-2 font-medium text-brand-text">Undo</button>
        </div>
      )}
    </div>
  );
}
