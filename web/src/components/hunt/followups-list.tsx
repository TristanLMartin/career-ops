"use client";
// hunt: Follow-ups, one row per opportunity. Every row opens its detail page (/followups/<key>):
// one predictable tap, a chevron to show it. Line 1 is the company (or the person); line 2 is the
// next step and when. Done / Ignore live in the detail page, so nothing on a row can be mis-tapped.
import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { Opportunity } from "@/lib/hunt-data";
import { whenLabel } from "@/lib/hunt-followups.mjs";
import { cn } from "@/lib/cn";

function Row({ o }: { o: Opportunity }) {
  const when = whenLabel(o);
  return (
    <li className="tap-row flex min-h-[56px] items-center gap-2 px-3 py-2 sm:px-4">
      <Link href={`/followups/${encodeURIComponent(o.key)}`} className="row-link min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{o.title}</span>
        <span className="block truncate text-xs text-muted">
          {o.line2}
          {when && <span className={cn(o.state === "overdue" ? "font-medium text-red-700 dark:text-red-400" : o.state === "today" ? "font-medium text-brand-text" : "text-faint")}> · {when}</span>}
        </span>
      </Link>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
    </li>
  );
}

export function FollowupsList({ items }: { items: Opportunity[] }) {
  const [showOthers, setShowOthers] = useState(false);
  const active = items.filter((o) => !o.mark && !o.other);
  const others = items.filter((o) => !o.mark && o.other);
  const marked = items.filter((o) => o.mark);
  return (
    <div>
      {active.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted">Nothing to follow up on right now.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">{active.map((o) => <Row key={o.key} o={o} />)}</ul>
      )}
      {others.length > 0 && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers} className="inline-flex min-h-[44px] items-center gap-1 text-xs text-muted hover:text-foreground">
            <ChevronRight className={cn("size-4 transition-transform", showOthers && "rotate-90")} />{showOthers ? "Hide others" : `Show others (${others.length})`}
          </button>
          {showOthers && <ul className="divide-y divide-border rounded-lg border border-border">{others.map((o) => <Row key={o.key} o={o} />)}</ul>}
        </div>
      )}
      {marked.length > 0 && (
        <details className="group mt-3 rounded-lg border border-border">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-xs text-muted">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />Done or ignored ({marked.length})
          </summary>
          <ul className="divide-y divide-border border-t border-border">{marked.map((o) => <Row key={o.key} o={o} />)}</ul>
        </details>
      )}
    </div>
  );
}
