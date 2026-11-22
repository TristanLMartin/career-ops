// Ranking badges for an inbox row.
// Shows composite, pay, location tier, relevance, fit and benefit count.
import { Badge } from "@/components/ui/badge";
import { BENEFIT_LABELS, LOCATION_TIER_LABEL, formatPayWithTc, type HuntBenefits, type HuntEnrichment } from "@/lib/hunt-types";

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

export function RankBadges({ e }: { e: HuntEnrichment | null | undefined }) {
  if (!e) return null;
  const pay = formatPayWithTc(e.pay, e.tc_est);
  const benefits = e.benefits ? (Object.entries(e.benefits) as [keyof HuntBenefits, boolean][]).filter(([, v]) => v).map(([k]) => BENEFIT_LABELS[k]) : [];
  const tierTone = e.locationTier === 1 ? "good" : e.locationTier === 2 ? "info" : e.locationTier === 3 ? "warn" : "muted";
  return (
    <span className="flex flex-wrap items-center gap-1" data-hunt-badges>
      {e.origin === "discovery" && <Badge tone="info" title={`Found outside your watchlist${e.channel ? ` via ${channelLabel(e.channel)}` : ""}`}>{e.channel ? `Discovery · ${channelLabel(e.channel)}` : "Discovery"}</Badge>}
      {e.origin === "manual" && <Badge tone="info" title="You added this one">Added by you</Badge>}
      {e.h2h_rank != null && (
        <Badge tone={e.h2h_rank <= 20 ? "good" : "info"} title={e.h2hVia === "group" ? "Head-to-head rank of a similar role at this company (Sonnet tournament, Borda count)" : `Sonnet head-to-head tournament rank (3 shuffled rounds, Borda count)${e.h2hWhy ? `: ${e.h2hWhy}` : ""}`}>
          Head-to-head #{e.h2h_rank}{e.h2hVia === "group" ? " (group)" : ""}
        </Badge>
      )}
      {e.caution && <Badge tone="warn" title="Caution: recent layoffs at this company (research list)">Caution: layoffs</Badge>}
      {e.belowFloor && <Badge tone="bad" title={`Posted base tops out below your ${floorText(e.floor)} floor (config/ranking.yml base_floor). Pay scores 0 and it stays off the Shortlist.`}>Below {floorText(e.floor)} floor</Badge>}
      {e.identityUnverified && <Badge tone="warn" title="Company identity not verified: confirm who the employer is before applying">Company unverified</Badge>}
      {e.composite != null && (
        <Badge tone={tone(e.composite)} title="Composite rank score (config/ranking.yml)">
          Rank {Math.round(e.composite)}
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
