"use client";

import Link from "next/link";
import { Bookmark, BookmarkCheck, Loader2, X, CirclePause } from "lucide-react";
import type { InboxJob } from "@/lib/career-ops";
import type { AtsSource } from "@/lib/explore";
import { ATS_LABEL } from "@/lib/explore";
import { unscoredInboxHref } from "@/lib/posting-url.mjs";
import { rowTarget } from "./triage-row-target.mjs"; // hunt
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { cn } from "@/lib/cn";
import { inboxScoreTarget } from "@/lib/inbox-score-target.mjs";
// hunt: ranking badges from data/hunt-enrich.json
import { CardMeta, RankBadges } from "@/components/hunt/rank-badges";
import { ReferralIconLink } from "@/components/hunt/referral-links";
import { StarButton } from "@/components/hunt/star-button"; // hunt: starred companies (filter only)
import type { HuntEnrichment } from "@/lib/hunt-types";

// hunt: where a row click goes (report, else the job's detail page): ./triage-row-target.mjs
export { rowTarget } from "./triage-row-target.mjs";

export type RowScore = { score: number | null; tone: "good" | "warn" | "bad" | "muted"; jobId: string; running: boolean; reportN?: number | null; needsReview?: boolean };

function agoLabel(age: number | null): string | null {
  if (age == null) return null;
  if (age <= 0) return "today";
  if (age === 1) return "yesterday";
  if (age < 7) return `${age}d ago`;
  if (age < 30) return `${Math.floor(age / 7)}w ago`;
  return `${Math.floor(age / 30)}mo ago`;
}

// One raw posting in the triage list. Shows ONLY cheap, free signals + an honest
// "not scored" (CRUDA) — never a fake match%. Once its shortlist eval finishes it
// flips to EVALUADA (a real A–F badge). Save→shortlist / Skip→hidden are free + undoable.
export function TriageRow({
  index,
  cursor,
  job,
  source,
  age,
  reason,
  scored,
  selected,
  shortlisted,
  onToggleSelect,
  onSave,
  onSkip,
  similar = 0,
  similarOpen = false,
  onToggleSimilar,
  isSimilar = false,
  starred,
  onToggleStar,
}: {
  index: number;
  cursor: boolean;
  job: InboxJob;
  source: AtsSource | null;
  age: number | null;
  reason?: string;
  scored?: RowScore;
  selected: boolean;
  shortlisted: boolean;
  onToggleSelect: () => void;
  onSave: () => void;
  onSkip: () => void;
  similar?: number;
  similarOpen?: boolean;
  onToggleSimilar?: () => void;
  isSimilar?: boolean;
  starred?: boolean;
  onToggleStar?: (company: string, next: boolean) => void;
}) {
  const ago = agoLabel(age);
  const target = inboxScoreTarget(scored);
  const evaluated = target.evaluated;
  const postingHref = unscoredInboxHref(job.url, evaluated);
  // hunt: the whole row opens the JOB: its evaluation report when there is one, else the
  // posting. Never a worker page (/jobs/…): "Needs review" and "Scoring…" keep their own links.
  const rowHref = rowTarget(target.href, job.url);
  const rowExternal = rowHref != null && !rowHref.startsWith("/");
  // hunt: line 1 is "#N" (Best overall) + Company · Role; line 2 one meta line; one chip at most.
  const tr = (job as InboxJob & { hunt?: HuntEnrichment | null }).hunt ?? null;
  const title = (
    <>
      {tr?.rankNo != null && <span className="mr-1.5 font-semibold tabular-nums text-brand-text">#{tr.rankNo}</span>}
      <span className="font-medium text-foreground">{job.company}</span>
      <span className="text-muted"> · {(job as InboxJob & { hunt?: HuntEnrichment | null }).hunt?.displayRole ?? job.role}</span>
    </>
  );

  return (
    <li
      data-triage-index={index}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2.5 transition-colors sm:gap-3 sm:px-4",
        rowHref && "tap-row",
        selected ? "bg-brand-soft/50" : "hover:bg-surface-hover",
        cursor && "ring-2 ring-inset ring-brand",
        isSimilar && "pl-8 sm:pl-10 opacity-90",
        evaluated && "opacity-95",
      )}
    >
      {/* multi-select — power-user batch to shortlist */}
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${job.company} ${job.role}`}
        className="row-above size-4 shrink-0 accent-brand max-sm:min-h-[44px] max-sm:min-w-[24px]"
      />

      <CompanyLogo name={job.company} size={20} />
      {onToggleStar && <StarButton company={job.company} starred={starred ?? false} onToggle={onToggleStar} />}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          {rowHref && rowExternal ? (
            <a href={rowHref} target="_blank" rel="noreferrer" className="row-link hover:text-brand-text">
              {title}
            </a>
          ) : rowHref ? (
            <Link href={rowHref} className="row-link hover:text-brand-text">
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        {tr ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-faint">
            <CardMeta e={tr} age={ago} />
            <ReferralIconLink company={job.company} />
          </p>
        ) : (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          {job.location && <span className="truncate">{job.location}</span>}
          {source && <span className="rounded bg-surface-hover px-1 py-px font-medium text-muted">{ATS_LABEL[source]}</span>}
          {ago && <span>{ago}</span>}
          {reason ? <span className="text-muted">{reason}</span> : null}
          {!evaluated && <span className="italic text-muted">not scored</span>}
          <ReferralIconLink company={job.company} />
        </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 empty:hidden">
          <RankBadges e={tr} />
          {similar > 0 && onToggleSimilar && (
            <button type="button" onClick={onToggleSimilar} aria-expanded={similarOpen} className="tap-44 text-[11px] font-medium text-brand-text hover:underline">
              {similarOpen ? "hide similar" : `+${similar} similar`}
            </button>
          )}
        </div>
      </div>

      {/* EVALUADA state (right-aligned, visually distinct from raw rows) */}
      {scored?.needsReview ? (
        <div className="row-above flex shrink-0 items-center gap-2">
          <Link href={`/jobs/${scored.jobId}`} className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-400 max-sm:min-h-[44px]">
            <CirclePause className="size-3.5" /> Needs review
          </Link>
          <button
            type="button"
            onClick={onSkip}
            title="Skip — hide from the inbox"
            aria-label={`Skip ${job.company} ${job.role}`}
            className="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : evaluated && target.href ? (
        <Link href={target.href} className="row-above flex shrink-0 items-center justify-center gap-1.5 text-xs max-sm:min-h-[44px] max-sm:min-w-[44px]">
          {scored!.running ? (
            <>
              <Loader2 className="size-3.5 animate-spin text-brand-text" />
              <span className="text-brand-text max-sm:hidden">Scoring…</span>
            </>
          ) : target.showScore ? (
            <Badge tone={scored!.tone}>{scored!.score}/5</Badge>
          ) : (
            <span className="text-brand-text">Report</span>
          )}
        </Link>
      ) : (
        <div className="row-above flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onSave}
            title={shortlisted ? "In your shortlist" : "Save to shortlist"}
            aria-pressed={shortlisted}
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] max-sm:min-w-[44px]",
              shortlisted ? "text-brand-text" : "text-muted hover:bg-surface-hover hover:text-brand-text",
            )}
          >
            {shortlisted ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}
            <span className="max-sm:hidden">{shortlisted ? "Saved" : "Save"}</span>
          </button>
          <button
            type="button"
            onClick={onSkip}
            title="Skip — hide from the inbox"
            className="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </li>
  );
}
