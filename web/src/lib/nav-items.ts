import { LayoutDashboard, Compass, ListChecks, Send, Radar, BarChart3, FileText, Files, Settings, CalendarClock, Mail, Bot, GraduationCap, Sheet } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chip?: string;
  /** hunt: shown under the collapsed "More" menu instead of the main list. */
  more?: boolean;
};

// hunt: Home, Jobs, Tracker, Messages, Follow-ups and Study up front; everything else under "More".
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/pipeline", label: "Jobs", icon: ListChecks },
  { href: "/tracker", label: "Tracker", icon: Sheet }, // hunt: every job in flight, spreadsheet-style
  { href: "/messages", label: "Messages", icon: Mail }, // hunt: Job Hunt mail threads (Apps Script feed)
  { href: "/followups", label: "Follow-ups", icon: Send }, // hunt: top-level, right under Messages
  { href: "/study", label: "Study", icon: GraduationCap }, // hunt: interview prep checklist + flashcards
  { href: "/explore", label: "Explore", icon: Compass, more: true },
  { href: "/scheduled-scans", label: "Scheduled scans", icon: CalendarClock, more: true },
  { href: "/portals", label: "Portals", icon: Radar, more: true },
  { href: "/analytics", label: "Analytics", icon: BarChart3, more: true },
  { href: "/cv", label: "CV", icon: FileText, more: true },
  { href: "/documents", label: "Documents", icon: Files, more: true },
  { href: "/jobs", label: "Workers", icon: Bot, more: true },
  { href: "/config", label: "Config", icon: Settings, more: true },
];

export function visibleNavItems(followupsEnabled: boolean): NavItem[] {
  return followupsEnabled ? NAV_ITEMS : NAV_ITEMS.filter((item) => item.href !== "/followups");
}

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/** hunt: the always-visible items. */
export function primaryNavItems(followupsEnabled: boolean): NavItem[] {
  return visibleNavItems(followupsEnabled).filter((item) => !item.more);
}

/** hunt: the items under the collapsed "More" menu. */
export function moreNavItems(followupsEnabled: boolean): NavItem[] {
  return visibleNavItems(followupsEnabled).filter((item) => item.more);
}
