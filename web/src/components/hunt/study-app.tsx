"use client";
// hunt: the Study page (Today / Flashcards / Plan). Calm on purpose: one thing at a time,
// big tap targets on the phone. Progress syncs through /api/profile/study; localStorage is only
// an optimistic cache so a tick shows instantly and survives a flaky connection.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Flag, Search, Shuffle, Zap } from "lucide-react";
import { answerQueue, isFoldable, reviewQueue, searchCards, searchPlan, sectionSummary, splitLeadIn } from "@/lib/hunt-study.mjs";
import { DaysPlan, MdDoc, StudyHomeV2, type DaysDoc, type Interview2, type Prompt } from "@/components/hunt/study-v2";
import { cn } from "@/lib/cn";

type Sub = { id: string; label: string; text: string };
type Item = { id: string; text: string; note?: string; star?: boolean; number?: string | null; subs?: Sub[] };
type Group = { id: string; title: string; items: Item[] };
type Card = { id: string; c: string; q: string; one: string; b: string[] };
type Block = { type: "p" | "quote"; text: string } | { type: "ul" | "ol"; items: string[] } | { type: "table"; head: string[]; rows: string[][] };
type Section = { level: number; title: string; path: string[]; blocks: Block[]; children: Section[] };
type State = { ticks: Record<string, true>; flags: Record<string, true>; reviewed?: Record<string, true>; startDate?: string | null; fastTrack?: boolean; updatedAt: string | null };

const CACHE_KEY = "hunt:study-state";
const TAB_KEY = "hunt:study-tab";
import { CARD_CATEGORIES } from "@/lib/hunt-study.mjs";

/** Filter chips: the categories the cards use (suggested order first), then Flagged. */
function chipsFor(cards: { c: string }[]): string[] {
  const used = [...new Set(cards.map((c) => c.c).filter(Boolean))];
  const known = (CARD_CATEGORIES as readonly string[]).filter((c) => used.includes(c));
  return [...known, ...used.filter((c) => !known.includes(c)).sort(), "Flagged"];
}

