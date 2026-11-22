"use client";
// hunt: pay line for client-rendered pages (/jobs/[id]); /pipeline/[id] renders it server-side.
import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";

type Pay = { kind: string; posted: string | null; estimated: string | null; text: string };

export function PayLine({ url, className = "" }: { url?: string; className?: string }) {
  const [pay, setPay] = useState<Pay | null>(null);
  useEffect(() => {
    if (!url || !/^https?:\/\//.test(url)) return;
    let live = true;
    fetch(`/api/profile/pay?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => { if (live && p && typeof p.text === "string") setPay(p); })
      .catch(() => {});
    return () => { live = false; };
  }, [url]);
  if (!pay) return null;
  return (
    <p className={`flex items-start gap-1.5 text-sm ${className}`} data-testid="pay-line">
      <Wallet className="mt-0.5 size-3.5 shrink-0 text-faint" />
      {pay.kind === "none" ? (
        <span className="text-muted">Pay not listed</span>
      ) : (
        <span className="min-w-0 break-words">
          {pay.posted && <span className="font-medium tabular-nums text-foreground">{pay.posted}</span>}
          {pay.posted && pay.estimated && <span className="text-faint"> · </span>}
          {pay.estimated && <span className="tabular-nums text-muted">{pay.estimated}</span>}
        </span>
      )}
    </p>
  );
}
