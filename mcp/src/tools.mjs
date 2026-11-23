// The MCP tools. Reads use ProfileData (files + the dashboard's helpers); writes go through
// the dashboard's HTTP endpoints. No delete tools, nothing that sends email or messages.
import { z } from "zod";
import { ToolError, resolveProfile } from "./config.mjs";
import { ProfileData, jobId } from "./data.mjs";
import { dashboardPost, dashboardGetJson } from "./dashboard-client.mjs";
import { localWhen, trackerLabel, parseTrackerRef } from "./format.mjs";
import { evalTools, runHook } from "./eval-tools.mjs";
import { studyTools } from "./study-tools.mjs";

const k = (n) => `$${Math.round(n / 1000)}k`;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function validDay(s) {
  const m = ISO_DAY.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}

function baseLabel(e) {
  const p = e?.pay;
  if (!p || p.currency !== "USD" || !Number.isFinite(p.annualMin)) return null;
  return p.annualMin === p.annualMax ? k(p.annualMin) : `${k(p.annualMin)}–${k(p.annualMax)}`;
}
function tcLabel(e) {
  const t = e?.tc_est;
  return t && Number.isFinite(t.usd) ? `${k(t.usd)}${t.confidence ? ` (${t.confidence})` : ""}` : null;
}
const payNumber = (e) => e?.tc_est?.usd ?? (e?.pay?.currency === "USD" ? e.pay.annualMax : null) ?? null;

function trackerPayLabel(r) {
  const base = r.base ? (r.base[0] === r.base[1] ? k(r.base[0]) : `${k(r.base[0])}–${k(r.base[1])}`) : "";
  return [base, r.tc ? `TC ~${k(r.tc)}` : ""].filter(Boolean).join(" · ") || null;
}

/** Jobs plus the tracker cross-reference, the way the Jobs page joins them. */
async function jobIndex(data) {
  const M = await data.M();
  const jobs = data.enrich().jobs;
  const apps = await data.applications();
  const appByN = new Map(apps.map((a) => [String(a.n), a]));
  const appByUrl = new Map();
  for (const a of apps) { const u = M.tracker.cellUrl(a.url); if (u) appByUrl.set(u, a); }
  const trueRank = new Map(M.home.trueRank(jobs).map((e) => [e.url, e.rank]));
  const compRank = new Map(
    Object.entries(jobs)
      .filter(([, e]) => typeof e.composite === "number" && e.groupLeader !== false)
      .sort((a, b) => b[1].composite - a[1].composite)
      .map(([url], i) => [url, i + 1]),
  );
  const rows = Object.entries(jobs).map(([url, e]) => {
    const app = appByUrl.get(url) ?? (e.report?.tracker ? appByN.get(String(e.report.tracker)) : null) ?? null;
    const status = app?.status?.trim() || (typeof e.status === "string" && e.status) || (e.source === "inbox" ? "Inbox" : e.source || "");
    return { id: jobId(url), url, e, app, status };
  });
  return { M, rows, byId: new Map(rows.map((r) => [r.id, r])), byUrl: new Map(rows.map((r) => [r.url, r])), appByN, trueRank, compRank };
}

function findJob(idx, ref) {
  const s = String(ref ?? "").trim();
  if (idx.byId.has(s)) return idx.byId.get(s);
  if (idx.byUrl.has(s)) return idx.byUrl.get(s);
  const n = parseTrackerRef(s);
  if (n && idx.appByN.has(n)) {
    const app = idx.appByN.get(n);
    const url = idx.M.tracker.cellUrl(app.url);
    return (url && idx.byUrl.get(url)) ?? idx.rows.find((r) => String(r.e.report?.tracker) === n) ?? { id: null, url, e: null, app, status: app.status.trim() };
  }
  return null;
}

function interviewDates(M, notes) {
  return M.tracker.noteParts(notes)
    .filter((p) => /^(interview|call|screen|onsite|loop)\b/i.test(p) && /(20\d\d-\d\d-\d\d|\b\d{1,2}\/\d{1,2}\b)/.test(p))
    .slice(-5);
}

