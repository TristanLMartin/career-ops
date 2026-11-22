// hunt: collapsed "More" section for the secondary nav items (upstream pages stay intact).
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { NavItem } from "@/lib/nav-items";
import { isActivePath } from "@/lib/nav-items";
import { cn } from "@/lib/cn";

export function MoreNav({ items, pathname, large = false, onNavigate }: { items: NavItem[]; pathname: string; large?: boolean; onNavigate?: () => void }) {
  if (items.length === 0) return null;
  const anyActive = items.some((i) => isActivePath(i.href, pathname));
  return (
    <details className="group mt-1" open={anyActive}>
      <summary className={cn("flex cursor-pointer list-none items-center gap-3 rounded-md px-3 text-muted hover:bg-surface-hover hover:text-foreground", large ? "py-3 text-[15px]" : "py-2 text-sm")}>
        <ChevronDown className={cn(large ? "size-5" : "size-4", "transition-transform group-open:rotate-180")} />
        More
      </summary>
      <div className="mt-1 flex flex-col gap-1 pl-3">
        {items.map(({ href, label, icon: Icon }) => {
          const active = isActivePath(href, pathname);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 transition-colors",
                large ? "py-2.5 text-[15px]" : "py-1.5 text-sm",
                active ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
              )}
            >
              <Icon className={large ? "size-5" : "size-4"} />
              {label}
            </Link>
          );
        })}
      </div>
    </details>
  );
}
