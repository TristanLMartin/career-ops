// Evaluation runs: start one, watch it, list them. These are the only tools that spend model
// usage. They call career-ops' own eval hook (scripts/hunt-eval-run.mjs), which records the
// run under the profile's data/eval-runs/, runs career-ops' normal evaluation flow with a hard
// dollar cap, and logs spend to data/hunt-usage.tsv (so get_summary's AI usage includes it).
// This server never writes the files itself.
import path from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import { ToolError } from "./config.mjs";

/** Above this, evaluate_jobs needs confirm: true (only spend the user approved). */
export const CONFIRM_ABOVE_USD = 10;
const RUN_ID = /^ev-\d{12}-[0-9a-f]{4}$/;
const MODEL = z.enum(["sonnet-lite", "opus-full"]);

function hookEnv(p) {
  const env = { ...process.env };
  // A profile whose data dir is the checkout itself needs no override; any other is selected the way cron does.
  if (path.resolve(p.dataDir) !== path.resolve(p.codeRoot)) env.CAREER_OPS_PROFILE_DIR = p.dataDir;
  return env;
}

/** Runs the hook and parses its JSON; a hook error becomes a ToolError with its own message. */
export function runHook(p, args, { input = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(p.codeRoot, "scripts", "hunt-eval-run.mjs"), ...args], { cwd: p.codeRoot, env: hookEnv(p), timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const msg = String(stderr ?? "").split("\n").find((l) => l.startsWith("hunt-eval-run: "));
      if (err) return reject(msg ? new ToolError(msg.replace("hunt-eval-run: ", "")) : err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
    if (input != null) child.stdin.end(input);
  });
}

const money = (n) => `$${Number(n).toFixed(2)}`;

export function evalTools({ profileArg, jobIndex }) {
  return {
    evaluate_jobs: {
      description: `Start a recorded career-ops evaluation run on the career-ops machine (this spends model usage). Pick jobs by job_ids (from search_jobs) or by filter; with neither, the default filter: untracked Inbox jobs not yet evaluated that pass the profile's target filters (config/ranking.yml target: levels, location tiers, relocate pay bars, base floor), highest quick score first. model: sonnet-lite (~$0.13/job) or opus-full (~$1.85/job). two_pass re-runs pass-1 scores at or above its threshold on its model, best first, with what is left of max_spend_usd. Never spends more than max_spend_usd. Refuses when the estimate or max_spend_usd is over $${CONFIRM_ABOVE_USD} unless confirm is true. One run at a time. Only call this for spend the user approved. Returns run_id; watch it with get_eval_run.`,
      input: {
        profile: profileArg,
        job_ids: z.array(z.string().min(1).max(40)).max(500).optional().describe("search_jobs ids (j...)."),
        filter: z.object({
          limit: z.number().int().min(1).max(500).default(50),
          company: z.string().max(80).optional(),
          max_rank: z.number().int().min(1).optional().describe("Only jobs at or above this true rank."),
        }).optional(),
        model: MODEL,
        max_spend_usd: z.number().positive().max(200),
        two_pass: z.object({ threshold: z.number().min(1).max(5), model: MODEL }).optional(),
        confirm: z.boolean().default(false),
      },
      async run(data, a) {
        if (a.job_ids?.length && a.filter) throw new ToolError("Pass job_ids or filter, not both.");
        const args = ["--model", a.model, "--max-spend", String(a.max_spend_usd)];
        if (a.two_pass) args.push("--two-pass-threshold", String(a.two_pass.threshold), "--two-pass-model", a.two_pass.model);
        let input = null;
        if (a.job_ids?.length) {
          const idx = await jobIndex(data);
          const missing = a.job_ids.filter((id) => !idx.byId.has(id));
          if (missing.length) throw new ToolError(`Unknown job ids: ${missing.slice(0, 10).join(", ")}. Use search_jobs for ids.`);
          input = a.job_ids.map((id) => idx.byId.get(id).url).join("\n");
          args.push("--urls-file", "-");
        } else {
          const f = a.filter ?? { limit: 50 };
          args.push("--limit", String(f.limit ?? 50));
          if (f.company) args.push("--company", f.company);
          if (f.max_rank) args.push("--max-rank", String(f.max_rank));
        }
        const plan = await runHook(data.p, ["plan", ...args], { input });
        if (!plan.jobs) throw new ToolError("No jobs match; nothing started.");
        const est = plan.estimate;
        if (est.pass1 > a.max_spend_usd) throw new ToolError(`Not started: pass 1 alone is estimated at ${money(est.pass1)} for ${plan.jobs} jobs, over max_spend_usd ${money(a.max_spend_usd)}. Lower the job count or raise the cap (with the user's OK).`);
        if ((est.total > CONFIRM_ABOVE_USD || a.max_spend_usd > CONFIRM_ABOVE_USD) && !a.confirm) {
          throw new ToolError(`Not started: ${plan.jobs} jobs, estimated ${money(est.total)}${a.two_pass ? ` (pass 1 ${money(est.pass1)}, pass 2 up to ${money(est.pass2)})` : ""}, cap ${money(a.max_spend_usd)}. Over $${CONFIRM_ABOVE_USD}: call again with confirm: true only if the user approved this spend.`);
        }
        const started = await runHook(data.p, ["start", ...args, "--yes", "--profile-name", data.p.id], { input });
        return {
          run_id: started.run_id, jobs: started.jobs, estimate_usd: est.total, estimate: est, cap_usd: a.max_spend_usd,
          note: `Spends at most ${money(a.max_spend_usd)}${a.two_pass && est.total > a.max_spend_usd ? "; pass 2 stops at the cap, best pass-1 scores first" : ""}. Watch it with get_eval_run.`,
        };
      },
    },

    get_eval_run: {
      description: "Progress of one evaluation run: state, jobs done/total per pass, spend so far vs its cap, and results so far (job id, company, title, score), 4.0+ first.",
      input: { profile: profileArg, run_id: z.string().regex(RUN_ID, "run ids look like ev-202611222100-a1f0"), results_limit: z.number().int().min(0).max(500).default(40) },
      async run(data, a) {
        const s = await runHook(data.p, ["status", a.run_id]);
        const results = s.results ?? [];
        return { ...s, results: results.slice(0, a.results_limit), results_shown: Math.min(results.length, a.results_limit), results_total: results.length };
      },
    },

    list_eval_runs: {
      description: "Recent evaluation runs, newest first: state, jobs, spend vs cap, and each run's top 5 results.",
      input: { profile: profileArg, limit: z.number().int().min(1).max(50).default(10) },
      async run(data, a) {
        return { runs: await runHook(data.p, ["list", "--limit", String(a.limit)]) };
      },
    },
  };
}
