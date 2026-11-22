"use client";
// hunt: Home's "Today's study": today's day from data/study/days.md, its theme and the next
// three unticked items (LeetCode problems and design prompts linked). Same store as /study
// (data/study-state.json via /api/profile/study), so ticks sync both ways.
import { useState } from "react";
import Link from "next/link";
import { DayItems, type Prompt, type StudyDayT } from "@/components/hunt/study-v2";

export function StudyToday({ day, initialTicks, prompts, flagged }: { day: StudyDayT | null; initialTicks: Record<string, true>; prompts: Prompt[]; flagged: number }) {
  const [ticks, setTicks] = useState<Record<string, boolean>>(initialTicks);
  const [error, setError] = useState(false);
  const onTick = async (id: string, value: boolean) => {
    setTicks((t) => ({ ...t, [id]: value }));
    setError(false);
    try {
      const res = await fetch("/api/profile/study", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "tick", id, value }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setTicks((t) => ({ ...t, [id]: !value }));
      setError(true);
    }
  };
  const left = day ? day.items.filter((i) => !ticks[i.id]).length : 0;
  return (
    <div>
      {day ? (
        <>
          <p className="text-xs text-faint">
            {day.fast ? day.title : `Day ${day.n}`}{day.theme && !day.fast ? ` · ${day.theme}` : ""}
            <span className="ml-1 tabular-nums">· {day.items.length - left}/{day.items.length}</span>
          </p>
          <DayItems day={day} ticks={ticks} onTick={(id, v) => void onTick(id, v)} prompts={prompts} limit={3} />
          {left > 3 && <p className="pl-[30px] text-xs text-faint">+{left - 3} more today</p>}
        </>
      ) : (
        <p className="text-sm text-muted">All study days done.</p>
      )}
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">Couldn&apos;t save that tick. Try again.</p>}
      <p className="mt-1 flex items-center gap-4 text-xs text-muted">
        <span>{flagged} card{flagged === 1 ? "" : "s"} flagged</span>
        <Link href="/study" className="inline-flex min-h-[44px] items-center font-medium text-brand-text hover:underline">Study home</Link>
        <Link href="/study/cards" className="inline-flex min-h-[44px] items-center font-medium text-brand-text hover:underline">Cards</Link>
      </p>
    </div>
  );
}
