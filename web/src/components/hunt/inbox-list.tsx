"use client";
// hunt: the Inbox, Messages and Follow-ups in one list. Two sections ("Needs my reply",
// "Waiting on them"), each opportunity exactly once. A row is two lines of text (tap: Details)
// plus a compact line of buttons: Reply (Needs rows with a Gmail / LinkedIn thread), Job, Done,
// Ignore, Details. Done / Ignore save through /api/profile/marks at once, move the row to
// "Done or ignored" without a reload, and offer Undo for 5 s. Nothing is ever sent.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { InboxItem } from "@/lib/hunt-data";
import { rowActions } from "@/lib/hunt-inbox.mjs";
import { cn } from "@/lib/cn";

type Mark = { mark: string; at: string; lastDate: string } | null;
type Section = "needs" | "waiting" | "done";

async function postMark(key: string, mark: string | null, lastDate: string) {
  const res = await fetch("/api/profile/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "mark", id: `opp:${key}`, mark, lastDate }) });
  if (!res.ok) throw new Error(String(res.status));
}

const btn = "inline-flex min-h-[44px] items-center rounded-md px-2.5 text-xs font-medium text-muted hover:bg-surface-hover hover:text-foreground";

function Row({ i, onMark }: { i: InboxItem; onMark: (i: InboxItem, mark: string | null) => void }) {
  const urgent = i.section === "needs" && /overdue/.test(i.when);
  const details = `/inbox/${encodeURIComponent(i.key)}`;
  const { reply, job } = rowActions(i) as { reply: { href: string; label: string } | null; job: { href: string; external: boolean } | null };
  return (
    <li className="px-3 pt-2 sm:flex sm:items-center sm:gap-3 sm:px-4 sm:py-1.5" data-key={i.key}>
      <Link href={details} className="row-text block min-w-0 sm:flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{i.title}</span>
        <span className="block truncate text-xs text-muted">
          {i.action}
          {i.when && <span className={cn(urgent ? "font-medium text-red-700 dark:text-red-400" : "text-faint")}> · {i.when}</span>}
        </span>
      </Link>
      <div className="-ml-2.5 flex flex-wrap items-center sm:ml-0 sm:shrink-0 sm:flex-nowrap" role="group" aria-label={`Actions for ${i.title}`}>
        {reply && <a href={reply.href} target="_blank" rel="noreferrer" className={cn(btn, "text-brand-text")}>{reply.label}</a>}
        {job && (job.external
          ? <a href={job.href} target="_blank" rel="noreferrer" className={btn}>Job</a>
          : <Link href={job.href} className={btn}>Job</Link>)}
        {i.mark ? (
          <button type="button" onClick={() => onMark(i, null)} className={btn}>Undo</button>
        ) : i.section !== "done" ? (
          <>
            <button type="button" onClick={() => onMark(i, "done")} className={btn}>Done</button>
            <button type="button" onClick={() => onMark(i, "wont")} className={btn}>Ignore</button>
          </>
        ) : null}
        <Link href={details} className={btn}>Details<ChevronRight aria-hidden className="ml-0.5 size-3.5" /></Link>
      </div>
    </li>
  );
}

function SectionList({ id, title, items, empty, onMark }: { id: string; title: string; items: InboxItem[]; empty: string; onMark: (i: InboxItem, mark: string | null) => void }) {
  return (
    <section aria-labelledby={id} className="mt-5 first:mt-0">
      <h2 id={id} className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {title}
        <span className="rounded-full bg-surface-hover px-2 py-px text-xs font-medium tabular-nums text-muted" data-count={items.length}>{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 rounded-lg border border-border px-4 py-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">{items.map((i) => <Row key={i.key} i={i} onMark={onMark} />)}</ul>
      )}
    </section>
  );
}

export function InboxList({ needs, waiting, done }: { needs: InboxItem[]; waiting: InboxItem[]; done: InboxItem[] }) {
  // Local marks win over the server's until the next render from the server.
  const [marks, setMarks] = useState<Record<string, { mark: Mark; from: Section }>>({});
  const [toast, setToast] = useState<{ i: InboxItem; mark: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const all = [...needs, ...waiting, ...done];
  const view = all.map((i) => {
    const m = marks[i.key];
    if (!m) return i;
    if (m.mark) return { ...i, mark: m.mark, section: "done" as Section, action: m.mark.mark === "done" ? "Marked done" : "Ignored", when: "" };
    // undone: back where it came from
    return { ...i, mark: null, section: m.from };
  });
  const original = new Map(all.map((i) => [i.key, i]));
  const restore = (i: InboxItem) => original.get(i.key)!;
  const by = (s: Section) => view.filter((i) => i.section === s);

  const onMark = async (i: InboxItem, mark: string | null) => {
    setError(null);
    const orig = restore(i);
    const from: Section = orig.mark ? "done" : orig.section;
    const lastDate = i.threads[0]?.date ?? "";
    const prev = marks[i.key];
    if (mark) setMarks((s) => ({ ...s, [i.key]: { mark: { mark, at: new Date().toISOString(), lastDate }, from } }));
    else setMarks((s) => ({ ...s, [i.key]: { mark: null, from: orig.mark ? "waiting" : from } }));
    if (mark) {
      if (timer.current) clearTimeout(timer.current);
      setToast({ i, mark });
      timer.current = setTimeout(() => setToast(null), 5000);
    }
    try {
      await postMark(i.key, mark, lastDate);
    } catch {
      setMarks((s) => { const n = { ...s }; if (prev) n[i.key] = prev; else delete n[i.key]; return n; });
      setError("Couldn't save that. Try again.");
    }
  };

  const undo = () => {
    if (!toast) return;
    const i = toast.i;
    setToast(null);
    setMarks((s) => { const n = { ...s }; delete n[i.key]; return n; });
    void postMark(i.key, null, i.threads[0]?.date ?? "").catch(() => setError("Couldn't undo that. Try again."));
  };

  const doneList = by("done");
  return (
    <div>
      <SectionList id="inbox-needs" title="Needs my reply" items={by("needs")} empty="Nothing needs a reply right now." onMark={onMark} />
      <SectionList id="inbox-waiting" title="Waiting on them" items={by("waiting")} empty="Nothing waiting on anyone." onMark={onMark} />
      {doneList.length > 0 && (
        <details className="group mt-5 rounded-lg border border-border">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted hover:text-foreground sm:px-4">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />Done or ignored ({doneList.length})
          </summary>
          <ul className="divide-y divide-border border-t border-border">{doneList.map((i) => <Row key={i.key} i={i} onMark={onMark} />)}</ul>
        </details>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {toast && (
        <div role="status" className="safe-b fixed inset-x-0 bottom-24 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-full border border-border bg-surface px-4 py-1 text-sm shadow-lg">
          <span className="truncate">{toast.mark === "done" ? "Done" : "Ignored"}: {toast.i.title}</span>
          <button type="button" onClick={undo} className="min-h-[44px] px-2 font-medium text-brand-text">Undo</button>
        </div>
      )}
    </div>
  );
}
