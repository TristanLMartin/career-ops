"use client";
// hunt: star a company (data/hunt-stars.json via /api/profile/stars). A star is only a
// Jobs filter ("Starred only"); it never changes the ranking.
// Controlled (the Jobs list passes `starred` + `onToggle`) or standalone (the job page): with no
// `starred` prop it loads the list itself.
import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/cn";
import { isStarred, starKeys } from "@/lib/hunt-stars.mjs";

export async function postStar(company: string, starred: boolean): Promise<string[] | null> {
  try {
    const res = await fetch("/api/profile/stars", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company, starred }) });
    if (!res.ok) return null;
    return ((await res.json()) as { companies: string[] }).companies;
  } catch {
    return null;
  }
}

export function StarButton({ company, starred, onToggle, className }: { company: string; starred?: boolean; onToggle?: (company: string, next: boolean) => void; className?: string }) {
  const controlled = starred !== undefined;
  const [own, setOwn] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (controlled) return;
    let live = true;
    fetch("/api/profile/stars", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { companies: [] }))
      .then((d: { companies?: string[] }) => { if (live) setOwn(isStarred(starKeys(d.companies ?? []), company)); })
      .catch(() => { if (live) setOwn(false); });
    return () => { live = false; };
  }, [controlled, company]);
  const on = controlled ? starred : own === true;
  const toggle = async () => {
    setFailed(false);
    if (controlled) { onToggle?.(company, !on); return; }
    setOwn(!on);
    const saved = await postStar(company, !on);
    if (!saved) { setOwn(on); setFailed(true); }
  };
  const label = on ? `Unstar the company ${company}` : `Star the company ${company} (all its jobs)`;
  return (
    <button
      type="button"
      onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); void toggle(); }}
      aria-pressed={on}
      aria-label={label}
      title={failed ? "Couldn't save the star; try again" : on ? `${company} is a starred company: all its jobs show under Starred companies. Click to unstar.` : `Star the company ${company}: all its jobs show under Starred companies`}
      className={cn("tap-44 inline-flex size-5 shrink-0 items-center justify-center rounded text-faint hover:text-amber-800 dark:hover:text-amber-400", on && "text-amber-800 dark:text-amber-400", failed && "text-red-700 dark:text-red-400", className)}
    >
      <Star className="size-4" fill={on ? "currentColor" : "none"} />
    </button>
  );
}
