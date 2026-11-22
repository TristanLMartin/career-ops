// hunt: Messages merged into the Inbox; old links land there.
import { redirect } from "next/navigation";

export default function MessagesRedirect() {
  redirect("/inbox");
}
