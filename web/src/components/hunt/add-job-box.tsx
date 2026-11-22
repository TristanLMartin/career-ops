"use client";
// hunt: "Add a job" box. Paste a URL; it is checked for duplicates, read, added to
// the inbox and ranked (no AI). "Score fit" then runs the normal evaluate flow.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RankDetails } from "@/components/hunt/rank-badges";
import type { HuntEnrichment } from "@/lib/hunt-types";

type Result =
  | { status: "duplicate"; reason: string; similar?: boolean; match: { num?: number | string; company: string; role: string; status?: string; url?: string } }
  | { status: "added"; job: { url: string; company: string; title: string; hasDescription: boolean }; enrichment: HuntEnrichment | null; note?: string }
  | { status: "need-details"; message: string; known?: { company: string; title: string } }
  | { status: "error"; message: string };

export function AddJobBox({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [details, setDetails] = useState({ company: "", title: "", location: "", jd: "" });
  const [needDetails, setNeedDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [score, setScore] = useState<{ state: "idle" | "running" | "done" | "error"; text?: string }>({ state: "idle" });

  async function submit(force = false) {
    if (!url.trim()) return;
    setBusy(true);
    setScore({ state: "idle" });
    try {
      const res = await fetch("/api/profile/add-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), ...(needDetails ? details : {}), force }),
      });
      const r = (await res.json()) as Result;
      setResult(r);
      if (r.status === "need-details") {
        setNeedDetails(true);
        setDetails((d) => ({ ...d, company: d.company || r.known?.company || "", title: d.title || r.known?.title || "" }));
      }
      if (r.status === "added") { setNeedDetails(false); router.refresh(); }
    } catch {
      setResult({ status: "error", message: "Couldn't reach the dashboard server." });
    } finally {
      setBusy(false);
    }
  }

  async function scoreFit(jobUrl: string) {
    setScore({ state: "running" });
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "evaluate", input: jobUrl, cliId: "claude" }) });
      const text = await res.text();
      let verdict = "";
      let last: { type?: string; msg?: string; reportN?: number } | null = null;
      for (const line of text.split("\n")) {
        try {
          const o = JSON.parse(line);
          if (o.type === "text") verdict += o.text;
          if (o.type === "done" || o.type === "error") last = o;
        } catch { /* keepalive or partial line */ }
      }
      const v = verdict.match(/VERDICT:\s*([^\n⚠]+)/)?.[1]?.trim();
      if (last?.type === "done") { setScore({ state: "done", text: v ?? "Scored. See Jobs → Evaluated." }); router.refresh(); }
      else setScore({ state: "error", text: last?.msg ?? "Scoring didn't finish." });
    } catch {
      setScore({ state: "error", text: "Scoring didn't finish." });
    }
  }

  return (
    <section aria-labelledby="add-job" className={compact ? "" : "rounded-xl border border-border bg-surface p-4"}>
      <h2 id="add-job" className="text-sm font-semibold text-foreground">Add a job you found</h2>
      <form
        className="mt-2 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => { setUrl(e.target.value); setResult(null); setNeedDetails(false); }}
          placeholder="Paste a job link (Greenhouse, Lever, Ashby, Workday, LinkedIn, a careers page…)"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
          aria-label="Job URL"
        />
        <button type="submit" disabled={busy} className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground disabled:opacity-60 max-sm:w-full">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add
        </button>
      </form>

      {needDetails && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <p className="text-xs text-muted sm:col-span-2">{result?.status === "need-details" ? result.message : ""}</p>
          <input value={details.company} onChange={(e) => setDetails({ ...details, company: e.target.value })} placeholder="Company" aria-label="Company" className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
          <input value={details.title} onChange={(e) => setDetails({ ...details, title: e.target.value })} placeholder="Job title" aria-label="Job title" className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
          <input value={details.location} onChange={(e) => setDetails({ ...details, location: e.target.value })} placeholder="Location (optional)" aria-label="Location" className="rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          <textarea value={details.jd} onChange={(e) => setDetails({ ...details, jd: e.target.value })} placeholder="Paste the job description (optional, helps pay and relevance)" aria-label="Job description" rows={4} className="rounded-md border border-border bg-background px-3 py-2 text-sm sm:col-span-2" />
          <button type="button" onClick={() => void submit()} disabled={busy || !details.company.trim() || !details.title.trim()} className="justify-self-start rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground disabled:opacity-60">Add with these details</button>
        </div>
      )}

      {result?.status === "duplicate" && (
        <div className="mt-3 rounded-md bg-amber-500/10 p-3 text-sm">
          <p className="font-medium text-amber-900 dark:text-amber-300">{result.similar ? "Looks like one you already have" : "Already tracked"}: {result.match.company} · {result.match.role}{result.match.status ? ` (${result.match.status})` : ""}</p>
          <p className="mt-0.5 text-xs text-muted">Matched on {result.reason}.</p>
          <p className="mt-1.5 flex gap-3 text-xs">
            {typeof result.match.num === "number" ? <Link href={`/pipeline/${result.match.num}`} className="font-medium text-brand-text hover:underline">Open it</Link> : <Link href="/pipeline" className="font-medium text-brand-text hover:underline">Open Jobs</Link>}
            {result.similar && <button type="button" onClick={() => void submit(true)} className="text-muted hover:text-foreground">It&apos;s different, add it anyway</button>}
          </p>
        </div>
      )}

      {result?.status === "added" && (
        <div className="mt-3 rounded-md bg-emerald-500/10 p-3 text-sm">
          <p className="font-medium text-foreground">Added: {result.job.company} · {result.job.title}</p>
          {result.note && <p className="mt-0.5 text-xs text-muted">{result.note}</p>}
          <div className="mt-1.5"><RankDetails e={result.enrichment} /></div>
          <div className="mt-2 flex items-center gap-3 text-xs">
            {score.state === "idle" && (
              <button type="button" onClick={() => void scoreFit(result.job.url)} className="rounded-md border border-border px-2.5 py-1 font-medium text-brand-text hover:bg-surface-hover">Score fit (about 3 min)</button>
            )}
            {score.state === "running" && <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 className="size-3.5 animate-spin" /> Scoring against your CV…</span>}
            {score.state === "done" && <Badge tone="good">{score.text}</Badge>}
            {score.state === "error" && <span className="text-red-700 dark:text-red-400">{score.text}</span>}
          </div>
        </div>
      )}

      {result?.status === "error" && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{result.message}</p>}
    </section>
  );
}
