// hunt: follow-up detail pages moved to /inbox/<key>; old links land there.
import { redirect } from "next/navigation";

export default async function FollowupDetailRedirect({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  redirect(`/inbox/${encodeURIComponent(decodeURIComponent(key))}`);
}
