// hunt: Inbox (Messages + Follow-ups merged). "Needs my reply" first, then "Waiting on them",
// then a collapsed "Done or ignored". Classification: lib/hunt-inbox.mjs. Nothing is sent from here.
import { PageFrame } from "@/components/page-frame";
import { InboxList } from "@/components/hunt/inbox-list";
import { readInbox, readHuntMessages } from "@/lib/hunt-data";
import { shortWhen } from "@/lib/hunt-message-kinds.mjs";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  const { needs, waiting, done } = readInbox(undefined, { fresh: true });
  const { syncedAt } = readHuntMessages();
  return (
    <PageFrame>
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl tracking-tight text-landing">Inbox</h1>
        <p className="text-xs text-faint" suppressHydrationWarning>{syncedAt ? `Last sync ${shortWhen(syncedAt)}` : "Not synced yet"}</p>
      </div>
      <div className="mt-4">
        <InboxList needs={needs} waiting={waiting} done={done} />
      </div>
    </PageFrame>
  );
}