function trackerOut(M, r, enrichUrlToId) {
  return compact({
    n: r.n, company: r.company, role: r.role, status: r.status,
    applied: r.applied ? `${r.applied}${r.appliedApprox ? " (approx)" : ""}` : null,
    updated: r.updated, next_step: r.next, next_date: M.home.dateInText(r.next),
    interview_dates: interviewDates(M, r.notes), pay: trackerPayLabel(r), location: clip(r.location, 60),
    notes: clip(r.notes, 400), url: r.url, job_id: enrichUrlToId(r.url),
  });
}

/** Follow-up rows from the dashboard's GET /api/profile/followups (marks already applied). */
async function followupsFromDashboard(data) {
  const body = await dashboardGetJson(data.p, "/api/profile/followups");
  if (!Array.isArray(body?.followups)) throw new ToolError(`The ${data.p.id} dashboard's /api/profile/followups returned an unexpected shape.`);
  return body.followups;
}

// ── tool definitions ─────────────────────────────────────────────────────────

const profileArg = z.string().optional().describe("Whose dashboard: a profile id from the server's config (default: the first one).");

export const TOOLS = {
  search_jobs: {
    description: "Search the job pipeline (scanned postings plus tracker jobs). Filters combine with AND; one row per dedupe group unless include_duplicates. Returns id, company, title, location, score (the one 1-5 score: the evaluation's decimal once judged, else the Haiku quick score), scored_by (sonnet | quick | none), quick_score, true_rank, composite rank, base pay, TC estimate, status, url. scored_by \"none\" = a new posting, quick-scored automatically by the daily job, not a problem. \"Inbox\" status means untracked, not \"waiting for an evaluation\": most Inbox jobs are skipped on purpose (see get_scoring_status). Use get_job(id) for detail.",
    input: {
      profile: profileArg,
      query: z.string().max(200).optional().describe("Words matched against company, title, location and the quick-score note"),
      company: z.string().max(200).optional(),
      status: z.string().max(40).optional().describe('Tracker status (e.g. Applied, Interview) or "Inbox" for untracked postings'),
      min_quick_score: z.number().min(0).max(5).optional().describe("Minimum score (the evaluation's once judged, else the quick score)"),
      judged: z.enum(["judged", "unjudged", "all"]).default("all").describe("judged = an evaluation scored it"),
      location: z.string().max(100).optional(),
      sort: z.enum(["true_rank", "composite", "quick_score", "pay", "newest"]).default("true_rank"),
      limit: z.number().int().min(1).max(50).default(15),
      include_duplicates: z.boolean().default(false),
    },
    async run(data, a) {
      const idx = await jobIndex(data);
      const words = String(a.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const has = (s, q) => String(s ?? "").toLowerCase().includes(q);
      let rows = idx.rows.filter(({ e, status }) => {
        if (!a.include_duplicates && e.groupLeader === false) return false;
        if (a.company && !has(e.company, a.company.toLowerCase())) return false;
        if (a.location && !has(e.location, a.location.toLowerCase())) return false;
        if (a.status && status.toLowerCase() !== a.status.toLowerCase()) return false;
        if (a.min_quick_score != null && !((typeof e.fit === "number" ? e.fit : e.quick_score ?? -1) >= a.min_quick_score)) return false;
        if (a.judged === "judged" && typeof e.fit !== "number") return false;
        if (a.judged === "unjudged" && typeof e.fit === "number") return false;
        if (words.length) {
          const hay = `${e.company} ${e.role} ${e.displayRole ?? ""} ${e.location} ${e.quick_why ?? ""}`.toLowerCase();
          if (!words.every((w) => hay.includes(w))) return false;
        }
        return true;
      });
      const last = (v) => (v == null ? Infinity : v);
      const sorters = {
        true_rank: (x, y) => last(idx.trueRank.get(x.url)) - last(idx.trueRank.get(y.url)) || (y.e.composite ?? -1) - (x.e.composite ?? -1),
        composite: (x, y) => (y.e.composite ?? -1) - (x.e.composite ?? -1),
        quick_score: (x, y) => (y.e.quick_score ?? -1) - (x.e.quick_score ?? -1) || (y.e.composite ?? -1) - (x.e.composite ?? -1),
        pay: (x, y) => (payNumber(y.e) ?? -1) - (payNumber(x.e) ?? -1),
        newest: (x, y) => String(y.e.first_seen_at ?? "").localeCompare(String(x.e.first_seen_at ?? "")),
      };
      rows = rows.sort(sorters[a.sort]);
      return {
        total: rows.length,
        jobs: rows.slice(0, a.limit).map(({ id, url, e, status }) => compact({
          id, company: e.company, title: e.displayRole ?? e.role, location: clip(e.location, 60),
          score: typeof e.fit === "number" ? e.fit : e.quick_score,
          scored_by: typeof e.fit === "number" ? "sonnet" : e.quick_score != null ? "quick" : "none",
          quick_score: e.quick_score, true_rank: idx.trueRank.get(url), composite_rank: idx.compRank.get(url),
          base: baseLabel(e), tc_est: tcLabel(e), status, dupes: e.groupSize > 1 ? e.groupSize - 1 : null, url,
        })),
      };
    },
  },

  get_job: {
    description: "Full detail for one job: pay band, TC estimate with its source and confidence, scores and ranks, evaluation summary, tracker entry, and the other postings in its dedupe group. id is a search_jobs id, a posting URL, or a tracker number like \"ID 12\" (\"12\" also works).",
    input: { profile: profileArg, id: z.string().min(1).max(2000) },
    async run(data, a) {
      const idx = await jobIndex(data);
      const hit = findJob(idx, a.id);
      if (!hit) throw new ToolError(`No job "${a.id}". Use search_jobs to find an id.`);
      const { e, app, url } = hit;
      const M = idx.M;
      let tracker = null;
      if (app) {
        const row = (await data.trackerRows()).find((r) => r.n === String(app.n));
        tracker = row ? trackerOut(M, row, () => null) : compact({ n: String(app.n), status: app.status.trim(), score: app.score, notes: clip(app.notes, 400) });
      }
      if (!e) return compact({ id: null, url, company: app?.company, title: app?.role, tracker, note: "No scan/enrichment data for this tracker row." });
      let payText = null;
      try { payText = M.jobPay.payLine(e)?.text ?? null; } catch { /* optional formatter */ }
      const members = e.group ? idx.rows.filter((r) => r.e.group === e.group && r.url !== url) : [];
      return compact({
        id: hit.id, url, company: e.company, title: e.displayRole ?? e.role, location: e.location, source: e.source, origin: e.origin,
        status: hit.status, first_seen: e.first_seen_at, level: e.level?.label,
        scores: compact({ quick_score: e.quick_score, quick_why: e.quick_why, fit: e.fit, relevance: e.relevance, composite: e.composite, parts: e.parts, true_rank: idx.trueRank.get(url), composite_rank: idx.compRank.get(url), h2h_rank: e.h2h_rank, h2h_why: e.h2hWhy, below_floor: e.belowFloor }),
        pay: compact({ line: typeof payText === "string" ? payText : null, base: baseLabel(e), band: e.pay ?? null, base_from: e.payFrom, tc_est: e.tc_est ?? null, tc_adj: e.tc_adj ?? null }),
        company_info: compact({ tier: e.companyTier, stage: e.companyStage, stability: e.stabilityNote, caution: e.caution }),
        benefits: e.benefits, domains: e.domains,
        evaluation: e.report ? compact({ report: e.report.n, decision: e.report.decision, why: e.report.why, strength: e.report.strength, gap: e.report.gap, next_action: e.report.nextAction, advertised_comp: e.report.advertisedComp }) : null,
        tracker,
        dedupe_group: e.group ? { key: e.group, leader: e.groupLeader !== false, members: members.slice(0, 20).map((r) => compact({ id: r.id, company: r.e.company, title: r.e.displayRole ?? r.e.role, location: clip(r.e.location, 60), status: r.status, url: r.url })) } : null,
      });
    },
  },

  list_tracker: {
    description: "Tracker entries past Evaluated (what the Tracker page shows): status, applied date, last update, next step and its date, interview dates, notes. Optional status filter.",
    input: { profile: profileArg, status: z.string().max(40).optional(), limit: z.number().int().min(1).max(200).default(100) },
    async run(data, a) {
      const M = await data.M();
      const urlToId = (u) => (u && data.enrich().jobs[u] ? jobId(u) : null);
      let rows = M.tracker.sortRows(await data.trackerRows(), "status");
      if (a.status) rows = rows.filter((r) => r.status.toLowerCase() === a.status.toLowerCase());
      return { total: rows.length, entries: rows.slice(0, a.limit).map((r) => trackerOut(M, r, urlToId)) };
    },
  },

  update_tracker: {
    description: "Update one tracker row (id = tracker number like \"ID 12\" or \"12\", or a job id that is in the tracker). status must be a dashboard status (Applied, Responded, Assessment, Interview, Offer, Rejected, Discarded, ...). next_step / next_date set the row's \"Next:\" note (replacing the old one); interview_date (YYYY-MM-DD, optional HH:MM) and append_note add timestamped notes. Never deletes or overwrites other notes.",
    input: {
      profile: profileArg,
      id: z.string().min(1).max(2000),
      status: z.string().max(40).optional(),
      next_step: z.string().min(1).max(200).optional(),
      next_date: z.string().max(10).optional().describe("YYYY-MM-DD"),
      interview_date: z.string().max(20).optional().describe("YYYY-MM-DD or YYYY-MM-DD HH:MM"),
      append_note: z.string().min(1).max(250).optional(),
    },
    async run(data, a) {
      const idx = await jobIndex(data);
      const M = idx.M;
      const hit = findJob(idx, a.id);
      const app = hit?.app;
      if (!app) throw new ToolError(`"${a.id}" is not a tracker row. Use list_tracker or get_job to find its tracker number.`);
      const n = String(app.n);
      let status = null;
      if (a.status != null) {
        const states = await data.states();
        status = M.trackerUtils.resolveCanonicalState(a.status, states);
        if (!status) throw new ToolError(`"${a.status}" is not a dashboard status. Allowed: ${states.map((s) => s.label).join(", ")}.`);
      }
      const clean = (s) => String(s).replace(/\s+/g, " ").trim();
      const notes = []; // [{note, replaceNote?}] in write order
      if (a.next_step != null || a.next_date != null) {
        if (a.next_date != null && !validDay(a.next_date)) throw new ToolError("next_date must be a real date as YYYY-MM-DD.");
        const cur = M.tracker.nextStep(app.notes);
        let text = clean(a.next_step ?? cur.text);
        if (a.next_date != null) text = text.replace(/\b20\d\d-\d\d-\d\d\b/g, "").replace(/\s{2,}/g, " ").trim();
        const note = `Next: ${[text, a.next_date].filter(Boolean).join(" ")}`;
        notes.push(cur.raw ? { note, replaceNote: cur.raw } : { note });
      }
      if (a.interview_date != null) {
        const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}(?:\s?[AP]M)?))?$/i.exec(a.interview_date.trim());
        const d = m && validDay(m[1]);
        if (!d) throw new ToolError("interview_date must be YYYY-MM-DD, optionally followed by HH:MM.");
        notes.push({ note: `Interview: ${WEEKDAYS[d.getUTCDay()]} ${m[1]}${m[2] ? ` ${m[2].toUpperCase()}` : ""}` });
      }
      if (a.append_note != null) notes.push({ note: `${M.home.localDay()}: ${clean(a.append_note)}` });
      for (const x of notes) {
        if (/[|\r\n]/.test(x.note) || x.note.length > 300) throw new ToolError("Notes can't contain | and must stay under 300 characters.");
      }
      if (!status && notes.length === 0) throw new ToolError("Nothing to update: pass status, next_step, next_date, interview_date or append_note.");
      const finalStatus = status ?? app.status.trim();
      const calls = notes.length ? notes.map((x) => ({ n, status: finalStatus, note: x.note, ...(x.replaceNote ? { replaceNote: x.replaceNote } : {}) })) : [{ n, status: finalStatus }];
      const done = [];
      for (const body of calls) {
        const res = await dashboardPost(data.p, "/api/status", body);
        if (!res.ok || res.json?.ok !== true) {
          const msg = res.json?.error ?? `HTTP ${res.status}`;
          const hint = res.status === 503 ? " (the tracker is busy; retry in a few seconds)" : res.status === 504 ? " (it may or may not have been applied; check list_tracker)" : "";
          throw new ToolError(`Dashboard refused the update: ${msg}${hint}.${done.length ? ` Already applied: ${done.join("; ")}.` : ""}`);
        }
        done.push(body.note ? `note "${body.note}"` : `status ${body.status}`);
      }
      const fresh = new ProfileData(data.p);
      const row = (await fresh.trackerRows()).find((r) => r.n === n);
      return { ok: true, applied: [...(status ? [`status ${status}`] : []), ...notes.map((x) => `note "${x.note}"`)], entry: row ? trackerOut(M, row, () => null) : { n, status: finalStatus } };
    },
  },

  list_followups: {
    description: "Follow-ups needing action, one row per opportunity (what the Follow-ups page shows at the top): who you're waiting on or owe, when, latest message snippet, tracker rows. include_done adds rows marked Done/Won't respond and non-job threads.",
    input: { profile: profileArg, include_done: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(40) },
    async run(data, a) {
      const opps = await followupsFromDashboard(data);
      const shown = opps.filter((o) => a.include_done || (!o.mark && !o.other));
      return {
        needing_action: opps.filter((o) => !o.mark && !o.other).length,
        followups: shown.slice(0, a.limit).map((o) => {
          const t = o.threads[0];
          return compact({
            id: o.key, title: o.title, company: o.company, detail: o.line2, when: o.whenLabel || o.when, state: o.state,
            other: o.other || null, mark: o.mark ? (o.mark.mark === "wont" ? "ignored" : o.mark.mark) : null,
            people: o.people.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)),
            latest: t ? compact({ from: t.name, date: localWhen(t.date), snippet: clip(t.snippet, 160), waiting_on: t.lastFromMe ? "them" : "you" }) : null,
            tracker: o.rows.map((r) => `${trackerLabel(r.n)} ${r.status}`),
          });
        }),
      };
    },
  },

  mark_followup: {
    description: "Mark a follow-up (id from list_followups) as done, ignored (Won't respond), or clear the mark. Only hides/shows the row in the dashboard; sends nothing. A Done row comes back if they write again.",
    input: { profile: profileArg, id: z.string().min(1).max(300), mark: z.enum(["done", "ignored", "clear"]) },
    async run(data, a) {
      const key = a.id.replace(/^opp:/, "");
      const all = await followupsFromDashboard(data);
      const opp = all.find((o) => o.key === key);
      if (!opp && a.mark !== "clear") throw new ToolError(`No follow-up "${a.id}". Use list_followups for ids.`);
      const mark = a.mark === "done" ? "done" : a.mark === "ignored" ? "wont" : null;
      const res = await dashboardPost(data.p, "/api/profile/marks", { op: "mark", id: `opp:${key}`, mark, lastDate: opp?.threads[0]?.date ?? "" });
      if (!res.ok) throw new ToolError(`Dashboard refused the mark: ${res.json?.error ?? `HTTP ${res.status}`}.`);
      return { ok: true, id: key, mark: a.mark, title: opp?.title ?? null };
    },
  },

  get_study_today: {
    description: "Today's study day from the study plan (the first unfinished day): its tasks with ids and done state, plus overall progress.",
    input: { profile: profileArg },
    async run(data) {
      const s = await data.study();
      return studyOut(s);
    },
  },

  complete_study_task: {
    description: "Tick (done=true) or untick (done=false) a study task by its id from get_study_today. Returns the updated day.",
    input: { profile: profileArg, id: z.string().regex(/^[a-z0-9]{2,40}$/), done: z.boolean().default(true) },
    async run(data, a) {
      const s = await data.study();
      const item = s.days.flatMap((d) => d.items.map((i) => ({ ...i, day: d.n }))).find((i) => i.id === a.id);
      if (!item) throw new ToolError(`No study task "${a.id}". Use get_study_today for ids.`);
      const res = await dashboardPost(data.p, "/api/profile/study", { op: "tick", id: a.id, value: a.done });
      if (!res.ok) throw new ToolError(`Dashboard refused the change: ${res.json?.error ?? `HTTP ${res.status}`}.`);
      return { ok: true, task: clip(item.text, 120), done: a.done, today: studyOut(await new ProfileData(data.p).study()) };
    },
  },

  add_job_by_url: {
    description: "Add a job posting by URL through the dashboard's Add-a-job flow (dedupes against the tracker, inbox and scan history; fetches the JD; scores it). Returns result new | matched (with the existing job) | need_details (pass company and title, optionally description) | filtered. Can take up to two minutes.",
    input: {
      profile: profileArg,
      url: z.string().url().max(2000),
      company: z.string().max(200).optional(),
      title: z.string().max(300).optional(),
      location: z.string().max(200).optional(),
      description: z.string().max(60000).optional().describe("Pasted job description, when the page can't be read"),
      force: z.boolean().default(false).describe("Add even if it looks like a similar (not identical) posting"),
    },
    async run(data, a) {
      if (!/^https?:\/\//i.test(a.url)) throw new ToolError("url must start with http:// or https://");
      const res = await dashboardPost(data.p, "/api/profile/add-job", compact({ url: a.url, company: a.company, title: a.title, location: a.location, jd: a.description, force: a.force || undefined }), { timeoutMs: 130_000 });
      const j = res.json ?? {};
      switch (j.status) {
        case "added": return compact({ result: "new", id: jobId(j.job?.url ?? a.url), job: j.job, note: j.note });
        case "duplicate": return compact({ result: "matched", reason: j.reason, similar: j.similar || null, existing: j.match ? compact({ ...j.match, id: j.match.url && data.enrich().jobs[j.match.url] ? jobId(j.match.url) : null }) : null });
        case "need-details": return { result: "need_details", message: j.message };
        case "filtered": return { result: "filtered", reason: j.reason };
        default: throw new ToolError(`Add-a-job failed: ${j.message ?? `HTTP ${res.status}`}`);
      }
    },
  },

  get_summary: {
    description: "What the dashboard Home page shows, in a few lines: Needs you, In flight, Today's study, New since the last Home visit, last scan time. Read-only (does not count as a Home visit).",
    input: { profile: profileArg },
    text: true,
    async run(data) {
      // Needs you / In flight / New since last look come from the dashboard's own Home loader.
      // If that route fails, the tool fails; there is no local fallback.
      const home = await dashboardGetJson(data.p, "/api/profile/home");
      if (![home.needs, home.inFlight, home.opportunities].every(Array.isArray)) {
        throw new ToolError(`The ${data.p.id} dashboard's /api/profile/home returned an unexpected shape.`);
      }
      const { needs, inFlight: flying, opportunities: fresh } = home;
      const s = await data.study();
      const lines = [];
      lines.push(`Needs you (${needs.length})${needs.length ? ":" : ": nothing right now"}`);
      for (const x of needs.slice(0, 12)) lines.push(`- ${clip(x.label, 80)} — ${clip(x.detail, 100)}`);
      if (needs.length > 12) lines.push(`- …and ${needs.length - 12} more`);
      const counts = {};
      for (const r of flying) counts[r.status] = (counts[r.status] ?? 0) + 1;
      lines.push(`In flight (${flying.length})${flying.length ? `: ${Object.entries(counts).map(([st, c]) => `${st} ${c}`).join(", ")}` : ""}`);
      for (const r of flying.slice(0, 6)) lines.push(`- ${trackerLabel(r.n)} ${clip(`${r.company} · ${r.role}`, 80)} (${r.status}${r.next ? `; next: ${clip(r.next, 70)}` : ""})`);
      if (s.today) {
        const done = s.today.items.filter((i) => s.state.ticks[i.id]).length;
        const next = s.today.items.find((i) => !s.state.ticks[i.id]);
        lines.push(`Today's study: ${s.today.title} — ${done}/${s.today.items.length} done${next ? `; next: ${clip(next.text, 70)}` : ""} (day ${s.progress.done + 1} of ${s.progress.total})`);
      } else lines.push(s.days.length ? "Today's study: plan complete" : "Today's study: no plan yet");
      lines.push(`New since last look (${fresh.length})${fresh.length ? ":" : ""}`);
      for (const e of fresh.slice(0, 5)) lines.push(`- rank ${e.rank} ${clip(`${e.company} · ${e.role}`, 80)} [${jobId(e.url)}]`);
      try {
        const b = await runHook(data.p, ["backlog"]);
        const skipped = Object.values(b.skipped_on_purpose ?? {}).reduce((n, x) => n + x.count, 0);
        lines.push(`Scoring: ${b.judged} judged · ${b.sonnet_eligible.count} worth an evaluation run (~$${b.sonnet_eligible.estimate_usd}, needs the user's OK) · ${b.no_quick_score_yet?.count ?? 0} new with no quick score yet (the daily quick-score job handles them; normal, not a problem) · ${skipped} skipped on purpose · ${b.hidden_by_rules?.count ?? 0} hidden by the full-time / base-floor rules. Details: get_scoring_status.`);
      } catch { /* optional here; get_scoring_status reports the hook's own error */ }
      const scan = await data.lastScanAt();
      const inbox = await data.pendingInboxCount();
      const cost = await data.weekCost();
      lines.push(`Last scan ${scan ? localWhen(scan) : "never"} · ${inbox.toLocaleString("en-US")} scanned postings not in the tracker (a pile, not a to-do list) · $${cost.toFixed(2)} AI usage, last 7 days`);
      return lines.join("\n");
    },
  },
};

