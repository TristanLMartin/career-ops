"use client";
// hunt: "Your rating" 1-5 on a job page. Saved to data/hunt-ratings.json (/api/profile/rating);
// Best overall uses it as its strongest signal: 4-5 lifts the job, 1-3 sinks it.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

export function JobRating({ url, rating, note }: { url: string; rating?: number | null; note?: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState<number | null>(rating ?? null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  async function save(next: number | null) {
    const prev = value;
    setValue(next);
    setError("");
    try {
      const res = await fetch("/api/profile/rating", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, rating: next }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      startTransition(() => router.refresh());
    } catch (e) {
      setValue(prev);
      setError(`Not saved: ${(e as Error).message}`);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-job-rating>
      <span className="text-muted">Your rating</span>
      <div role="radiogroup" aria-label="Your rating, 1 to 5" className="inline-flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={pending}
            onClick={() => save(value === n ? null : n)}
            title={value === n ? "Clear your rating" : n >= 4 ? `${n}: good, moves it up in Best overall` : `${n}: meh, moves it down in Best overall`}
            className={cn(
              "tap-44 min-w-7 rounded-md border px-2 py-1 font-medium tabular-nums transition-colors",
              value === n ? "border-brand/50 bg-brand-soft text-brand-text" : "border-border text-muted hover:text-foreground",
            )}
          >
            {n}
          </button>
        ))}
      </div>
      {note ? <span className="text-faint">{note}</span> : null}
      {error ? <span role="alert" className="text-red-700 dark:text-red-400">{error}</span> : null}
    </div>
  );
}
