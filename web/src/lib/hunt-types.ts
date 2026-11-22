// Shared, client-safe types for the dashboard additions.
// The data comes from data/hunt-enrich.json and data/hunt-messages.jsonl,
// written by scripts/hunt-enrich.mjs and scripts/hunt-messages-sync.mjs.

export type HuntPay = {
  min: number;
  max: number;
  currency: string;
  period: "hour" | "year";
  annualMin: number;
  annualMax: number;
  from: "stored" | "description";
  /** "base" or "OTE"; equity and bonus are never included. */
  basis?: "base" | "OTE";
  band?: string;
};

export type HuntBenefits = {
  k401_match: boolean;
  equity: boolean;
  remote_stipend: boolean;
  parental_leave: boolean;
  health_full: boolean;
  bonus: boolean;
};

export type HuntEnrichment = {
  company: string;
  role: string;
  location: string;
  status: string | null;
  pay: HuntPay | null;
  locationTier: 1 | 2 | 3 | 4 | 5 | null;
  benefits: HuntBenefits | null;
  relevance: number | null;
  /** The JD was missing or thin, so relevance is a title-only estimate. */
  relevanceEst?: boolean;
  /** Level key from the profile's ladder (built-in IC ladder: senior, mid, dual, stretch, staff, staffplus). */
  level?: { key: string; label: string; factor: number } | null;
  fit: number | null;
  report?: { n: string | null; tracker: string; decision: string; why: string; gap: string; strength: string; nextAction: string } | null;
  source?: "inbox" | "tracker";
  /** Duplicate group: company + base title. The leader is the best-ranked member. */
  group?: string;
  groupSize?: number;
  groupLeader?: boolean;
  /** Leader of a group that passes the Shortlist rules. */
  shortlist?: boolean;
  /** Every member of a group that passes the Shortlist rules. */
  groupShortlist?: boolean;
  domains?: string[];
  /** watchlist (portals.yml), discovery (HN / discovered boards) or manual (added by hand). */
  origin?: "watchlist" | "discovery" | "manual";
  /** Discovery sub-source: hn, dice, indeed, yc, recruiter, vc-getro, vc-greylock, builtin, funding-geekwire, … */
  channel?: string;
  /** Role pulled out of an HN "Who is hiring?" header, when the title is the whole header. */
  displayRole?: string;
  contract?: boolean;
  parts: Record<"fit" | "relevance" | "pay" | "location" | "benefits" | "level", number | null> & { company?: number | null };
  /** Estimated total comp from config/comp.json (company senior TC, scaled by this posting's base). */
  tc_est?: { usd: number; rankUsd: number; basis: string; confidence: "low" | "medium" | "high"; range: [number, number] | null; equityType: string | null; levelEquiv?: string | null; privateEquity: boolean; homeAdjusted: boolean; source: string };
  /** Posted USD base band tops out below config/ranking.yml base_floor. */
  belowFloor?: boolean;
  /** The base_floor that belowFloor was judged against. */
  floor?: number;
  /** Location tier name from config/ranking.yml location_labels. */
  locationLabel?: string;
  /** DOL H-1B LCA senior base for the company (data/comp-lca-summary.json); estTc = base x curated TC/base ratio. */
  lca?: { base: number; n: number; where: string; basis: string; estTc: number | null; ratio: number | null };
  /** Company identity not verified (config/ranking.yml unverified_companies). */
  identityUnverified?: boolean;
  /** What the pay part scored: the posting's base midpoint or tc_est. */
  payFrom?: "base" | "tc";
  companyTier?: 1 | 2 | 3 | 4;
  companyStage?: string;
  stabilityNote?: string;
  /** Flat composite points from company_boost in config/ranking.yml. */
  boost?: number;
  composite: number | null;
  hasDescription: boolean;
  /** "group": fit inherited from the group's representative (scored via group). */
  fitVia?: "group";
  fitFrom?: string;
  /** Sonnet head-to-head Borda rank (data/hunt-h2h.json), 1 = best; h2hVia "group" when inherited. */
  h2h_rank?: number;
  h2hVia?: "group";
  h2hWhy?: string;
  /** Research-list company factor (config/ranking.yml research_tier). */
  researchTier?: number;
  /** Quick 1-5 Haiku score (scripts/hunt-quickscore.mjs) and its one-line reason. */
  quick_score?: number;
  quick_why?: string;
  /** Caution flag (recent layoffs), config caution_companies. */
  caution?: boolean;
};

