// hunt: List | Map switch on the Jobs page. Plain links, so it works before hydration.
import Link from "next/link";
import { List, ScatterChart } from "lucide-react";
import { cn } from "@/lib/cn";

export function JobsViewToggle({ active }: { active: "list" | "map" }) {
  const item = (key: "list" | "map", href: string, label: string, Icon: typeof List) => (
    <Link
      href={href}
      aria-current={active === key ? "page" : undefined}
      className={cn("inline-flex min-h-[40px] items-center gap-1.5 px-4 text-sm", active === key ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:text-foreground")}
    >
      <Icon className="size-4" aria-hidden />{label}
    </Link>
  );
  return (
    <nav aria-label="Jobs view" className="inline-flex overflow-hidden rounded-full border border-border">
      {item("list", "/pipeline", "List", List)}
      {item("map", "/pipeline/map", "Map", ScatterChart)}
    </nav>
  );
}
