"use client";
// hunt: the Jobs Map. Plain SVG, no chart library. Calm on purpose: two toggles, one legend,
// one tooltip. Hover (or tap on a phone) shows the details; a click (or "Open") opens the job.
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { LOCATION_GROUPS, ROLE_FAMILIES, payTicks, visiblePoints } from "@/lib/hunt-map.mjs";
import { referralLinks } from "@/lib/hunt-referrals.mjs";

export type MapPoint = {
  url: string; x: number; y: number; fit: number; fitFrom: "full" | "group" | "quick"; estimated: boolean;
  loc: string; family: string; company: string; title: string; location: string;
  base: [number, number] | null; basis: string | null; tc: number | null; tcConfidence: string | null;
  rank: number | null; why: string; status: string; tracker: string | null; belowFloor: boolean; inDefault: boolean;
};

// Validated with the dataviz palette checker (all-pairs, scatter): 4 hues + a neutral "Other".
const LOC_VAR: Record<string, string> = {
  "Home area": "var(--tm-home)",
  Remote: "var(--tm-remote)",
  "Secondary area": "var(--tm-second)",
  Other: "var(--tm-other)",
};
const STYLE = `
.tmap{--tm-home:#2a78d6;--tm-remote:#1baf7a;--tm-second:#eb6834;--tm-other:#a3a29c;--tm-grid:hsl(40 9% 90%)}
.dark .tmap{--tm-home:#3987e5;--tm-remote:#199e70;--tm-second:#d95926;--tm-other:#6f6e69;--tm-grid:#222}
`;

const k = (n: number) => `$${Math.round(n / 1000)}k`;

/** Shape slot per family: the families' order on the legend (0 circle, 1 square, 2 triangle, 3 diamond), "Other" last. */
function slotOf(family: string, families: readonly string[]): number {
  if (family === "Other") return 4;
  const i = families.indexOf(family);
  return i >= 0 && i < 4 ? i : 4;
}

function Shape({ family, families = ROLE_FAMILIES, x, y, r, color, hollow, dim }: { family: string; families?: readonly string[]; x: number; y: number; r: number; color: string; hollow: boolean; dim?: boolean }) {
  // Built-in software families keep their old shapes: Backend circle, Full-stack square, FDE triangle, Payments diamond.
  const order = families === ROLE_FAMILIES ? ["Backend/Infra", "Full-stack", "FDE/Applied AI", "Payments/Fintech"] : families;
  const slot = slotOf(family, order);
  const common = {
    fill: hollow ? "var(--surface)" : color,
    stroke: hollow ? color : "var(--surface)",
    strokeWidth: hollow ? 2 : 1.5,
    opacity: dim ? 0.25 : 0.95,
  };
  if (slot === 1) return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} rx={1.5} {...common} />;
  if (slot === 2) return <path d={`M${x},${y - r * 1.1} L${x + r},${y + r * 0.75} L${x - r},${y + r * 0.75}Z`} strokeLinejoin="round" {...common} />;
  if (slot === 3) return <path d={`M${x},${y - r * 1.15} L${x + r * 1.05},${y} L${x},${y + r * 1.15} L${x - r * 1.05},${y}Z`} strokeLinejoin="round" {...common} />;
  if (slot === 4) return <path d={`M${x},${y + r * 1.1} L${x + r},${y - r * 0.75} L${x - r},${y - r * 0.75}Z`} strokeLinejoin="round" {...common} />;
  return <circle cx={x} cy={y} r={r} {...common} />;
}

function LegendShape({ family, families, color = "var(--muted)", hollow = false }: { family: string; families?: readonly string[]; color?: string; hollow?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <Shape family={family} families={families} x={7} y={7} r={5} color={color} hollow={hollow} />
    </svg>
  );
}

// "Who do I know here?" — 1st-degree LinkedIn people search for the point's company.
const firstDegree = (p: MapPoint) => referralLinks(p.company)?.first ?? null;

function openJob(p: MapPoint, router: ReturnType<typeof useRouter>) {
  if (p.tracker) router.push(`/pipeline/${encodeURIComponent(p.tracker)}`);
  else window.open(p.url, "_blank", "noopener,noreferrer");
}

