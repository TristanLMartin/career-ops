// hunt: a Jobs card shows only "#N" (Best overall), one meta line (fit, pay, place, age) and at
// most one warning chip (RankBadges). Everything else (relevance, the composite score, the
// head-to-head, benefits, level) lives on the job page under "Why this rank" (WhyThisRank).
import { Badge } from "@/components/ui/badge";
import { BENEFIT_LABELS, LOCATION_TIER_LABEL, formatPayWithTc, type HuntBenefits, type HuntEnrichment } from "@/lib/hunt-types";
import { fitLabel, placeLabel, ratingLabel, shortPay, stretchLabel, warningChip } from "@/lib/hunt-rank-order.mjs";

function tone(v: number | null | undefined): "good" | "warn" | "bad" | "muted" {
  if (v == null) return "muted";
  if (v >= 70) return "good";
  if (v >= 45) return "warn";
  return "bad";
}

const CHANNEL_LABELS: Record<string, string> = {
  hn: "HN", dice: "Dice", indeed: "Indeed", yc: "YC", recruiter: "Recruiter", "vc-getro": "VC board",
  "vc-a16z-speedrun": "a16z speedrun", "vc-a16z": "a16z", "vc-greylock": "Greylock", "vc-portfolio": "VC",
  builtin: "Built In", target: "Target company", "funding-geekwire": "GeekWire funding", "funding-techcrunch": "TechCrunch funding", manual: "Manual",
};
const floorText = (n?: number | null) => (n && n > 0 ? `$${Math.round(n / 1000)}k` : "your");

export function channelLabel(c: string): string {
  return CHANNEL_LABELS[c] ?? c;
}

function lcaNote(e: HuntEnrichment): string {
  const l = e.lca;
  if (!l) return "";
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  const est = l.estTc ? `; est. TC (DOL base × curated ratio ${l.ratio}) ~${k(l.estTc)}` : "";
  return ` DOL H-1B filings: senior base median ${k(l.base)} (${l.where}, n=${l.n}${l.basis.startsWith("generic") ? ", generic titles p75" : ""})${est}.`;
}

/** Card line 2: "Fit 4.2/5 · $172–280k base · ~$570k TC est. · Remote US · 3d ago". */
export function CardMeta({ e, age }: { e: HuntEnrichment; age?: string | null }) {
  const parts = [ratingLabel(e), fitLabel(e), shortPay(e), placeLabel(e), age ?? null].filter(Boolean) as string[];
  const more = e.moreAt;
  return (
    <>
      <span className="min-w-0 truncate" data-card-meta>{parts.join(" · ")}</span>
      {more ? <span className="shrink-0 whitespace-nowrap text-muted" data-more-at title={`Best overall shows at most 2 jobs per company in its top 20; ${more} more ${e.company} job${more === 1 ? "" : "s"} follow below`}>+{more} more at {e.company}</span> : null}
    </>
  );
}

/** The "Stretch" badge for a Staff+ job (job page header), or nothing. */
export function StretchBadge({ e }: { e: HuntEnrichment | null | undefined }) {
  const s = e ? stretchLabel(e) : null;
  return s ? <Badge tone="info" title={s.title} data-stretch>{s.label}</Badge> : null;
}

/** "Stretch" on a Staff+ job, then the one warning chip worth a glance (layoffs, unverified employer, below floor). */
export function RankBadges({ e }: { e: HuntEnrichment | null | undefined }) {
  const chip = e ? warningChip(e) : null;
  const stretch = e ? stretchLabel(e) : null;
  if (!chip && !stretch) return null;
  return (
    <>
      {stretch && <StretchBadge e={e} />}
      {chip && <Badge tone="warn" title={chip.title}>{chip.label}</Badge>}
    </>
  );
}

