# career-ops MCP server

Lets Claude (claude.ai, the Claude apps, Claude Code) read and update your career-ops job
dashboard: search jobs, read a job's detail, see and update the tracker, list and mark
follow-ups, tick study tasks, add a job by URL, and get a Home summary.

- Streamable HTTP, stateless, listens on **127.0.0.1** by default (`CAREER_OPS_MCP_HOST`,
  `CAREER_OPS_MCP_PORT`, default 8765).
- **Reads** parse the profile's files with the dashboard's own helpers (imported read-only from
  `../web/src/lib/*.mjs`), so numbers match the web UI. Home and Follow-ups come straight from the
  dashboard's read-only routes (`GET /api/profile/home`, `GET /api/profile/followups`).
- **Writes** go only through the running dashboard's HTTP endpoints, so its locks, validation
  and atomic writes apply. The server never writes data files itself.
- No delete tools. Nothing sends email or messages.
- **Spending:** only `evaluate_jobs` spends model usage. It runs career-ops' own eval hook
  (`scripts/hunt-eval-run.mjs`), which records the run, enforces the dollar cap and logs spend to
  `data/hunt-usage.tsv`. Over $10 it needs `confirm: true`; call it only for spend the user
  approved. One run at a time. A profile with `evals_paused: true` in `config/ranking.yml` is refused.

## Set up

Needs Node 22 and a running dashboard (`npm run ui` / `cd web && npm start`, see `../docs/SETUP.md`).

```sh
cd mcp
npm ci
npm run setup            # creates .env with a random token (chmod 600)
$EDITOR .env             # CAREER_OPS_MCP_PROFILES: which profiles and dashboard URLs
npm start                # or install the systemd user unit, below
```

Profiles are a comma list of `id=profileDir@dashboardUrl` in `.env`:

```sh
CAREER_OPS_MCP_PROFILES=me=.@http://127.0.0.1:3000
# two people on one machine, each with their own dashboard instance:
CAREER_OPS_MCP_PROFILES=me=.@http://127.0.0.1:3000,partner=profiles/partner@http://127.0.0.1:3001
```

`profileDir` is relative to the career-ops checkout (`.` is the default profile). Instead of the
env var you can copy `config/profiles.example.json` to `config/profiles.json` (gitignored).

### Run it as a service (Linux, systemd user unit)

```sh
npm run setup -- --systemd
systemctl --user daemon-reload
systemctl --user enable --now career-ops-mcp
loginctl enable-linger "$USER"     # optional: keep it running while you are logged out
journalctl --user -u career-ops-mcp -f
```

The template is `deploy/career-ops-mcp.service.template`. On macOS, run `npm start` under
launchd or in a terminal multiplexer instead.

## Connect it to claude.ai (custom connector)

claude.ai needs a public HTTPS URL. The simplest is **Tailscale Funnel** (free; the machine must
be on your tailnet, with HTTPS certificates and Funnel enabled in the Tailscale admin console):

```sh
tailscale funnel --bg 8765          # the MCP port from .env
tailscale funnel status             # shows https://<your-node>.<your-tailnet>.ts.net
```

Then in claude.ai: **Settings → Connectors → Add custom connector**, URL:

```
https://<your-node>.<your-tailnet>.ts.net/mcp/<token>
```

`npm run setup -- --show-url` prints the local form with your token. Turn it off again with
`tailscale funnel --bg 8765 off`. Cloudflare Tunnel or any HTTPS reverse proxy works the same way
(point it at `http://127.0.0.1:8765`).

> **The token in that URL is a secret.** Anyone who has the URL can read your job search and
> change your tracker. Don't paste it in chats, screenshots, issues or commits. If it leaks:
> `npm run setup -- --rotate`, restart the server, and update the connector URL.

Claude Code can use the same server with a header instead of the path token:

```sh
claude mcp add --transport http career-ops http://127.0.0.1:8765/mcp --header "Authorization: Bearer <token>"
```

## Tools

Tool text shows tracker rows as "ID N" and times in `CAREER_OPS_TZ` (an IANA zone such as `America/Chicago`; default the system zone).

Every tool takes an optional `profile` (a profile id from your config; default: the first).

| Tool | What it does | Write path |
|---|---|---|
| `search_jobs(query?, company?, status?, min_quick_score?, location?, sort, limit≤50, include_duplicates?)` | Pipeline search; one row per dedupe group. Sort: `true_rank`, `composite`, `quick_score`, `pay`, `newest` | read |
| `get_job(id)` | Full detail: pay band, TC estimate, scores/ranks, evaluation summary, tracker entry, dedupe group. `id` = search id (`j…`), URL, or tracker number (`ID 12` or `12`) | read |
| `list_tracker(status?)` | Tracker rows past Evaluated: status, applied, updated, next step + date, interview dates, notes | read |
| `update_tracker(id, status?, next_step?, next_date?, interview_date?, append_note?)` | Status validated against `templates/states.yml`; next step replaces the row's `Next: …` note; interview date and notes are appended, dated | `POST /api/status` |
| `list_followups(include_done?)` | Follow-ups needing action (one per opportunity) | `GET /api/profile/followups` |
| `mark_followup(id, mark: done\|ignored\|clear)` | Done / Won't respond / clear | `POST /api/profile/marks` |
| `get_study_today()` | Today's study day: tasks with ids and done state | read |
| `complete_study_task(id, done=true)` | Tick / untick a study task | `POST /api/profile/study` |
| `add_job_by_url(url, company?, title?, location?, description?, force?)` | The dashboard's Add-a-job flow incl. dedupe | `POST /api/profile/add-job` |
| `get_summary()` | Home in a few lines (Needs you, In flight, Today's study, New since last look) | `GET /api/profile/home` |
| `evaluate_jobs(job_ids? \| filter?, model: sonnet-lite\|opus-full, max_spend_usd, two_pass?: {threshold, model}, confirm?)` | Starts a recorded, capped evaluation run (default filter = the profile's target filters, highest quick score first); returns `run_id`, job count, estimate. Over $10 needs `confirm` | `scripts/hunt-eval-run.mjs start` (spends) |
| `get_eval_run(run_id, results_limit?)` | State, jobs done/total per pass, spend vs cap, results so far (4.0+ first) | read (`… status`) |
| `list_eval_runs(limit?)` | Recent runs, newest first, with each run's top 5 | read (`… list`) |

## Auth and logs

- `Authorization: Bearer <token>` on `POST /mcp`, or the token in the path: `POST /mcp/<token>`
  (claude.ai custom connectors can't send headers). Any other path, or a missing / wrong token:
  empty `404`. Constant-time compare. The server refuses to start without a 24+ character token.
- Per-IP rate limit 120 requests/minute (`429`). Behind a loopback proxy (Tailscale serve /
  funnel) the client IP comes from `X-Forwarded-For`.
- `logs/requests.log` (JSONL: time, IP, tool, profile, ok/error, ms; never arguments or the
  token; rotates at 5 MB). `logs/` is gitignored.

## Tests

```sh
npm test
```

node:test: auth (header, path, wrong token, rate limit, log hygiene), profile config (file and
env), setup token handling, every tool against `tests/fixture/root` (fake data), update_tracker
through the real `../set-status.mjs` on a temp copy, and an end-to-end run through the MCP SDK
client. Writes go to a stand-in dashboard (`tests/helpers.mjs`).

## Coupling to the dashboard

`src/dashboard-modules.mjs` lists the dashboard modules imported from `../web/src/lib`. If one is
renamed, tools fail with a clear "could not load dashboard module" error and the tests catch it.
