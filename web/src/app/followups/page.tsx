import Link from "next/link";
import { Suspense } from "react";
import { FollowupsView } from "@/components/followups/followups-view";
import { readFollowupsEnabled } from "@/lib/followups-server";
import { PageFrame } from "@/components/page-frame"; // hunt
import { FollowupsList } from "@/components/hunt/followups-list"; // hunt
import { readOpportunities } from "@/lib/hunt-data"; // hunt

export const dynamic = "force-dynamic"; // cadence is computed fresh per request

// hunt: compact rows (applications to nudge + recruiter / job-lead threads waiting on them),
// due date first. The upstream cadence table (logging, overrides) stays at /followups?full=1.
export default async function FollowupsPage({ searchParams }: { searchParams: Promise<{ full?: string }> }) {
  const { full } = await searchParams;
  if (!readFollowupsEnabled()) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="font-display text-2xl tracking-tight text-landing">Follow-ups are turned off</h1>
        <p className="mt-2 text-sm text-muted">
          Turn them back on in{" "}
          <Link href="/config" className="font-medium text-brand-text hover:underline">Config</Link>, or set{" "}
          <span className="font-mono">follow_ups.enabled: true</span> in <span className="font-mono">config/profile.yml</span>.
        </p>
      </div>
    );
  }
  if (full !== "1") {
    const items = readOpportunities();
    return (
      <PageFrame>
        <h1 className="font-display text-2xl tracking-tight text-landing">Follow-ups</h1>
        <div className="mt-4">
          <FollowupsList items={items} />
        </div>
        <Link href="/followups?full=1" className="mt-3 inline-flex min-h-[44px] items-center text-xs text-muted hover:text-foreground">Full cadence table (log a follow-up, change dates)</Link>
      </PageFrame>
    );
  }
  return (
    <Suspense>
      <FollowupsView />
    </Suspense>
  );
}
