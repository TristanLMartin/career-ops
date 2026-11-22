"use client";
// hunt: Done / Ignore (and Undo) for one follow-up, as plain text buttons. Saved in
// data/message-marks.json under "opp:<key>". Nothing is ever sent.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function FollowupActions({ oppKey, lastDate, mark }: { oppKey: string; lastDate: string; mark: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const set = async (value: "done" | "wont" | null) => {
    setBusy(true); setError(false);
    try {
      const res = await fetch("/api/profile/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "mark", id: `opp:${oppKey}`, mark: value, lastDate }) });
      if (!res.ok) throw new Error(String(res.status));
      if (value) router.push("/followups"); else router.refresh();
    } catch { setError(true); } finally { setBusy(false); }
  };
  const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border px-5 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {mark ? (
        <>
          <span className="text-sm text-muted">{mark === "done" ? "Marked done" : "Ignored"}.</span>
          <button type="button" disabled={busy} onClick={() => void set(null)} className={btn}>Undo</button>
        </>
      ) : (
        <>
          <button type="button" disabled={busy} onClick={() => void set("done")} className={btn}>Done</button>
          <button type="button" disabled={busy} onClick={() => void set("wont")} className={btn}>Ignore</button>
        </>
      )}
      {error && <span role="alert" className="text-xs text-red-700 dark:text-red-400">Couldn&apos;t save. Try again.</span>}
    </div>
  );
}
