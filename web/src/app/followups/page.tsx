import Link from "next/link";
import { Suspense } from "react";
import { FollowupsView } from "@/components/followups/followups-view";
import { readFollowupsEnabled } from "@/lib/followups-server";
import { redirect } from "next/navigation"; // hunt

export const dynamic = "force-dynamic"; // cadence is computed fresh per request

// hunt: follow-ups live in the Inbox (/inbox) now; /followups redirects there. The upstream
// cadence table (logging, overrides) stays at /followups?full=1.
export default async function FollowupsPage({ searchParams }: { searchParams: Promise<{ full?: string }> }) {
  const { full } = await searchParams;
  if (full !== "1") redirect("/inbox"); // hunt
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
  return (
    <Suspense>
      <FollowupsView />
    </Suspense>
  );
}
