// Home: the job search at a glance, in five compact blocks.
// 1 Needs you · 2 In progress · 3 Today's study · 4 New since you last looked · 5 a one-line footer.
// Server component; reads local files only (plus data/home-last-visit.json, which it updates).
// Every row is fully tappable (stretched link). No names are hard-coded here.
import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import type { ReactNode } from "react";
import { readInbox } from "@/lib/career-ops";
import { pendingInbox } from "@/lib/inbox-pending.mjs";
import { readScanRuns } from "@/lib/hunt-data";
import { loadHomeSections } from "@/lib/hunt-home-data";
import { lastScanAt, weekCost } from "@/lib/hunt-home-v2.mjs";
import { normalizeState } from "@/lib/hunt-study.mjs";
import { currentDay, designPromptIndex, parseDays } from "@/lib/hunt-study-days.mjs";
import type { Prompt, StudyDayT } from "@/components/hunt/study-v2";
import { shortWhen } from "@/lib/hunt-message-kinds.mjs";
import type { HuntEnrichment } from "@/lib/hunt-types";
import { StudyToday } from "@/components/hunt/study-today";
import { HomeVisit } from "@/components/hunt/home-visit";
import { InProgressRows } from "@/components/hunt/in-progress-lane";
import { cn } from "@/lib/cn";
import { readSpotchecks } from "@/lib/hunt-model-runs.mjs";

type Ranked = HuntEnrichment & { url: string; rank: number };
type Row = { n: string; company: string; role: string; status: string; updated: string; next: string };

function read(root: string, rel: string): string {
  try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return ""; }
}

const k = (n: number) => `$${Math.round(n / 1000)}k`;
function shortPay(e: HuntEnrichment): string {
  if (e.pay && e.pay.period === "year") return e.pay.annualMin === e.pay.annualMax ? k(e.pay.annualMin) : `${k(e.pay.annualMin)}–${k(e.pay.annualMax).slice(1)}`;
  if (e.tc_est) return `~${k(e.tc_est.usd)} TC`;
  return "";
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface/40 p-3 sm:p-4" aria-label={title}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function RowLink({ href, external, children, className }: { href: string; external?: boolean; children: ReactNode; className?: string }) {
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className={cn("row-link", className)}>{children}</a>
  ) : (
    <Link href={href} className={cn("row-link", className)}>{children}</Link>
  );
}

