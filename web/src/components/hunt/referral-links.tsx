// hunt: "Who do I know here?" — LinkedIn people-search links (1st / 2nd degree) for a company.
// Plain links you click yourself; nothing is fetched or automated.
import { Users } from "lucide-react";
import { cn } from "@/lib/cn";
import { referralLinks } from "@/lib/hunt-referrals.mjs";

/** Job detail page: "1st-degree at <Company>" · "2nd-degree", in the page's existing link style. */
export function ReferralLinks({ company, className }: { company: string | null | undefined; className?: string }) {
  const r = referralLinks(company);
  if (!r) return null;
  const cls = "tap-44 inline-flex items-center gap-1 text-brand-text hover:underline max-sm:min-h-[44px]";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3", className)}>
      <Users aria-hidden className="size-3 text-faint" />
      <a href={r.first.url} target="_blank" rel="noreferrer" className={cls} title="Your LinkedIn connections who mention this company">
        {r.first.label}
      </a>
      <a href={r.second.url} target="_blank" rel="noreferrer" className={cls} title={`${r.second.label}: 2nd-degree connections at ${r.company}`}>
        2nd-degree
      </a>
    </span>
  );
}

/** Jobs list rows: one quiet icon link to 1st-degree connections at the company. */
export function ReferralIconLink({ company, className }: { company: string | null | undefined; className?: string }) {
  const r = referralLinks(company);
  if (!r) return null;
  return (
    <a
      href={r.first.url}
      target="_blank"
      rel="noreferrer"
      title={`Who do I know here? ${r.first.label} (LinkedIn)`}
      aria-label={`Who do I know here? ${r.first.label} on LinkedIn`}
      data-referral-link="first"
      className={cn("tap-44 inline-flex shrink-0 items-center justify-center rounded p-0.5 text-faint transition-colors hover:text-brand-text", className)}
    >
      <Users aria-hidden className="size-3" />
    </a>
  );
}
