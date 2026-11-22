// hunt: /study/plan, /study/design, /study/companies, /study/stories, /study/cards, /study/notes.
import { notFound } from "next/navigation";
import { StudyPageBody } from "@/app/study/study-page";
import type { StudyTab } from "@/components/hunt/study-app";

export const dynamic = "force-dynamic";

const TABS = new Set(["home", "plan", "design", "companies", "stories", "cards", "notes"]);

export default async function StudyTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!TABS.has(tab)) notFound();
  return <StudyPageBody tab={tab as StudyTab} />;
}
