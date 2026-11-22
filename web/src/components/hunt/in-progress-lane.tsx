// hunt: the "In progress" lane pinned above the ranked list on Jobs and Home. Tracker rows that
// are Applied, Responded, Assessment, Interview or Offer (inProgress in hunt-home-v2.mjs), each
// linking to its tracker row, so a row with no posting URL still opens.
import Link from "next/link";
import { daysSince } from "@/lib/hunt-home-v2.mjs";
import { cn } from "@/lib/cn";

export type InProgressRow = { n: string; company: string; role: string; status: string; updated: string; next?: string };

export const STAGE_PILL: Record<string, string> = {
  Offer: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  Interview: "bg-violet-500/15 text-violet-800 dark:text-violet-300",
  Assessment: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  Responded: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  Applied: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  Speculative: "bg-pink-500/15 text-pink-800 dark:text-pink-300",
};

export function InProgressRows({ rows, limit = 6 }: { rows: InProgressRow[]; limit?: number }) {
  return (
    <ul className="-mx-1 divide-y divide-border">
      {rows.slice(0, limit).map((r) => {
        const d = daysSince(r.updated);
        return (
          <li key={r.n} className="tap-row flex min-h-[44px] items-center gap-2 rounded-md px-1 py-1.5">
            <Link href={`/pipeline/${encodeURIComponent(r.n)}`} className="row-link min-w-0 flex-1">
              <span className="block truncate text-sm"><span className="font-medium text-foreground">{r.company}</span><span className="text-muted"> · {r.role}</span></span>
              <span className="block truncate text-xs text-muted">{r.next ? `Next: ${r.next}` : "No next step"}</span>
            </Link>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", STAGE_PILL[r.status] ?? "bg-surface-hover text-muted")}>{r.status}</span>
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-faint" title="Days since last update">{d == null ? "" : `${d}d`}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The Jobs page version: a compact card above the ranked list; nothing when no row is in progress. */
export function InProgressLane({ rows }: { rows: InProgressRow[] }) {
  if (!rows.length) return null;
  return (
    <section aria-label="In progress" className="mx-auto max-w-3xl px-4 pt-3 sm:px-6">
      <div className="rounded-xl border border-border bg-surface/40 p-3 sm:p-4">
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">In progress <span className="font-normal tabular-nums text-faint">{rows.length}</span></h2>
          <Link href="/tracker" className="inline-flex min-h-[32px] items-center text-xs text-muted hover:text-foreground">View tracker</Link>
        </div>
        <InProgressRows rows={rows} limit={8} />
      </div>
    </section>
  );
}
