"use client";
// hunt: one compact "Tailor & apply" panel on the job page, the one place for "I want to apply":
//   Deep dive       → the full upstream evaluation (modes/oferta.md) for this job only, on demand:
//                     customization plan, interview prep, STAR stories, research, drafts. The
//                     ranked score stays the lite one unless the candidate picks the deep one.
//   Tailored resume → upstream's own GeneratePdfButton (/api/run kind "pdf", fact-gated render)
//   Cover letter    → the four modes/cover.md Step 6 answers (prefilled from the report), then
//                     /api/profile/tailor kind "cover" (real cover mode, PDF rendered + fact-gated)
//   Apply answers   → /api/profile/tailor kind "answers" (real apply mode, no browser, each
//                     answer fact-gated; blocked ones are flagged, never hidden)
// Nothing here submits, sends, opens a browser or changes a tracker status.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { FileText, ListChecks, Loader2, Mail, Telescope, TriangleAlert } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { GeneratePdfButton } from "@/components/generate-pdf-button";
import { COVER_QUESTIONS } from "@/lib/cover-answers.mjs";
import { COVER_TONES } from "@/lib/cover-tones.mjs";

type Gate = { question: string; answer: string; verdict: string; findings: { kind: string; value: string }[]; needs_you?: boolean; note?: string };
type Run = { state: "running" | "done" | "failed"; error?: string | null; outputs?: Record<string, string>; answers?: Gate[]; verdict?: string; brief?: Record<string, string>; costUsd?: number } | null;
type Brief = { why: string; problem: string; approach: string; tone: string };
type DeepEntry = { lite_score?: number | null; deep_score?: number | null; deep_report?: number | null; use?: "lite" | "deep"; started_at?: string; done_at?: string } | null;
export type DeepDive = { url: string; estUsd: number | null; entry: DeepEntry };

const pill = "inline-flex items-center justify-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]";
const quiet = `${pill} border-border text-muted hover:border-brand/40 hover:text-brand-text`;
const busy = `${pill} border-brand/40 bg-brand-soft text-brand-text`;
const ready = `${pill} border-emerald-500/40 bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/15 dark:text-emerald-400`;
const field = "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-brand/50 focus:outline-none";

