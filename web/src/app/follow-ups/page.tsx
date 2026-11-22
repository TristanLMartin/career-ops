// hunt: /follow-ups is an alias; the page lives at /followups (upstream links use that).
import { redirect } from "next/navigation";

export default function FollowUpsAlias() {
  redirect("/followups");
}