function safeGet(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function safeSet(key: string, v: string) { try { window.localStorage.setItem(key, v); } catch { /* private mode */ } }

const done = (it: Item, t: State["ticks"]) => !!t[it.id] || (!!it.subs?.length && it.subs.every((s) => t[s.id]));

/** **bold** spans only; everything else is plain text (no HTML from the file is ever rendered). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (/^\*\*[^*]+\*\*$/.test(p) ? <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>))}</>;
}

export type StudyTab = (typeof TABS)[number][0];
const TABS = [["home", "Home"], ["plan", "Plan"], ["design", "Design"], ["companies", "Companies"], ["stories", "Stories"], ["cards", "Cards"], ["notes", "Notes"]] as const;
export type StudyDocs = { design: string; companies: string; stories: string; lessons: string; checkpoints: string; resources: string };

export function StudyApp({ groups, cards, plan, initialState, daysDoc, docs, prompts, checkpoints, interviews = [], initialTab = "home" }: {
  groups: Group[]; cards: Card[]; plan: Section[]; initialState: State; daysDoc: DaysDoc; docs: StudyDocs; prompts: Prompt[];
  checkpoints: { day: number; text: string }[]; interviews?: Interview2[]; initialTab?: StudyTab;
}) {
  const [tab, setTab] = useState<StudyTab>(initialTab);
  const [state, setState] = useState<State>(initialState);
  const [offline, setOffline] = useState(false);
  const pending = useRef<{ op: "tick" | "flag" | "review" | "start" | "fast"; id: string; value: boolean | string | null }[]>([]);

  useEffect(() => {
    // hunt: /study/<tab> picks the tab (server); the old ?tab=cards|today links still work.
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "cards") setTab("cards"); else if (t === "today") setTab("home");
    if (window.location.hash) requestAnimationFrame(() => document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" }));
    // Fresh server copy (another device may have ticked things since this page rendered).
    fetch("/api/profile/study", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((s) => { if (s?.ticks) { setState(s); safeSet(CACHE_KEY, JSON.stringify(s)); } }).catch(() => {
      const cached = safeGet(CACHE_KEY);
      if (cached) { try { setState(JSON.parse(cached)); } catch { /* ignore */ } }
      setOffline(true);
    });
  }, []);

  const flush = useCallback(async () => {
    if (!pending.current.length) return;
    const ops = pending.current.splice(0);
    try {
      const r = await fetch("/api/profile/study", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops }) });
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      setState(s); safeSet(CACHE_KEY, JSON.stringify(s)); setOffline(false);
    } catch {
      pending.current.unshift(...ops); // keep for the next try
      setOffline(true);
    }
  }, []);

  const change = useCallback((op: "tick" | "flag" | "review", id: string, value: boolean) => {
    setState((s) => {
      const key = op === "tick" ? "ticks" : op === "flag" ? "flags" : "reviewed";
      const next = { ...s[key] };
      if (value) next[id] = true; else delete next[id];
      const ns = { ...s, [key]: next };
      safeSet(CACHE_KEY, JSON.stringify(ns));
      return ns;
    });
    pending.current.push({ op, id, value });
    void flush();
  }, [flush]);

  const meta = useCallback((op: "start" | "fast", value: string | boolean | null) => {
    setState((s) => { const ns = op === "start" ? { ...s, startDate: value as string | null } : { ...s, fastTrack: value === true }; safeSet(CACHE_KEY, JSON.stringify(ns)); return ns; });
    pending.current.push({ op, id: op, value });
    void flush();
  }, [flush]);
  const pickTab = (t: StudyTab) => {
    setTab(t);
    safeSet(TAB_KEY, t);
    try { window.history.replaceState(null, "", t === "home" ? "/study" : `/study/${t}`); } catch { /* ignore */ }
  };
  const ticks = state.ticks;
  const current = daysDoc.days.filter((d) => d.fast === !!state.fastTrack).find((d) => !d.items.every((i) => ticks[i.id]))?.key ?? null;
  const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };

  return (
    <div className="mt-3">
      <div role="tablist" aria-label="Study" className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 text-sm [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => pickTab(k)} className={cn("min-h-[40px] shrink-0 rounded-full px-3.5", tab === k ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:text-foreground")}>{label}</button>
        ))}
      </div>
      {offline && <p className="mt-2 text-xs text-amber-800 dark:text-amber-400">Offline: your changes are kept on this device and will sync when the server answers.</p>}
      <div className="mt-5">
        {tab === "home" && (
          <StudyHomeV2
            days={daysDoc.days}
            ticks={ticks}
            startDate={state.startDate ?? null}
            fastTrack={!!state.fastTrack}
            checkpoints={checkpoints}
            interviews={interviews}
            prompts={prompts}
            onTick={(id, v) => change("tick", id, v)}
            onStart={() => meta("start", localToday())}
            onFast={(v) => meta("fast", v)}
          />
        )}
        {tab === "plan" && <DaysPlan doc={daysDoc} ticks={ticks} onTick={(id, v) => change("tick", id, v)} prompts={prompts} currentKey={current} />}
        {tab === "design" && <MdDoc md={docs.design} prompts={prompts} reveal />}
        {tab === "companies" && <MdDoc md={docs.companies} prompts={prompts} />}
        {tab === "stories" && <MdDoc md={docs.stories} prompts={prompts} />}
        {tab === "cards" && <Cards cards={cards} flags={state.flags} onFlag={(id, v) => change("flag", id, v)} onReviewed={(id) => change("review", id, true)} />}
        {tab === "notes" && (
          <div className="space-y-8">
            <MdDoc md={docs.lessons} prompts={prompts} title="Lessons from the Nov 17 screen" />
            <MdDoc md={docs.checkpoints} prompts={prompts} title="Checkpoints" />
            <MdDoc md={docs.resources} prompts={prompts} title="Resources" />
            {plan.length > 0 && (
              <details className="group rounded-xl border border-border">
                <summary className="flex min-h-[48px] cursor-pointer list-none items-center gap-2 px-4 text-sm text-muted">
                  <ChevronRight className="size-4 transition-transform group-open:rotate-90" />The original Microsoft study plan
                </summary>
                <div className="px-4 pb-4"><Plan plan={plan} cards={cards} /></div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Today / Checklist ────────────────────────────────────────────────────────

function Check({ checked, onChange, label, children, small }: { checked: boolean; onChange: (v: boolean) => void; label: string; children: React.ReactNode; small?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", small ? "py-1" : "py-2")}>
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} className={cn("mt-0.5 shrink-0 accent-[var(--color-brand,#e8743b)]", small ? "size-4" : "size-5")} />
      <span className={cn("min-w-0 flex-1", checked && "text-faint line-through decoration-1")}>{children}</span>
    </label>
  );
}

function Progress({ n, of }: { n: number; of: number }) {
  const pct = of ? Math.round((n / of) * 100) : 0;
  return (
    <span className="flex items-center gap-2 text-xs text-faint">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-hover"><span className="block h-full rounded-full bg-emerald-500/70" style={{ width: `${pct}%` }} /></span>
      {n}/{of}
    </span>
  );
}

function Today({ groups, ticks, onTick, hideFocus = false }: { groups: Group[]; ticks: State["ticks"]; onTick: (id: string, v: boolean) => void; hideFocus?: boolean }) {
  const plan = groups.find((g) => g.title === "12-day plan");
  const days = plan?.items ?? [];
  const todayIdx = days.findIndex((it) => !done(it, ticks));
  const [view, setView] = useState<number | null>(null); // null: follow today
  const idx = view ?? (todayIdx < 0 ? days.length - 1 : todayIdx);
  const day = days[idx];
  const isToday = idx === todayIdx;
  const dayDone = day ? done(day, ticks) : false;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => { try { setOpen(JSON.parse(safeGet("hunt:study-open2") ?? "{}")); } catch { /* ignore */ } }, []);
  const toggle = (id: string) => setOpen((o) => { const n = { ...o, [id]: !o[id] }; safeSet("hunt:study-open2", JSON.stringify(n)); return n; });

  return (
    <div className="space-y-6">
      {hideFocus ? null : day ? (
        <section aria-label="Today's focus" className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-faint">
            {todayIdx < 0 ? "All 12 days done" : isToday ? "Today" : idx < todayIdx ? "Done earlier" : "Coming up"} · {day.text} of {days.length}
          </p>
          <div className="mt-3 space-y-1">
            {day.subs?.map((s) => (
              <Check key={s.id} checked={!!ticks[s.id] || !!ticks[day.id]} onChange={(v) => onTick(s.id, v)} label={`${day.text} ${s.label}`}>
                <span className="block text-xs font-medium text-faint">{s.label}</span>
                <span className="block text-base leading-snug text-foreground">{s.text}</span>
              </Check>
            ))}
          </div>
          {dayDone && <p className="mt-2 text-sm text-emerald-800 dark:text-emerald-400">This day is done. Nice work.</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={idx >= days.length - 1}
              onClick={() => setView(Math.min(days.length - 1, idx + 1))}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-5 text-sm font-medium text-foreground hover:bg-surface-hover disabled:opacity-40 sm:flex-none"
            >
              {dayDone ? "Next day" : "Next"}<ChevronRight className="size-4" />
            </button>
            {view != null && idx !== todayIdx && todayIdx >= 0 && (
              <button type="button" onClick={() => setView(null)} className="min-h-[44px] px-3 text-sm text-muted hover:text-foreground">Back to today</button>
            )}
          </div>
        </section>
      ) : (
        <p className="text-sm text-muted">No 12-day plan found in the study plan.</p>
      )}

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">Everything else</p>
        <div className="space-y-2">
          {groups.map((g) => {
            const n = g.items.filter((it) => done(it, ticks)).length;
            const isOpen = !!open[g.id];
            let lastNote = "";
            return (
              <section key={g.id} className="rounded-lg border border-border">
                <button type="button" onClick={() => toggle(g.id)} aria-expanded={isOpen} className="flex min-h-[48px] w-full items-center gap-3 px-4 py-2 text-left">
                  <ChevronRight className={cn("size-4 shrink-0 text-faint transition-transform", isOpen && "rotate-90")} />
                  <span className="flex-1 text-sm font-semibold text-foreground">{g.title}</span>
                  <Progress n={n} of={g.items.length} />
                </button>
                {isOpen && (
                  <div className="border-t border-border px-4 py-2">
                    {g.items.map((it) => {
                      const showNote = g.title !== "12-day plan" && it.note && it.note !== lastNote && (g.title === "LeetCode problems" || g.title === "Before the loop");
                      if (showNote) lastNote = it.note!;
                      return (
                        <div key={it.id}>
                          {showNote && <p className="mt-3 text-xs font-medium text-faint first:mt-1">{it.note}</p>}
                          <Check checked={done(it, ticks)} onChange={(v) => { onTick(it.id, v); if (!v) it.subs?.forEach((s) => ticks[s.id] && onTick(s.id, false)); }} label={it.text}>
                            <span className="text-sm text-foreground">{it.star && <span className="mr-1 text-amber-800 dark:text-amber-400" aria-label="most asked">★</span>}{it.text}</span>
                            {g.title === "Beyond Microsoft" && it.note && <span className="mt-0.5 block text-xs text-muted">{it.note}</span>}
                          </Check>
                          {it.subs && (
                            <div className="mb-1 ml-8">
                              {it.subs.map((s) => (
                                <Check key={s.id} small checked={!!ticks[s.id] || !!ticks[it.id]} onChange={(v) => onTick(s.id, v)} label={`${it.text} ${s.label}`}>
                                  <span className="text-xs text-muted"><span className="text-faint">{s.label}:</span> {s.text}</span>
                                </Check>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Flashcards ──────────────────────────────────────────────────────────────

function CardFace({ card, side, meta, onFlip }: { card: Card; side: number; meta: string; onFlip: () => void }) {
  return (
    <button type="button" onClick={onFlip} className="mt-4 block min-h-[260px] w-full rounded-xl border border-border bg-surface p-5 text-left shadow-sm transition-colors hover:bg-surface-hover" aria-label="Flip card">
      <p className="text-xs text-faint">{meta}</p>
      <p className="mt-3 text-lg font-semibold leading-snug text-foreground">{card.q}</p>
      {side >= 1 && <p className="mt-4 text-base text-foreground">{card.one}</p>}
      {side >= 2 && card.b.length > 0 && (
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-muted">{card.b.map((x, k) => <li key={k}>{x}</li>)}</ul>
      )}
      <p className="mt-5 text-xs text-faint">{side === 0 ? "Tap to see the one-liner" : side === 1 ? (card.b.length ? "Tap for the details" : "Tap to start over") : "Tap to start over"}</p>
    </button>
  );
}

function Cards({ cards, flags, onFlag, onReviewed }: { cards: Card[]; flags: State["flags"]; onFlag: (id: string, v: boolean) => void; onReviewed?: (id: string) => void }) {
  const CHIPS = useMemo(() => chipsFor(cards), [cards]);
  const [chip, setChip] = useState<string>("All");
  const [order, setOrder] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  const [side, setSide] = useState(0); // 0 question, 1 one-liner, 2 bullets
  const [queue, setQueue] = useState<string[] | null>(null); // Quick review: ids still to go
  const [reviewed, setReviewed] = useState(0);
  const deck = useMemo(() => {
    const base = cards.filter((c) => (chip === "All" ? true : chip === "Flagged" ? flags[c.id] : c.c === chip));
    if (!order) return base;
    const pos = new Map(order.map((id, k) => [id, k]));
    return [...base].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  }, [cards, chip, flags, order]);
  const card = deck[Math.min(i, Math.max(0, deck.length - 1))];
  const go = (d: number) => { setSide(0); setI((x) => (deck.length ? (x + d + deck.length) % deck.length : 0)); };
  const shuffle = () => {
    const ids = cards.map((c) => c.id);
    for (let k = ids.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [ids[k], ids[j]] = [ids[j], ids[k]]; }
    setOrder(ids); setI(0); setSide(0);
  };
  const count = (c: string) => (c === "Flagged" ? cards.filter((x) => flags[x.id]).length : cards.filter((x) => x.c === c).length);
  const startReview = () => { setQueue(reviewQueue(deck, flags)); setReviewed(0); setSide(0); };
  const answer = (again: boolean) => {
    if (!again && queue?.[0]) onReviewed?.(queue[0]); // counts toward "cards reviewed" on the Study home
    setQueue((q) => (q ? answerQueue(q, again) : q)); if (!again) setReviewed((n) => n + 1); setSide(0);
  };
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  if (queue) {
    const current = queue.length ? byId.get(queue[0]) : null;
    return (
      <div>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-foreground">Quick review</p>
          <span className="rounded-full bg-surface-hover px-2.5 py-0.5 text-xs tabular-nums text-muted">{queue.length} left</span>
          <button type="button" onClick={() => setQueue(null)} className="ml-auto min-h-[40px] px-2 text-sm text-muted hover:text-foreground">Stop</button>
        </div>
        {current ? (
          <>
            <CardFace card={current} side={side} meta={`${current.c}${flags[current.id] ? " · flagged" : ""}`} onFlip={() => setSide((x) => (x + 1) % 3)} />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => answer(true)} className="min-h-[48px] rounded-lg border border-border text-sm font-medium text-foreground hover:bg-surface-hover">Again</button>
              <button type="button" onClick={() => answer(false)} className="min-h-[48px] rounded-lg bg-brand-soft text-sm font-medium text-brand-text hover:opacity-90">Got it</button>
            </div>
            <p className="mt-2 text-xs text-faint">Again puts the card back a few cards later.</p>
          </>
        ) : (
          <div className="mt-4 rounded-xl border border-border p-6 text-center">
            <p className="text-base font-semibold text-foreground">Done. {reviewed} cards reviewed.</p>
            <button type="button" onClick={startReview} className="mt-3 min-h-[44px] rounded-lg border border-border px-4 text-sm text-foreground hover:bg-surface-hover">Go again</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Card categories">
        {["All", ...CHIPS].filter((c) => c === "All" || count(c) > 0 || c === "Flagged").map((c) => (
          <button key={c} type="button" aria-pressed={chip === c} onClick={() => { setChip(c); setI(0); setSide(0); }} className={cn("min-h-[36px] rounded-full border px-3 text-xs", chip === c ? "border-brand-text bg-brand-soft font-medium text-brand-text" : "border-border text-muted hover:text-foreground")}>
            {c === "Flagged" && <Flag className="mr-1 inline size-3" />}{c}{c !== "All" && <span className="ml-1 text-faint">{count(c)}</span>}
          </button>
        ))}
      </div>
      {deck.length > 0 && (
        <button type="button" onClick={startReview} className="mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-brand-soft px-4 text-sm font-medium text-brand-text hover:opacity-90">
          <Zap className="size-4" />Quick review{chip !== "All" ? ` · ${chip}` : ""} ({deck.length})
        </button>
      )}

      {!card ? (
        <p className="mt-6 text-sm text-muted">{chip === "Flagged" ? "No flagged cards yet. Flag the ones you want to practice." : "No cards here."}</p>
      ) : (
        <>
          <CardFace card={card} side={side} meta={`${card.c} · ${Math.min(i, deck.length - 1) + 1} of ${deck.length}${flags[card.id] ? " · flagged" : ""}`} onFlip={() => setSide((s) => (s + 1) % 3)} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => go(-1)} className="min-h-[44px] flex-1 rounded-lg border border-border px-4 text-sm text-foreground hover:bg-surface-hover sm:flex-none">Prev</button>
            <button type="button" onClick={() => go(1)} className="min-h-[44px] flex-1 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-hover sm:flex-none">Next</button>
            <button type="button" onClick={shuffle} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:text-foreground"><Shuffle className="size-4" />Shuffle</button>
            <button type="button" aria-pressed={!!flags[card.id]} onClick={() => onFlag(card.id, !flags[card.id])} className={cn("inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-3 text-sm", flags[card.id] ? "font-medium text-amber-800 dark:text-amber-400" : "text-muted hover:text-foreground")}>
              <Flag className="size-4" />{flags[card.id] ? "Flagged" : "Flag for practice"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Plan (read-only) ─────────────────────────────────────────────────────────

/** A long bullet with a bold lead-in: the lead-in first, the rest on tap. */
function FoldItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { lead, rest } = splitLeadIn(text);
  return (
    <li>
      <strong className="font-semibold text-foreground">{lead}</strong>{" "}
      {open ? <Inline text={rest} /> : null}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ml-1 text-xs text-brand-text underline-offset-2 hover:underline">
        {open ? "less" : "more"}
      </button>
    </li>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, k) => {
        if (b.type === "table") return <Table key={k} head={b.head} rows={b.rows} />;
        if (b.type === "p") return <p key={k} className="mt-2 text-sm text-muted"><Inline text={b.text} /></p>;
        if (b.type === "quote") return <p key={k} className="mt-2 border-l-2 border-border pl-3 text-sm text-muted"><Inline text={b.text} /></p>;
        if (b.type === "ul" || b.type === "ol") {
          const L = b.type === "ul" ? "ul" : "ol";
          return (
            <L key={k} className={cn("mt-2 space-y-1.5 pl-5 text-sm text-muted", b.type === "ul" ? "list-disc" : "list-decimal")}>
              {b.items.map((x, j) => (isFoldable(x) ? <FoldItem key={j} text={x} /> : <li key={j}><Inline text={x} /></li>))}
            </L>
          );
        }
        return null;
      })}
    </>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[28rem] border-collapse text-left text-xs sm:text-sm">
        <thead className="bg-surface-hover"><tr>{head.map((h, j) => <th key={j} className="px-2.5 py-1.5 font-semibold text-foreground"><Inline text={h} /></th>)}</tr></thead>
        <tbody>{rows.map((r, j) => <tr key={j} className="border-t border-border align-top">{r.map((c, m) => <td key={m} className="px-2.5 py-1.5 text-muted"><Inline text={c} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Controlled open state (one per section), so each chevron always matches its own section. */
function SectionView({ s, id, open, onToggle, openIds }: { s: Section; id: string; open: boolean; onToggle: (id: string) => void; openIds: Set<string> }) {
  const summary = sectionSummary(s);
  return (
    <section id={id} className="scroll-mt-20 rounded-lg border border-border">
      <button type="button" onClick={() => onToggle(id)} aria-expanded={open} className="flex min-h-[48px] w-full items-start gap-2 px-3 py-2.5 text-left">
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-faint transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">{s.title}</span>
          {!open && summary && <span className="mt-0.5 block text-xs leading-snug text-muted">{summary}</span>}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <Blocks blocks={s.blocks} />
          {s.children.length > 0 && (
            <div className="mt-3 space-y-2">
              {s.children.map((c, k) => <SectionView key={k} s={c} id={`${id}-${k}`} open={openIds.has(`${id}-${k}`)} onToggle={onToggle} openIds={openIds} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Plan({ plan, cards, initialQuery = "" }: { plan: Section[]; cards: Card[]; initialQuery?: string }) {
  const top = plan.length === 1 ? plan[0] : null;
  const sections = top ? top.children : plan;
  const [q, setQ] = useState(initialQuery);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpenIds((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const jump = (id: string) => {
    setOpenIds((o) => new Set(o).add(id));
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const hits = useMemo(() => (q.trim().length >= 2 ? searchPlan(plan, q) : null), [plan, q]);
  const cardHits = useMemo(() => (q.trim().length >= 2 ? searchCards(cards, q) as Card[] : []), [cards, q]);

  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Search the plan and flashcards</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the plan and flashcards"
          className="min-h-[44px] w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm text-foreground placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand-text/30"
        />
      </label>

      {hits ? (
        <div className="mt-4 space-y-3">
          <p className="text-xs text-faint">{hits.length} plan section{hits.length === 1 ? "" : "s"} · {cardHits.length} flashcard{cardHits.length === 1 ? "" : "s"}</p>
          {hits.map((h, k) => (
            <div key={k} className="rounded-lg border border-border p-3">
              <p className="text-xs text-faint">{h.path.slice(top ? 1 : 0, -1).join(" › ")}</p>
              <p className="text-sm font-semibold text-foreground">{h.title}</p>
              <Blocks blocks={h.blocks as Block[]} />
            </div>
          ))}
          {cardHits.map((c) => (
            <div key={c.id} className="rounded-lg border border-border bg-surface p-3">
              <p className="text-xs text-faint">Flashcard · {c.c}</p>
              <p className="text-sm font-semibold text-foreground">{c.q}</p>
              <p className="mt-1 text-sm text-muted">{c.one}</p>
            </div>
          ))}
          {!hits.length && !cardHits.length && <p className="text-sm text-muted">Nothing matches “{q.trim()}”.</p>}
        </div>
      ) : (
        <>
          {top && <p className="mt-4 text-sm font-medium text-foreground">{top.title}</p>}
          <nav aria-label="Plan contents" className="mt-3 rounded-lg bg-surface-hover/50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-faint">Contents</p>
            <ol className="mt-1.5 space-y-0.5">
              {sections.map((s, k) => (
                <li key={k}>
                  <button type="button" onClick={() => jump(`plan-${k}`)} className="min-h-[34px] w-full py-1 text-left text-sm leading-snug text-foreground hover:text-brand-text">{s.title}</button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="mt-4 space-y-2">{sections.map((s, k) => <SectionView key={k} s={s} id={`plan-${k}`} open={openIds.has(`plan-${k}`)} onToggle={toggle} openIds={openIds} />)}</div>
        </>
      )}
    </div>
  );
}