export function TailorApplyPanel({ n, reportNum, company, cvOnDisk, showCv, suggest, applyHref, deep }: {
  n: string;
  reportNum: number | null;
  company: string;
  cvOnDisk: boolean;
  showCv: boolean;
  suggest: Brief;
  applyHref?: string;
  deep?: DeepDive;
}) {
  const { startJob } = useJobs();
  const [deepEntry, setDeepEntry] = useState<DeepEntry>(deep?.entry ?? null);
  const [deepStarted, setDeepStarted] = useState(false);
  const deepDone = deepEntry?.deep_report != null;
  const fmt = (v?: number | null) => (typeof v === "number" ? v.toFixed(1) : "?");
  const deepCost = deep?.estUsd != null ? ` · ≈$${deep.estUsd.toFixed(2)}` : "";
  const [runs, setRuns] = useState<{ cover: Run; answers: Run }>({ cover: null, answers: null });
  const [open, setOpen] = useState<"cover" | "answers" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = reportNum == null ? null : String(reportNum);

  const startDeep = () => {
    if (!deep) return;
    const id = startJob({ title: `Deep dive · ${company}`, subtitle: "Full evaluation", kind: "evaluate", evaluationScope: "deep", input: deep.url, page: `/pipeline/${encodeURIComponent(n)}` });
    if (id) setDeepStarted(true); else setError("Could not start the deep dive.");
  };
  const chooseScore = async (use: "lite" | "deep") => {
    if (!deep) return;
    setError(null);
    const r = await fetch("/api/profile/deep-dive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: deep.url, use }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setError(j.error ?? "Could not change the score.");
    else setDeepEntry(j.entry);
  };

  const load = useCallback(async () => {
    if (!report) return;
    try {
      const r = await fetch(`/api/profile/tailor?report=${report}`, { cache: "no-store" });
      if (r.ok) setRuns(await r.json());
    } catch { /* offline: keep the last state */ }
  }, [report]);

  useEffect(() => { load(); }, [load]);
  const running = runs.cover?.state === "running" || runs.answers?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  const start = async (kind: "cover" | "answers", brief?: Brief) => {
    setError(null);
    const r = await fetch("/api/profile/tailor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ report, kind, brief }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not start.");
    if (kind === "cover") setOpen(null);
    if (kind === "answers") setOpen("answers");
    load();
  };

  const submitCover = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    start("cover", { why: String(d.get("why") ?? ""), problem: String(d.get("problem") ?? ""), approach: String(d.get("approach") ?? ""), tone: String(d.get("tone") ?? "mirror") });
  };

  const prefill = runs.cover?.brief ?? suggest;
  const answers = runs.answers?.answers ?? [];
  const blocked = answers.filter((a) => a.verdict === "block").length;
  const needsYou = answers.filter((a) => a.needs_you).length;

  return (
    <section aria-label="Tailor and apply" className="basis-full rounded-2xl border border-border bg-surface/40 px-4 py-3 print:hidden">
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Tailor &amp; apply</p>
      {!report ? (
        <p className="mt-2 text-sm text-muted">Evaluate this job first, then tailor from its report.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {deep && (deepStarted ? (
            <span className={busy}><Loader2 className="size-3.5 motion-safe:animate-spin" /> Deep dive running… (Workers tray)</span>
          ) : deepDone ? (
            <button type="button" onClick={startDeep} title="Run the full evaluation again" className={ready}><Telescope className="size-3.5" /> Deep dive done · redo{deepCost}</button>
          ) : (
            <button type="button" onClick={startDeep} title="Full evaluation for this job: customization plan, interview prep, STAR stories, salary research, drafts" className={`${pill} border-brand/40 bg-brand-soft text-brand-text hover:border-brand/60`}><Telescope className="size-3.5" /> Deep dive{deepCost}</button>
          ))}
          {showCv && <GeneratePdfButton n={n} company={company} onDisk={cvOnDisk} />}

          {runs.cover?.state === "running" ? (
            <span className={busy}><Loader2 className="size-3.5 motion-safe:animate-spin" /> Writing cover letter…</span>
          ) : runs.cover?.state === "done" && runs.cover.outputs?.pdf ? (
            <span className="inline-flex items-center gap-1">
              <a href={`/api/profile/tailor/file?report=${report}&kind=cover`} target="_blank" rel="noreferrer" className={ready}><FileText className="size-3.5" /> Cover letter (PDF)</a>
              <button type="button" onClick={() => setOpen(open === "cover" ? null : "cover")} className="text-xs text-faint hover:text-brand-text max-sm:min-h-[44px]">redo</button>
            </span>
          ) : (
            <button type="button" onClick={() => setOpen(open === "cover" ? null : "cover")} aria-expanded={open === "cover"} className={quiet}><Mail className="size-3.5" /> Cover letter</button>
          )}

          {runs.answers?.state === "running" ? (
            <span className={busy}><Loader2 className="size-3.5 motion-safe:animate-spin" /> Drafting answers…</span>
          ) : runs.answers?.state === "done" ? (
            <span className="inline-flex items-center gap-1">
              <button type="button" onClick={() => setOpen(open === "answers" ? null : "answers")} aria-expanded={open === "answers"} className={blocked ? `${pill} border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-400` : ready}>
                <ListChecks className="size-3.5" /> Apply answers{blocked ? ` · ${blocked} flagged` : ""}
              </button>
              <button type="button" onClick={() => start("answers")} className="text-xs text-faint hover:text-brand-text max-sm:min-h-[44px]">redo</button>
            </span>
          ) : (
            <button type="button" onClick={() => start("answers")} className={quiet}><ListChecks className="size-3.5" /> Apply answers</button>
          )}
        </div>
      )}

      {deep && report && !deepDone && !deepStarted && (
        <p className="mt-2 text-xs text-muted">Scored with a lite evaluation. Deep dive adds the customization plan, interview prep, salary research and drafts; run it before tailoring.</p>
      )}
      {deep && deepDone && (
        <p className="mt-2 text-xs text-muted">
          {deepEntry?.use === "deep" ? (
            <>Ranked by the deep dive score {fmt(deepEntry?.deep_score)}. <button type="button" onClick={() => chooseScore("lite")} className="underline hover:text-brand-text max-sm:min-h-[44px]">Use lite score {fmt(deepEntry?.lite_score)}</button></>
          ) : (
            <>Ranked by the lite score {fmt(deepEntry?.lite_score)}; deep dive scored {fmt(deepEntry?.deep_score)}.{" "}
              {typeof deepEntry?.deep_score === "number" && <button type="button" onClick={() => chooseScore("deep")} className="underline hover:text-brand-text max-sm:min-h-[44px]">Use {fmt(deepEntry?.deep_score)}</button>}</>
          )}
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
      {(["cover", "answers"] as const).map((k) => runs[k]?.state === "failed" && (
        <p key={k} role="alert" className="mt-2 flex items-start gap-1 text-xs text-red-700 dark:text-red-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{k === "cover" ? "Cover letter" : "Apply answers"}: {runs[k]?.error}</span>
        </p>
      ))}

      {open === "cover" && report && (
        <form onSubmit={submitCover} aria-label="Cover letter questions" className="mt-3 border-t border-border pt-3">
          <p className="mb-2 text-xs text-muted">Suggestions from the report. Edit them into your own words.</p>
          {COVER_QUESTIONS.map((q) => (
            <label key={q.name} className="mb-3 block text-sm font-medium text-foreground">
              {q.label}
              <textarea name={q.name} required maxLength={1000} rows={2} defaultValue={prefill?.[q.name as keyof Brief] ?? ""} className={field} />
            </label>
          ))}
          <label className="mb-3 block text-sm font-medium text-foreground">
            Tone
            <select name="tone" defaultValue={prefill?.tone || "mirror"} className={field}>
              {Object.entries(COVER_TONES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm hover:bg-brand-200 max-sm:min-h-[44px]"><Mail className="size-3.5" /> Write cover letter</button>
            <button type="button" onClick={() => setOpen(null)} className="text-xs text-muted hover:text-brand-text max-sm:min-h-[44px]">Cancel</button>
          </div>
        </form>
      )}

      {open === "answers" && runs.answers?.state === "done" && (
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs text-muted">
            Drafts to paste into the form. Nothing was submitted.{needsYou ? ` ${needsYou} need your input.` : ""}{" "}
            <a href={`/api/profile/tailor/file?report=${report}&kind=answers`} target="_blank" rel="noreferrer" className="underline hover:text-brand-text">Open as text</a>
            {applyHref && <> · <Link href={applyHref} className="underline hover:text-brand-text">Apply checklist</Link></>}
          </p>
          <ol className="mt-2 space-y-3">
            {answers.map((a, i) => (
              <li key={i} className="text-sm">
                <p className="font-medium text-foreground">{a.question}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{a.answer || <span className="text-muted">(no answer)</span>}</p>
                {a.verdict === "block" && <p className="mt-0.5 text-xs text-red-700 dark:text-red-400">Not backed by your files: {a.findings.map((f) => f.value).join(", ")}. Fix before using.</p>}
                {a.needs_you && <p className="mt-0.5 text-xs text-amber-900 dark:text-amber-300">Needs you{a.note ? `: ${a.note}` : ""}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
