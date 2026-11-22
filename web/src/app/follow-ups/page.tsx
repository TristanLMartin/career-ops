// hunt: /follow-ups is an alias; follow-ups live in the Inbox now.
import { redirect } from "next/navigation";

export default function FollowUpsAlias() {
  redirect("/inbox");
}