export function JobMap({ points, noPay, baseFloor = null, families: familyNames = null }: { points: MapPoint[]; noPay: number; baseFloor?: number | null; families?: string[] | null }) {
  const fams: readonly string[] = familyNames && familyNames.length ? [...familyNames, "Other"] : ROLE_FAMILIES;
  const shapeFams: readonly string[] = familyNames && familyNames.length ? familyNames : ROLE_FAMILIES;
  const floor = baseFloor && baseFloor > 0 ? baseFloor : null;
  const ref = floor ?? 100_000;
  const router = useRouter();
  const [all, setAll] = useState(false);
  const [below, setBelow] = useState(false);
  const [hiddenLoc, setHiddenLoc] = useState<string[]>([]);
  const [hiddenFamily, setHiddenFamily] = useState<string[]>([]);
  const [hover, setHover] = useState<MapPoint | null>(null);
  const [picked, setPicked] = useState<MapPoint | null>(null);
  const [width, setWidth] = useState(720);
  const box = useRef<HTMLDivElement>(null);
  const pointerType = useRef<string>("mouse");

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scoped = useMemo(() => visiblePoints(points, { all, belowFloor: below }) as MapPoint[], [points, all, below]);
  const shown = useMemo(() => scoped.filter((p) => !hiddenLoc.includes(p.loc) && !hiddenFamily.includes(p.family)), [scoped, hiddenLoc, hiddenFamily]);
  const count = (key: "loc" | "family", v: string) => scoped.filter((p) => p[key] === v).length;

  const phone = width < 560;
  const H = phone ? 360 : 460;
  const M = { l: phone ? 44 : 56, r: 14, t: 22, b: 40 };
  const ys = scoped.map((p) => p.y);
  const yMin = Math.min(ref - 50_000, ...(ys.length ? ys : [ref]));
  const yMax = Math.max(ref + 100_000, ...(ys.length ? ys : [ref]));
  const ticks = payTicks(yMin, yMax);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  // Fit axis starts just left of the lowest fit shown, so a tight cluster gets the room.
  // A few low outliers are pinned to the left edge instead of squeezing everyone else.
  const fits = scoped.map((p) => p.fit).sort((a, b) => a - b);
  const x0 = Math.max(0.8, Math.floor(Math.min(5, fits[Math.floor(fits.length * 0.03)] ?? 1)) - 0.3);
  const xTicks = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].filter((t) => t >= x0 && (5.2 - x0 <= 2.6 || Number.isInteger(t)));
  const sx = (v: number) => M.l + ((Math.max(v, x0 + 0.05) - x0) / (5.2 - x0)) * (width - M.l - M.r);
  const sy = (v: number) => M.t + (1 - (v - y0) / (y1 - y0)) * (H - M.t - M.b);
  const r = phone ? 5 : 5.5;

  function nearest(clientX: number, clientY: number, svg: SVGSVGElement, within: number): MapPoint | null {
    const b = svg.getBoundingClientRect();
    const mx = ((clientX - b.left) / b.width) * width;
    const my = ((clientY - b.top) / b.height) * H;
    let best: MapPoint | null = null, bd = within * within;
    for (const p of shown) {
      const d = (sx(p.x) - mx) ** 2 + (sy(p.y) - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const tip = picked ?? hover;

  return (
    <div className="tmap mt-5">
      <style>{STYLE}</style>
      <p className="text-sm text-muted">
        Further right fits you better. Higher pays more. Hollow marks are estimated total comp; solid marks are the posted base.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Chip on={all} onClick={() => { setAll((v) => !v); setPicked(null); }}>All jobs</Chip>
        {floor && <Chip on={below} onClick={() => { setBelow((v) => !v); setPicked(null); }}>Below {k(floor)} too</Chip>}
        <span className="text-xs text-faint">
          {shown.length} shown{!all ? " · Shortlist + head-to-head top 100" : " · one per duplicate group"}{noPay ? ` · ${noPay} with no pay listed are left out` : ""}
        </span>
      </div>

      <div ref={box} className="relative mt-4 w-full">
        <svg
          viewBox={`0 0 ${width} ${H}`}
          width="100%"
          height={H}
          role="img"
          aria-label={`Scatter chart of ${shown.length} jobs: fit against pay`}
          className="touch-manipulation select-none"
          onPointerDown={(e) => { pointerType.current = e.pointerType; }}
          onPointerMove={(e) => { if (e.pointerType === "mouse") setHover(nearest(e.clientX, e.clientY, e.currentTarget, 18)); }}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => {
            const p = nearest(e.clientX, e.clientY, e.currentTarget, pointerType.current === "mouse" ? 18 : 26);
            if (pointerType.current === "mouse") {
              // Shift-click: who do I know here? (1st-degree LinkedIn search, named in the tooltip)
              const ref = p && e.shiftKey ? firstDegree(p) : null;
              if (ref) window.open(ref.url, "_blank", "noopener,noreferrer");
              else if (p) openJob(p, router);
              return;
            }
            setPicked(p);
          }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={sy(t)} y2={sy(t)} stroke="var(--tm-grid)" strokeWidth={1} />
              <text x={M.l - 8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--faint)">{k(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={H - M.b + 18} textAnchor="middle" fontSize={11} fill="var(--faint)">{t}</text>
          ))}
          <text x={M.l + (width - M.l - M.r) / 2} y={H - 4} textAnchor="middle" fontSize={11} fill="var(--muted)">Fit (1–5) →</text>
          <text x={M.l} y={M.t - 2} fontSize={11} fill="var(--muted)">↑ Pay</text>
          {floor && <line x1={M.l} x2={width - M.r} y1={sy(floor)} y2={sy(floor)} stroke="var(--muted)" strokeWidth={1.25} strokeDasharray="5 4" />}
          {floor && <text x={M.l + 6} y={sy(floor) - 6} fontSize={11} fill="var(--muted)">{k(floor)} base floor</text>}
          {shown.map((p) => (
            <Shape key={p.url} family={p.family} families={shapeFams} x={sx(p.x)} y={sy(p.y)} r={r} color={LOC_VAR[p.loc]} hollow={p.estimated} dim={!!tip && tip.url !== p.url} />
          ))}
          {tip && <circle cx={sx(tip.x)} cy={sy(tip.y)} r={r + 5} fill="none" stroke="var(--fg)" strokeWidth={1.5} pointerEvents="none" />}
        </svg>

        {hover && !picked && !phone && (
          <div
            className="pointer-events-none absolute z-10 w-72 rounded-lg border border-border bg-surface p-3 text-sm shadow-lg"
            style={{ left: Math.min(Math.max(8, sx(hover.x) + 14), width - 296), top: Math.max(0, Math.min(sy(hover.y) - 20, H - 220)) }}
          >
            <Details p={hover} />
            <p className="mt-2 text-xs text-faint">Click to open{firstDegree(hover) ? ` · Shift-click: ${firstDegree(hover)!.label}` : ""}</p>
          </div>
        )}
      </div>

      {picked && (
        <div className="mt-3 rounded-xl border border-border bg-surface p-4 text-sm shadow-sm">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><Details p={picked} /></div>
            <button type="button" aria-label="Close" onClick={() => setPicked(null)} className="-m-2 p-2 text-faint hover:text-foreground"><X className="size-4" /></button>
          </div>
          {firstDegree(picked) && (
            <a href={firstDegree(picked)!.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-[44px] items-center gap-1 text-xs text-brand-text hover:underline">
              {firstDegree(picked)!.label} <ExternalLink className="size-3" />
            </a>
          )}
          <button type="button" onClick={() => openJob(picked, router)} className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-hover">
            Open {picked.tracker ? "job" : "posting"}{!picked.tracker && <ExternalLink className="size-3.5" />}
          </button>
        </div>
      )}

      <div className="mt-5 space-y-3">
        <div>
          <p className="text-xs font-medium text-faint">Location · tap to hide or show</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {LOCATION_GROUPS.map((g: string) => (
              <Chip key={g} on={!hiddenLoc.includes(g)} onClick={() => toggle(hiddenLoc, setHiddenLoc, g)} muted>
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: LOC_VAR[g] }} aria-hidden />
                {g}<span className="text-faint">{count("loc", g)}</span>
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium text-faint">Role</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {fams.map((f: string) => (
              <Chip key={f} on={!hiddenFamily.includes(f)} onClick={() => toggle(hiddenFamily, setHiddenFamily, f)} muted>
                <LegendShape family={f} families={shapeFams} />{f}<span className="text-faint">{count("family", f)}</span>
              </Chip>
            ))}
          </div>
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
          <span className="inline-flex items-center gap-1.5"><LegendShape family={shapeFams[0]} families={shapeFams} /> posted base</span>
          <span className="inline-flex items-center gap-1.5"><LegendShape family={shapeFams[0]} families={shapeFams} hollow /> estimated TC</span>
          <span className="inline-flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke="var(--muted)" strokeDasharray="4 3" strokeWidth="1.25" /></svg> $200k base floor</span>
        </p>
      </div>
    </div>
  );
}