function studyOut(s) {
  if (!s.days.length) return { plan: false, message: "No study plan yet." };
  if (!s.today) return { plan: true, complete: true, progress: s.progress };
  return {
    day: compact({ n: s.today.n, title: s.today.title, theme: s.today.theme, section: s.today.section, fast_track: s.today.fast || null }),
    progress: `${s.progress.done} of ${s.progress.total} days done`,
    tasks: s.today.items.map((i) => compact({ id: i.id, type: i.type, text: i.text, done: !!s.state.ticks[i.id], star: i.star || null })),
  };
}

/**
 * Register every tool on an McpServer. onCall({tool, profile, ok, ms, error}) is told about each call
 * (no arguments, so nothing personal reaches the log).
 */
// Evaluation runs (the only tools that spend): src/eval-tools.mjs.
Object.assign(TOOLS, evalTools({ profileArg, jobIndex }));
// Study plan editing (writes through the dashboard): src/study-tools.mjs.
Object.assign(TOOLS, studyTools({ profileArg }));

export function registerTools(server, { config, onCall = () => {} }) {
  for (const [name, t] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: t.description, inputSchema: t.input }, async (args) => {
      const started = Date.now();
      let profileId = args?.profile || config.defaultProfile;
      try {
        const profile = resolveProfile(config, args?.profile);
        profileId = profile.id;
        const out = await t.run(new ProfileData(profile), args ?? {});
        onCall({ tool: name, profile: profileId, ok: true, ms: Date.now() - started });
        return { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] };
      } catch (err) {
        const expected = err instanceof ToolError;
        onCall({ tool: name, profile: String(profileId).slice(0, 40), ok: false, ms: Date.now() - started, error: expected ? "tool" : "internal" });
        if (!expected) console.error(`[${name}]`, err);
        return { isError: true, content: [{ type: "text", text: expected ? err.message : "Internal error in the career-ops MCP server (see its log)." }] };
      }
    });
  }
}
