"use client";
// hunt: switch between people's dashboards (same build, one web instance per profile).
// Links go to the same host on the other instance's port, so it works on the LAN and on Tailscale.
import { useEffect, useState } from "react";
import type { ProfileSwitchItem } from "@/lib/hunt-profiles";
import { cn } from "@/lib/cn";

export function ProfileSwitch({ items, className }: { items: ProfileSwitchItem[]; className?: string }) {
  const [origin, setOrigin] = useState<{ protocol: string; hostname: string } | null>(null);
  useEffect(() => setOrigin({ protocol: window.location.protocol, hostname: window.location.hostname }), []);
  if (items.length < 2) return null;
  return (
    <nav aria-label="Switch person" className={cn("inline-flex items-center rounded-full border border-border bg-surface/60 p-0.5 text-xs", className)}>
      {items.map((p) =>
        p.current ? (
          <span key={p.id} aria-current="page" className="inline-flex min-h-[36px] items-center rounded-full bg-brand-soft px-3 font-medium text-brand-text max-md:min-h-[44px]">
            {p.name}
          </span>
        ) : (
          <a
            key={p.id}
            href={origin ? `${origin.protocol}//${origin.hostname}:${p.port}/` : `/`}
            className="inline-flex min-h-[36px] items-center rounded-full px-3 text-muted transition-colors hover:bg-surface-hover hover:text-foreground max-md:min-h-[44px]"
          >
            {p.name}
          </a>
        ),
      )}
    </nav>
  );
}