function Chip({ on, onClick, children, muted }: { on: boolean; onClick: () => void; children: React.ReactNode; muted?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 text-xs transition-opacity",
        muted ? (on ? "border-border text-foreground" : "border-dashed border-border text-faint opacity-60") : on ? "border-brand-text bg-brand-soft font-medium text-brand-text" : "border-border text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Details({ p }: { p: MapPoint }) {
  const base = p.base ? (p.base[0] === p.base[1] ? k(p.base[0]) : `${k(p.base[0])}–${k(p.base[1])}`) : null;
  return (
    <div className="space-y-1">
      <p className="font-semibold leading-snug text-foreground">{p.company}</p>
      <p className="leading-snug text-foreground">{p.title}</p>
      <p className="text-xs text-muted">{p.location || p.loc}</p>
      <p className="text-xs text-muted">
        {base ? `${p.basis === "OTE" ? "OTE" : "Base"} ${base}` : "No base listed"}
        {p.tc ? ` · est. TC ~${k(p.tc)}${p.tcConfidence ? ` (${p.tcConfidence})` : ""}` : ""}
      </p>
      <p className="text-xs text-muted">
        {p.rank ? `True rank #${p.rank} · ` : ""}{p.fitFrom === "quick" ? `Quick score ${p.fit}/5` : `Fit ${p.fit}/5${p.fitFrom === "group" ? " (via group)" : ""}`} · {p.status}
      </p>
      {p.why && <p className="text-xs leading-snug text-faint">{p.why}</p>}
    </div>
  );
}
