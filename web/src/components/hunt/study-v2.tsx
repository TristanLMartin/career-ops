"use client";
// hunt: the study home built on data/study/days.md and the study docs (design prompts, company
// prep, stories, lessons, checkpoints, resources). Calm on purpose: today's items first, one line
// for what's next, a few quiet facts, then links. Docs render from markdown as plain text only
// (no HTML from the files is ever rendered); URLs and cross-references become links.
import Link from "next/link";
import { ChevronRight, ExternalLink } from "lucide-react";
import { linkProblems, linkRefs, nextCheckpoint, trackProgress, isDayDone, anchor } from "@/lib/hunt-study-days.mjs";
import { cn } from "@/lib/cn";

export type StudyItem = { id: string; index: number; type: string | null; text: string; star: boolean };
export type StudyDayT = { key: string; n: number; fast: boolean; theme: string; title: string; items: StudyItem[]; section: string; week: string };
export type DaysDoc = { intro: string[]; sections: { title: string; weeks: { title: string; days: StudyDayT[] }[] }[]; days: StudyDayT[] };
export type Prompt = { title: string; anchor: string };
export type Interview2 = { n: string; company: string; role: string; next: string; prepHref: string | null };
type Ticks = Record<string, true | boolean>;

// ── inline text: LeetCode links, cross-links, bare URLs, **bold** ───────────

function Plain({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>
          : /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all text-brand-text underline-offset-2 hover:underline">{p.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>
          : <span key={i}>{p}</span>,
      )}
    </>
  );
}

export function ItemText({ text, prompts }: { text: string; prompts: Prompt[] }) {
  return (
    <>
      {linkProblems(text).map((seg: { text: string; problem?: { name: string; number: number; url: string; star: boolean } }, i: number) =>
        seg.problem ? (
          <a key={i} href={seg.problem.url} target="_blank" rel="noreferrer" className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-brand-text">
            {seg.problem.star && <span className="mr-0.5 text-amber-800 dark:text-amber-400" aria-label="must do">★</span>}
            {seg.problem.name}
            <span className="ml-1 text-xs font-normal tabular-nums text-faint">#{seg.problem.number}</span>
          </a>
        ) : (
          linkRefs(seg.text, prompts).map((r: { text: string; href?: string }, j: number) =>
            r.href ? <Link key={`${i}-${j}`} href={r.href} className="text-brand-text underline-offset-2 hover:underline">{r.text}</Link> : <Plain key={`${i}-${j}`} text={r.text} />,
          )
        ),
      )}
    </>
  );
}

function Tag({ type }: { type: string | null }) {
  if (!type) return null;
  return <span className="mr-1.5 inline-block rounded bg-surface-hover px-1.5 py-px align-[1px] text-[10px] font-medium uppercase tracking-wide text-faint">{type}</span>;
}

