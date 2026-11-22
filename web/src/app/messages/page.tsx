// Messages: recruiter and job-lead threads first, newest first, one compact
// row each. Coworker / social threads fold into "Other"; Done / Won't respond fold into
// "Archived". Synced read-only by scripts/hunt-messages-sync.mjs; nothing is sent from here.
import { PageFrame } from "@/components/page-frame";
import { ThreadList } from "@/components/hunt/thread-list";
import { readThreadRows } from "@/lib/hunt-data";
import { shortWhen } from "@/lib/hunt-message-kinds.mjs";

export const dynamic = "force-dynamic";

export default function MessagesPage() {
  const { rows, syncedAt, feedVersion } = readThreadRows();
  return (
    <PageFrame>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl tracking-tight text-landing">Messages</h1>
        <p className="text-xs text-faint" suppressHydrationWarning>{syncedAt ? `Last sync ${shortWhen(syncedAt)}` : "Not synced yet"}</p>
      </div>
      <div className="mt-4">
        <ThreadList
          rows={rows}
          emptyText={rows.length === 0 ? "No messages yet. They appear here after the hourly sync." : "No recruiter or job-lead threads right now."}
        />
      </div>
      {feedVersion !== 2 && rows.length > 0 && <p className="mt-3 text-[11px] text-faint">Gmail feed v1, label-only</p>}
    </PageFrame>
  );
}
