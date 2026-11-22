// hunt: one Inbox item in full: who, which job(s), the last few messages, the next step, and
// explicit buttons for where each thing opens. Done / Ignore live here.
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { PageFrame } from "@/components/page-frame";
import { FollowupActions } from "@/components/hunt/followup-actions";
import { readInbox } from "@/lib/hunt-data";

export const dynamic = "force-dynamic";

const fmt = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
};

export default async function InboxDetail({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { needs, waiting, done } = readInbox(undefined, { fresh: true });
  const o = [...needs, ...waiting, ...done].find((x) => x.key === decodeURIComponent(key));
  if (!o) notFound();
  const gmail = o.threads.find((t) => !t.linkedin && /mail\.google\.com/.test(t.href));
  const linkedin = o.threads.find((t) => t.linkedin);
  const urgent = o.section === "needs" && /overdue/.test(o.when);
  const sectionLabel = o.section === "needs" ? "Needs my reply" : o.section === "waiting" ? "Waiting on them" : "Done or ignored";
  const btn = "inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-hover";
  return (
    <PageFrame>
      <Link href="/inbox" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" />Inbox</Link>
      <h1 className="mt-1 font-display text-2xl tracking-tight text-landing [overflow-wrap:anywhere]">{o.title}</h1>
      {o.rows.length > 0 && <p className="mt-1 text-sm text-muted">{o.rows.map((r) => `${r.role} (${r.status})`).join(" · ")}</p>}

      <section className="mt-4 rounded-xl border border-border p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-faint">{sectionLabel}</p>
        <p className="mt-1 text-base text-foreground">{o.action}{o.when && <span className={urgent ? "text-red-700 dark:text-red-400" : "text-muted"}> · {o.when}</span>}</p>
        {o.scheduled && o.scheduled.label !== o.action && <p className="mt-1 text-sm text-muted">Scheduled: {o.scheduled.label} · {fmt(`${o.scheduled.day}T12:00:00`)}</p>}
        {o.rows.filter((r) => r.next && !o.action.startsWith(r.next)).map((r) => <p key={r.n} className="mt-1 text-sm text-muted">Tracker next step: {r.next}</p>)}
      </section>

      <div className="mt-4 flex flex-wrap gap-2">
        {gmail && <a href={gmail.href} target="_blank" rel="noreferrer" className={btn}>Open in Gmail<ExternalLink className="size-3.5 text-faint" /></a>}
        {linkedin && <a href={linkedin.href} target="_blank" rel="noreferrer" className={btn}>Open in LinkedIn<ExternalLink className="size-3.5 text-faint" /></a>}
        {o.rows.map((r) => <Link key={r.n} href={`/pipeline/${encodeURIComponent(r.n)}`} className={btn}>Open job{o.rows.length > 1 ? `: ${r.company}` : ""}</Link>)}
      </div>

      {o.people.length > 0 && (
        <section className="mt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-faint">Who</h2>
          <ul className="mt-1 space-y-1 text-sm">
            {o.people.map((p) => <li key={p.name}><span className="font-medium text-foreground">{p.name}</span>{p.role && <span className="text-muted"> · {p.role}</span>}</li>)}
          </ul>
        </section>
      )}

      {o.threads.length > 0 && (
        <section className="mt-5">
          <h2 className="text-xs font-medium uppercase tracking-wide text-faint">Last messages</h2>
          <ul className="mt-1 divide-y divide-border rounded-xl border border-border">
            {o.threads.slice(0, 5).map((t) => (
              <li key={t.id} className="tap-row flex min-h-[52px] items-center gap-3 px-4 py-2">
                <a href={t.href} target="_blank" rel="noreferrer" className="row-link min-w-0 flex-1">
                  <span className="block text-xs text-faint">{fmt(t.date)} · {t.lastFromMe ? "you wrote last" : `${t.name} wrote`}{t.answeredVia ? ` · answered via ${t.answeredVia}` : ""}</span>
                  <span className="block truncate text-sm text-foreground">{t.snippet || "(no preview)"}</span>
                </a>
                <span className="shrink-0 text-xs text-faint">{t.linkedin ? "LinkedIn" : "Gmail"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <FollowupActions oppKey={o.key} lastDate={o.threads[0]?.date ?? ""} mark={o.mark?.mark ?? null} />
      </section>
    </PageFrame>
  );
}