export type HuntRankKey = "true" | "composite" | "pay" | "relevance" | "location" | "fit" | "benefits" | "level";

export const HUNT_RANK_KEYS: { key: HuntRankKey; label: string }[] = [
  { key: "true", label: "True rank" },
  { key: "composite", label: "Composite" },
  { key: "fit", label: "Fit" },
  { key: "level", label: "Level" },
  { key: "relevance", label: "Relevance" },
  { key: "pay", label: "Pay" },
  { key: "location", label: "Location" },
  { key: "benefits", label: "Benefits" },
];

export const BENEFIT_LABELS: Record<keyof HuntBenefits, string> = {
  k401_match: "401k match",
  equity: "Equity",
  remote_stipend: "Remote stipend",
  parental_leave: "Parental leave",
  health_full: "100% health",
  bonus: "Bonus",
};

// Fallback tier names; hunt-enrich writes each job's locationLabel from config/ranking.yml location_labels.
export const LOCATION_TIER_LABEL: Record<number, string> = { 1: "Home area", 2: "Remote US", 3: "Secondary area", 4: "Other", 5: "Remote (global)" };

export type HuntMessage = {
  threadId: string;
  messageId?: string;
  from: string;
  fromName?: string;
  company: string | null;
  subject: string;
  snippet: string;
  date: string;
  lastFromMe: boolean;
  label?: string;
  link: string;
  messageCount?: number;
  /** Sender looks automated (no-reply, ATS receipt, digest): never "needs reply". */
  automated?: boolean;
  /** "linkedin": a LinkedIn message notification; reply on LinkedIn, not by email. */
  replyVia?: "linkedin";
  /** Secondary source, e.g. "linkedin-manual" (data/hunt-messages.<source>.jsonl). */
  source?: string;
  /** Unanswered lists: always counts as needing a reply. */
  needsReplyOverride?: boolean;
  priority?: "high" | "medium" | "low";
  /** Scheduled-meeting mail (Calendly, Paraform, calendar invite). */
  meeting?: boolean;
  /** Found by the v2 feed's inbox-wide recruiting search (label search:recruiting). */
  search?: boolean;
  /** Set by autoClear: a LinkedIn item answered by a Gmail reply or a scheduled meeting. */
  answeredVia?: "email" | "meeting";
  answeredAt?: string;
  subtitle?: string | null;
  note?: string | null;
};

export function rankValue(e: HuntEnrichment | null | undefined, key: HuntRankKey): number | null {
  if (!e) return null;
  // Fit dominates: a fit-scored role always sorts above unscored ones on the composite.
  // Then real relevance beats a title-only estimate (missing or thin JD) at the same fit status.
  const est = e.relevanceEst && e.fit == null;
  // True rank: the Sonnet head-to-head order for the top ~100, then composite below them.
  if (key === "true") {
    if (e.h2h_rank != null && e.h2hVia !== "group") return 10000 - e.h2h_rank;
    return e.composite == null ? null : (e.fit != null ? 2000 : 0) + (est ? 0 : 1000) + e.composite;
  }
  if (key === "composite") return e.composite == null ? null : (e.fit != null ? 2000 : 0) + (est ? 0 : 1000) + e.composite;
  if (key === "relevance") return e.parts?.relevance == null ? null : (est ? 0 : 1000) + e.parts.relevance;
  return e.parts?.[key] ?? null;
}

/** "base $X–Y · est. TC ~$Z (levels.fyi-style estimate, confidence)", or just the base. */
export function formatPayWithTc(pay: HuntPay | null | undefined, tc: HuntEnrichment["tc_est"]): string | null {
  const base = formatPay(pay);
  const est = tc ? `est. TC ~$${Math.round(tc.usd / 1000)}k (${[`${tc.confidence} confidence`, tc.privateEquity ? "private equity" : null].filter(Boolean).join(", ")})` : null;
  return [base, est].filter(Boolean).join(" · ") || null;
}

export function formatPay(pay: HuntPay | null | undefined): string | null {
  if (!pay) return null;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const cur = pay.currency === "USD" ? "$" : `${pay.currency} `;
  const basis = pay.basis === "OTE" ? "OTE" : "base";
  if (pay.period === "hour") return `${basis} ${cur}${pay.min}–${pay.max}/hr`;
  return pay.annualMin === pay.annualMax ? `${basis} ${cur}${k(pay.annualMin)}` : `${basis} ${cur}${k(pay.annualMin)}–${k(pay.annualMax)}`;
}