export function DayItems({ day, ticks, onTick, prompts, limit }: { day: StudyDayT; ticks: Ticks; onTick: (id: string, v: boolean) => void; prompts: Prompt[]; limit?: number }) {
  const items = limit ? day.items.filter((i) => !ticks[i.id]).slice(0, limit) : day.items;
  return (
    <ul>
      {items.map((it) => (
        <li key={it.id} className="flex min-h-[44px] items-start gap-3 py-1.5">
          <input type="checkbox" aria-label={it.text.replace(/★/g, "")} checked={!!ticks[it.id]} onChange={(e) => onTick(it.id, e.target.checked)} className="mt-1 size-[18px] shrink-0 accent-[var(--color-brand,#e8743b)]" />
          <div className={cn("min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]", ticks[it.id] && "text-faint line-through decoration-1", it.star && !ticks[it.id] && "font-medium")}>
            <Tag type={it.type} />
            <ItemText text={it.text} prompts={prompts} />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Home ────────────────────────────────────────────────────────────────────

export function StudyHomeV2({ days, ticks, startDate, fastTrack, checkpoints, interviews, prompts, onTick, onStart, onFast }: {
  days: StudyDayT[]; ticks: Ticks; startDate: string | null; fastTrack: boolean; checkpoints: { day: number; text: string }[];
  interviews: Interview2[]; prompts: Prompt[];
  onTick: (id: string, v: boolean) => void; onStart: () => void; onFast: (v: boolean) => void;
}) {
  const track = days.filter((d) => d.fast === fastTrack);
  const today = track.find((d) => !isDayDone(d, ticks)) ?? null;
  const next = today ? track[track.indexOf(today) + 1] : null;
  const p = trackProgress(days, ticks, { fastTrack });
  const done = today ? today.items.filter((i) => ticks[i.id]).length : 0;
  const cp = nextCheckpoint(checkpoints, today?.n ?? 1);

  return (
    <div className="space-y-5">
      {today ? (
        <section aria-label="Today" className="rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">{fastTrack ? today.title : `Day ${today.n}`}{today.theme && !fastTrack ? <span className="font-normal text-muted"> · {today.theme}</span> : null}</h2>
            <span className="shrink-0 text-xs tabular-nums text-faint">{done}/{today.items.length}</span>
          </div>
          {!startDate && !fastTrack && today.n === 1 && (
            <button type="button" onClick={onStart} className="mt-3 inline-flex min-h-[44px] items-center rounded-full bg-brand-soft px-4 text-sm font-medium text-brand-text">Start Day 1 today</button>
          )}
          <div className="mt-2"><DayItems day={today} ticks={ticks} onTick={onTick} prompts={prompts} /></div>
          {next && <p className="mt-3 border-t border-border pt-3 text-xs text-muted">Up next: <span className="text-foreground">{fastTrack ? next.title : `Day ${next.n}`}{next.theme && !fastTrack ? ` · ${next.theme}` : ""}</span></p>}
        </section>
      ) : (
        <p className="rounded-2xl border border-border p-5 text-sm text-muted">All {p.total} days done. Repeat the weak week or rest.</p>
      )}

      <section aria-label="Progress" className="space-y-1 text-sm text-muted">
        <p><span className="font-medium tabular-nums text-foreground">{p.done} of {p.total}</span> days done{startDate ? <span className="text-faint"> · started {new Date(`${startDate}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span> : null}</p>
        {cp && !fastTrack && <p>Next checkpoint, end of Day {cp.day}: <span className="text-foreground">{cp.text}</span></p>}
        <label className="flex min-h-[44px] w-fit cursor-pointer items-center gap-2 text-xs">
          <input type="checkbox" checked={fastTrack} onChange={(e) => onFast(e.target.checked)} className="size-4 accent-[var(--color-brand,#e8743b)]" />
          Fast-track mode (a loop booked within a week)
        </label>
      </section>

      {interviews.length > 0 && (
        <section aria-label="Upcoming interviews">
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">Upcoming interviews</h2>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {interviews.map((iv) => (
              <li key={iv.n} className={cn("flex min-h-[52px] items-center gap-3 px-4 py-2", iv.prepHref && "tap-row")}>
                <div className="min-w-0 flex-1">
                  {iv.prepHref ? (
                    <Link href={iv.prepHref} className="row-link block truncate text-sm"><span className="font-medium text-foreground">{iv.company}</span><span className="text-muted"> · {iv.role}</span></Link>
                  ) : (
                    <p className="truncate text-sm"><span className="font-medium text-foreground">{iv.company}</span><span className="text-muted"> · {iv.role}</span></p>
                  )}
                  <p className="truncate text-xs text-muted">{iv.next || "No next step set"}</p>
                </div>
                {iv.prepHref && <span className="shrink-0 text-xs text-brand-text">Prep</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav aria-label="Study sections" className="flex flex-wrap gap-2">
        {[["design", "Design"], ["companies", "Companies"], ["stories", "Stories"], ["notes", "Lessons"], ["notes#resources", "Resources"], ["cards", "Cards"]].map(([t, l]) => (
          <Link key={l} href={`/study/${t}`} className="inline-flex min-h-[44px] items-center rounded-full border border-border px-4 text-sm text-foreground hover:bg-surface-hover">{l}</Link>
        ))}
      </nav>
    </div>
  );
}

// ── Plan: every day, collapsible by phase and week ───────────────────────────

export function DaysPlan({ doc, ticks, onTick, prompts, currentKey }: { doc: DaysDoc; ticks: Ticks; onTick: (id: string, v: boolean) => void; prompts: Prompt[]; currentKey: string | null }) {
  return (
    <div className="space-y-6">
      {doc.intro.length > 0 && <p className="text-sm leading-relaxed text-muted">{doc.intro.join(" ")}</p>}
      {doc.sections.map((s) => (
        <section key={s.title} aria-label={s.title}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">{s.title}</h2>
          {s.weeks.map((w, wi) => (
            <div key={`${s.title}-${wi}`} className="mb-3">
              {w.title && <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{w.title}</h3>}
              <div className="divide-y divide-border rounded-xl border border-border">
                {w.days.map((d) => {
                  const n = d.items.filter((i) => ticks[i.id]).length;
                  return (
                    <details key={d.key} id={d.key} open={d.key === currentKey} className="group">
                      <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 px-4 text-sm">
                        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open:rotate-90" />
                        <span className="font-medium text-foreground">{d.fast ? d.title : `Day ${d.n}`}</span>
                        {d.theme && !d.fast && <span className="min-w-0 truncate text-muted">{d.theme}</span>}
                        <span className={cn("ml-auto shrink-0 text-xs tabular-nums", n === d.items.length ? "text-emerald-800 dark:text-emerald-400" : "text-faint")}>{n}/{d.items.length}</span>
                      </summary>
                      <div className="px-4 pb-3"><DayItems day={d} ticks={ticks} onTick={onTick} prompts={prompts} /></div>
                    </details>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// ── Markdown docs (headings with anchors, bullets, numbered lists, paragraphs) ───

type MdBlock = { kind: "h2" | "h3" | "p"; text: string } | { kind: "ul" | "ol"; items: string[] };

function mdBlocks(md: string): MdBlock[] {
  const out: MdBlock[] = [];
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || /^#\s/.test(line)) continue;
    const h = line.match(/^(#{2,3})\s+(.*)$/);
    if (h) { out.push({ kind: h[1].length === 2 ? "h2" : "h3", text: h[2] }); continue; }
    const ul = line.match(/^\s*-\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const last = out[out.length - 1];
    if (ul) { if (last?.kind === "ul") last.items.push(ul[1]); else out.push({ kind: "ul", items: [ul[1]] }); continue; }
    if (ol) { if (last?.kind === "ol") last.items.push(ol[1]); else out.push({ kind: "ol", items: [ol[1]] }); continue; }
    out.push({ kind: "p", text: line.trim() });
  }
  return out;
}

/** Render a study doc. `reveal`: "A good answer covers…" and its list fold behind a button. */
export function MdDoc({ md, prompts, reveal = false, title }: { md: string; prompts: Prompt[]; reveal?: boolean; title?: string }) {
  const blocks = mdBlocks(md);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "h2") nodes.push(<h2 key={i} id={anchor(b.text)} className="mt-6 scroll-mt-20 text-base font-semibold text-foreground first:mt-0">{b.text}</h2>);
    else if (b.kind === "h3") nodes.push(<h3 key={i} id={anchor(b.text)} className="mt-4 scroll-mt-20 text-sm font-semibold text-foreground">{b.text}</h3>);
    else if (b.kind === "p" && reveal && /^A good answer covers/i.test(b.text)) {
      const list = blocks[i + 1]?.kind === "ul" ? (blocks[i + 1] as { kind: "ul"; items: string[] }) : null;
      const rest = b.text.replace(/^A good answer covers[^:]*:\s*/i, "");
      nodes.push(
        <details key={i} className="group mt-2 rounded-lg border border-border">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-3 text-sm text-brand-text">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />Show a good answer
          </summary>
          <div className="px-3 pb-3 text-sm leading-relaxed text-muted">
            {rest && <p><ItemText text={rest} prompts={prompts} /></p>}
            {list && <ul className="list-disc space-y-1 pl-5">{list.items.map((t, j) => <li key={j}><ItemText text={t} prompts={prompts} /></li>)}</ul>}
          </div>
        </details>,
      );
      if (list) i++;
    } else if (b.kind === "p") nodes.push(<p key={i} className="mt-2 text-sm leading-relaxed text-muted [overflow-wrap:anywhere]"><ItemText text={b.text} prompts={prompts} /></p>);
    else {
      const lb = b as { kind: "ul" | "ol"; items: string[] };
      nodes.push(
      lb.kind === "ul"
        ? <ul key={i} className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{lb.items.map((t, j) => <li key={j}><ItemText text={t} prompts={prompts} /></li>)}</ul>
        : <ol key={i} className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{lb.items.map((t, j) => <li key={j}><ItemText text={t} prompts={prompts} /></li>)}</ol>,
      );
    }
  }
  return (
    <article>
      {title && <h2 id={anchor(title)} className="mb-2 scroll-mt-20 text-xs font-medium uppercase tracking-wide text-faint">{title}</h2>}
      {nodes}
    </article>
  );
}