export function HuntHome() {
  const { root, applications, needs, progress: progressRows, fresh: freshRows } = loadHomeSections();
  const flying = progressRows as Row[];
  const fresh = freshRows as Ranked[];

  const md = read(root, "data/study/days.md");
  let study = normalizeState({});
  try { study = normalizeState(JSON.parse(read(root, "data/study-state.json"))); } catch { /* fresh */ }
  const daysDoc = parseDays(read(root, "data/study/days.md"));
  const today = currentDay(daysDoc.days, study.ticks, { fastTrack: study.fastTrack }) as StudyDayT | null;
  const prompts = designPromptIndex(read(root, "data/study/design-prompts.md")) as Prompt[];

  const scanAt = lastScanAt(readScanRuns(root));
  const inboxCount = pendingInbox(readInbox(applications)).length;
  const cost = weekCost(read(root, "data/hunt-usage.tsv"));
  const spot = readSpotchecks(root); // hunt: Opus spot-checks of lite scores (comparison only)

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 sm:px-6 sm:py-6">
      <h1 className="sr-only">Home</h1>
      <HomeVisit />

      <Card title="Needs you" right={needs.length > 0 ? <span className="text-xs tabular-nums text-faint">{needs.length}</span> : null}>
        {needs.length === 0 ? (
          <p className="py-1 text-sm text-muted">Nothing needs you right now.</p>
        ) : (
          <ul className="-mx-1 max-h-none divide-y divide-border">
            {needs.slice(0, 6).map((n: { id: string; label: string; detail: string; action: string; href: string; external?: boolean }, i: number) => (
              <li key={n.id} className={cn("tap-row flex min-h-[44px] items-center gap-3 rounded-md px-1 py-1.5", i >= 4 && "max-sm:hidden")}>
                <RowLink href={n.href} external={n.external} className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{n.label}</span>
                  <span className="block truncate text-xs text-muted">{n.detail}</span>
                </RowLink>
                <span className="shrink-0 text-xs font-medium text-brand-text">{n.action}</span>
              </li>
            ))}
            {needs.length > 4 && (
              <li className={cn("px-1 pt-1.5 text-xs text-faint", needs.length <= 6 && "sm:hidden")}>
                <span className="sm:hidden">+{needs.length - 4}</span><span className="max-sm:hidden">+{needs.length - 6}</span> more on{" "}
                <Link href="/inbox" className="text-muted underline-offset-2 hover:underline">Inbox</Link>
              </li>
            )}
          </ul>
        )}
      </Card>

      <Card title="In progress" right={flying.length > 0 ? <Link href="/tracker" className="inline-flex min-h-[32px] items-center text-xs text-muted hover:text-foreground">View tracker</Link> : null}>
        {flying.length === 0 ? (
          <p className="py-1 text-sm text-muted">Nothing in progress yet.</p>
        ) : (
          <InProgressRows rows={flying} limit={6} />
        )}
        {flying.length > 6 && <Link href="/tracker" className="mt-1 inline-flex min-h-[44px] items-center text-xs text-muted hover:text-foreground">View tracker ({flying.length})</Link>}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Today's study">
          {md ? (
            <StudyToday day={today} initialTicks={study.ticks} prompts={prompts} flagged={Object.keys(study.flags).length} />
          ) : (
            <p className="py-1 text-sm text-muted">No study plan yet.</p>
          )}
        </Card>

        <Card title="New since you last looked · by Rank" right={fresh.length > 0 ? <Link href="/pipeline?sort=newest" className="inline-flex min-h-[32px] items-center text-xs text-muted hover:text-foreground">See all</Link> : null}>
          {fresh.length === 0 ? (
            <p className="py-1 text-sm text-muted">Nothing new in the top 100 since your last visit.</p>
          ) : (
            <ul className="-mx-1 divide-y divide-border">
              {fresh.slice(0, 5).map((e) => {
                const score = e.fit ?? e.quick_score;
                return (
                  <li key={e.url} className="tap-row flex min-h-[44px] items-center gap-2 rounded-md px-1 py-1.5">
                    <RowLink href={e.report?.tracker ? `/pipeline/${e.report.tracker}` : `/pipeline/posting?url=${encodeURIComponent(e.url)}`} className="min-w-0 flex-1">
                      <span className="block truncate text-sm"><span className="font-medium text-foreground">{e.company}</span><span className="text-muted"> · {e.displayRole ?? e.role}</span></span>
                      <span className="block truncate text-xs text-faint">#{e.rank}{shortPay(e) ? ` · ${shortPay(e)}` : ""}</span>
                    </RowLink>
                    {score != null && <span className="shrink-0 text-xs font-medium tabular-nums text-muted">{score}/5</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <p className="px-1 text-[11px] text-faint" suppressHydrationWarning>
        {scanAt ? `Last scan ${shortWhen(scanAt)}` : "No scan yet"} · {inboxCount.toLocaleString("en-US")} in inbox · <Link href="/jobs" className="hover:text-brand-text hover:underline">${cost.toFixed(2)} this week</Link>
      </p>
      {spot && (
        <p className={cn("px-1 text-[11px]", spot.warn ? "text-amber-800 dark:text-amber-400" : "text-faint")}>
          Opus spot-checks: {spot.n} job{spot.n === 1 ? "" : "s"}, avg gap {spot.meanAbsGap.toFixed(2)}
          {spot.warn ? " (over 0.5: lite scores are drifting from Opus, worth a look)" : ""}
        </p>
      )}
    </div>
  );
}