/** Every ranking signal, for the job page's "Why this rank" and the Add-a-job result. */
export function RankDetails({ e }: { e: HuntEnrichment | null | undefined }) {
  if (!e) return null;
  const pay = formatPayWithTc(e.pay, e.tc_est);
  const benefits = e.benefits ? (Object.entries(e.benefits) as [keyof HuntBenefits, boolean][]).filter(([, v]) => v).map(([k]) => BENEFIT_LABELS[k]) : [];
  const tierTone = e.locationTier === 1 ? "good" : e.locationTier === 2 ? "info" : e.locationTier === 3 ? "warn" : "muted";
  return (
    <span className="flex flex-wrap items-center gap-1" data-hunt-badges>
      {e.origin === "discovery" && <Badge tone="info" title={`Found outside your watchlist${e.channel ? ` via ${channelLabel(e.channel)}` : ""}`}>{e.channel ? `Discovery · ${channelLabel(e.channel)}` : "Discovery"}</Badge>}
      {e.origin === "manual" && <Badge tone="info" title="You added this one">Added by you</Badge>}
      {e.h2h_rank != null && (
        <Badge tone="muted" title={e.h2hVia === "group" ? "Head-to-head place of a similar role at this company" : `Sonnet head-to-head place (only breaks near-ties in Best overall)${e.h2hWhy ? `: ${e.h2hWhy}` : ""}`}>
          Head-to-head place {e.h2h_rank}{e.h2hVia === "group" ? " (group)" : ""}
        </Badge>
      )}
      {e.caution && <Badge tone="warn" title="Caution: recent layoffs at this company (research list)">Caution: layoffs</Badge>}
      {e.belowFloor && <Badge tone="bad" title="Posted base tops out below your floor. It sinks in Best overall and stays off the Shortlist.">Below pay floor</Badge>}
      {e.identityUnverified && <Badge tone="warn" title="Company identity not verified: confirm who the employer is before applying">Company unverified</Badge>}
      {e.composite != null && (
        <Badge tone={tone(e.composite)} title="Composite score 0-100 (config/ranking.yml weights). Not the # rank.">
          Composite {Math.round(e.composite)}/100
        </Badge>
      )}
      {pay && (
        <Badge tone="muted" title={`${e.pay?.basis === "OTE" ? "On-target earnings" : "Base salary"} ${e.pay?.band ? `(${e.pay.band}) ` : ""}from the ${e.pay?.from === "description" ? "job description" : "job board"}. ${e.tc_est ? ` Est. TC: company senior median${e.tc_est.levelEquiv ? ` (${e.tc_est.levelEquiv})` : ""} ${e.tc_est.basis === "company median" ? "(no posting base to scale by)" : "scaled by this posting's base"}${e.tc_est.homeAdjusted ? ", adjusted for your home metro" : ""}${e.tc_est.range ? `, range $${Math.round(e.tc_est.range[0] / 1000)}k–${Math.round(e.tc_est.range[1] / 1000)}k` : ""}${e.tc_est.equityType ? `, ${e.tc_est.equityType}` : ""}.${e.tc_est.privateEquity ? ` Private equity: ranked at ~$${Math.round(e.tc_est.rankUsd / 1000)}k with stock counted at 60%.` : ""}` : " Equity and bonus not included."} Rank uses ${e.payFrom === "tc" ? "est. TC" : "base"}.${lcaNote(e)}`}>
          {pay}
        </Badge>
      )}
      {e.locationTier != null && <Badge tone={tierTone}>{e.locationLabel ?? LOCATION_TIER_LABEL[e.locationTier]}</Badge>}
      {e.level && (
        <Badge
          tone={e.level.factor >= 0.95 ? "good" : e.level.factor >= 0.6 ? "warn" : "bad"}
          title={`Level fit vs your target (config/ranking.yml): ${Math.round(e.level.factor * 100)}/100`}
        >
          {e.level.key === "stretch" ? "Staff-stretch" : e.level.label}
        </Badge>
      )}
      {e.relevance != null && (
        <Badge
          tone={e.relevanceEst ? "muted" : tone(e.relevance)}
          title={e.relevanceEst ? "Estimated from the title only: the job description is missing or thin. Ranked below roles with a real relevance score." : "Keyword relevance to your profile and CV"}
        >
          Rel {e.relevance}{e.relevanceEst ? " est." : ""}
        </Badge>
      )}
      {e.fit != null && <Badge tone={e.fit >= 4 ? "good" : e.fit >= 3.5 ? "warn" : "bad"} title={e.fitVia === "group" ? "Scored via group: this is the fit of the group's representative (a like-for-like role at this company)" : "career-ops evaluation score"}>Fit {e.fit}/5{e.fitVia === "group" ? " via group" : ""}</Badge>}
      {e.quick_score != null && (e.fit == null || e.fitVia === "group") && (
        <Badge tone={e.quick_score >= 4 ? "good" : e.quick_score === 3 ? "warn" : "muted"} title={`Quick score (one short Haiku read of the posting)${e.quick_why ? `: ${e.quick_why}` : ""}`}>
          Quick {e.quick_score}/5
        </Badge>
      )}
      {e.quick_score != null && e.fit != null && e.fitVia !== "group" && (
        <span className="text-[11px] text-faint" title={`Quick score${e.quick_why ? `: ${e.quick_why}` : ""}`}>quick {e.quick_score}</span>
      )}
      {benefits.length > 0 && (
        <Badge tone="muted" title={benefits.join(", ")}>
          Benefits {benefits.length}/6
        </Badge>
      )}
    </span>
  );
}

/**
 * "Why this rank": where the job sits in Best overall and why (the head-to-head place and its
 * deciding reason, or the score fallback), then every other signal. Collapsed; on the job page.
 */
export function WhyThisRank({ e, rank }: { e: HuntEnrichment; rank: number | null }) {
  const inTournament = e.h2h_rank != null && e.h2hVia !== "group";
  return (
    <details className="group rounded-xl border border-border" data-testid="why-this-rank">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 text-sm text-muted hover:text-foreground">
        <span className="transition-transform group-open:rotate-90" aria-hidden>›</span>
        Why this rank{rank != null ? ` (#${rank})` : ""}
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3 text-sm">
        <ul className="space-y-1">
          {inTournament ? (
            <li>Head-to-head place {e.h2h_rank}: Sonnet compared it with other evaluated jobs on offer chance at the level, pay, experience match and location.{e.h2hWhy ? <span className="text-muted"> Deciding reason: {e.h2hWhy}</span> : null}</li>
          ) : (
            <li>Not in the head-to-head yet{typeof e.fit === "number" ? " (it joins at the next head-to-head run or insert)" : " (no full evaluation)"}, so it sits below those jobs, ordered by {typeof e.fit === "number" ? "evaluation, then" : ""} composite score{e.composite != null ? ` ${Math.round(e.composite)}/100` : ""}.</li>
          )}
          <li className="text-muted">{[fitLabel(e), shortPay(e), placeLabel(e)].filter(Boolean).join(" · ")}</li>
          {stretchLabel(e) && <li data-stretch><span className="font-medium">Stretch:</span> <span className="text-muted">{stretchLabel(e)!.title}</span></li>}
        </ul>
        <RankDetails e={e} />
        {e.quick_why && <p className="text-xs text-muted">Quick score: {e.quick_why}</p>}
      </div>
    </details>
  );
}
