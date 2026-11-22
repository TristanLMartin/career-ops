# Setup (shareable edition)

Everything runs on your own computer (or a small always-on box). Your resume, tracker and mail
never leave it except as prompts to the model you choose for scoring.

## 1. Prerequisites

| Need | Why | Check |
|---|---|---|
| **Node.js 22+** | scripts and the dashboard | `node -v` |
| **git** | updates, the pre-push secret scan | `git --version` |
| **Claude Code CLI** (`claude`) | LLM scoring: quick scores, head-to-head, evaluation reports, message triage | `claude --version` |
| **pdftotext** (Poppler), optional | read a PDF resume during onboarding | `pdftotext -v` (`apt install poppler-utils` / `brew install poppler`) |
| **pandoc** or **unzip**, optional | read a DOCX resume | `pandoc -v` |

The Claude CLI either uses your Claude subscription (`claude` once, then log in) or an Anthropic
API key (`export ANTHROPIC_API_KEY=...` in the shell that runs the jobs). Any of upstream's other
CLIs work for the `/career-ops` modes (see `docs/SUPPORTED_CLIS.md`), but the ranking scripts in
`scripts/hunt-*.mjs` call `claude -p` directly.

Ranking, scanning and the dashboard are free (no LLM). Only these call a model, and each refuses
to run without `--yes` (or `CAREER_OPS_ALLOW_SPEND=1`):

| Script | Model | Typical cost |
|---|---|---|
| `scripts/hunt-quickscore.mjs` | Haiku, 20 postings per call | well under a cent per posting (`--estimate` first) |
| `scripts/hunt-autoscore.mjs` | full career-ops evaluation via the dashboard | `auto_score_per_day` roles a day (0 = off) |
| `scripts/hunt-h2h.mjs` / `hunt-h2h-insert.mjs` | Sonnet, weekly head-to-head of your top roles | `--dry-run` shows the plan |
| `scripts/hunt-message-kinds.mjs` | Haiku, only for threads the rules can't place | cached per thread |
| `scripts/hunt-discovery-boards.mjs` | Haiku + the Dice / Indeed claude.ai connectors | one call a day |

## 2. Install

```sh
git clone <this repo> career-ops && cd career-ops
npm install
cd web && npm install && npm run build && cd ..
npm run hooks           # pre-push secret scan (recommended)
```

## 3. Your profile

```sh
npm run onboard
```

It asks for your name, a resume file (`.pdf`, `.docx`, `.md`, `.txt`), a preset or a free-text
description of the roles you want, your home metro (and the suburb / state words job postings
use for it), whether remote is OK, other cities, and a pay floor. It writes, without
overwriting anything that exists (`--force` to redo):

| File | What to tune there |
|---|---|
| `cv.md` | Your resume as Markdown. Check it: PDF extraction is plain text. `--tidy` asks the Claude CLI to clean it up (sends the resume text to the model). |
| `config/person.yml` | Name, field, target roles, level target, pay floor and currency, a 3-6 line `summary` for the quick scorer, `quick_rubric` (the scorer's 1-5 rubric), `h2h_preferences` (how to weigh one job against another). |
| `config/ranking.yml` | Weights, `pay_band`, `base_floor`, `location_scores` / `location_labels`, `target` (which levels / places count), the level ladder (`profile_rules.level`), home / secondary metro words, relevance words. |
| `portals.yml` | Company boards to scan and the title / location filters. Full reference: `templates/portals.example.yml`. |
| `config/discovery-wide.yml` | Extra sources: VC boards, Built In, YC, funding news, your own target companies. |
| `config/profile.yml` | career-ops' own profile (used by evaluation reports and CV tailoring). |
| `skills-profile.md` | Strengths and things to avoid (read by the head-to-head). |

Presets live in `presets/<name>/`. `swe` targets a Senior IC software ladder; `recruiting` targets
technical recruiter / sourcer / TA partner roles and weights pay, company quality, remote and req
load; `generic` is fill-in-the-blanks. `node scripts/onboard.mjs --list-presets` lists them, and
`--answers answers.json` runs it without questions (see the header of `scripts/onboard.mjs`).

Then personalize career-ops' evaluation targeting: open your AI CLI in the repo and say
"set up my profile from cv.md" (it fills `modes/_profile.md`; see `AGENTS.md`), and run
`node doctor.mjs` to check the setup.

### Several people on one machine

```sh
npm run onboard -- --profile sam            # writes profiles/sam/ (gitignored)
CAREER_OPS_ROOT=profiles/sam node scan.mjs  # any script, for that profile
```

Run one dashboard per person (`CAREER_OPS_ROOT=profiles/sam npm start -- -p 3001` in `web/`) and
list them in `config/profile-instances.yml` (copy the `.example`) to get a switcher in the header.
`CAREER_OPS_PROFILE_DIR` is an older alias for `CAREER_OPS_ROOT` and still works.

To give another profile the same company boards as the default profile (with its own title
filters and search terms), add `profiles/<id>/config/shared-boards.yml` (`queries`, `builtin`,
`exclude`, `extra_companies`; all optional, queries default to that profile's target roles) and
run `CAREER_OPS_ROOT=profiles/<id> node scripts/hunt-profile-boards.mjs`. The cron `scan` job
refreshes it. Non-software profiles (`is_tech: false`) rank pay on posted ranges only.

## 4. First run

```sh
node scan.mjs                        # company boards from portals.yml -> data/pipeline.md
node scripts/hunt-enrich.mjs         # rank everything (free)
cd web && npm start                  # http://localhost:3000
```

Optional, costs a little: `node scripts/hunt-quickscore.mjs --estimate`, then `--yes`.

## 5. Schedule it

`scripts/hunt-cron.sh <job>` runs one job with a lock and a log (`data/hunt-cron.log`). Put machine
settings in `config/cron.env` (copy the `.example`): `CAREER_OPS_WEB_PORT`, and
`CAREER_OPS_WEB_ALLOWED_HOSTS` if other devices on your network should reach the dashboard.
Example crontab (`crontab -e`; times are local):

```cron
CAREER_OPS=/home/you/career-ops
0 */4 * * *  $CAREER_OPS/scripts/hunt-cron.sh scan
15 * * * *   $CAREER_OPS/scripts/hunt-cron.sh messages
30 6 * * *   $CAREER_OPS/scripts/hunt-cron.sh discover
45 6 * * *   $CAREER_OPS/scripts/hunt-cron.sh wide-vc
0 7 * * *    $CAREER_OPS/scripts/hunt-cron.sh autoscore     # LLM: quick scores + auto_score_per_day evaluations
0 8 * * 0    $CAREER_OPS/scripts/hunt-cron.sh h2h           # LLM: weekly head-to-head
*/10 * * * * $CAREER_OPS/scripts/hunt-cron.sh ui            # keep the dashboard up
```

Scheduling an LLM job is your consent to its cost (the runner passes `--yes`). For a second
person, prefix the line with `CAREER_OPS_ROOT=profiles/sam`; their jobs only run once their
`config/person.yml` says `active: true`. `scripts/hunt-cron.sh --help` lists every job.
macOS: use launchd (see `docs/AUTOMATION.md`).

## 6. Optional: recruiter mail (Gmail)

A small read-only Google Apps Script in your own account serves your job mail as JSON behind a
long random key; `scripts/hunt-messages-sync.mjs` pulls it hourly into the Messages and
Follow-ups pages. Setup: `apps-script/SETUP.md`. Then add to `.env` (gitignored):

```sh
JOBHUNT_FEED_URL=https://script.google.com/macros/s/.../exec
JOBHUNT_FEED_KEY=<the FEED_KEY value>
```

## 7. Optional: Claude on your phone (MCP server)

`mcp/` is an MCP server for the dashboard: search jobs, update the tracker, mark follow-ups and
tick study tasks from claude.ai or the Claude app. Setup, a systemd unit and how to expose it to
claude.ai through Tailscale Funnel: **[mcp/README.md](../mcp/README.md)**. The connector URL
contains a secret token; treat it like a password.

## 8. Keeping secrets out of git

Personal files are gitignored (`cv.md`, `config/person.yml`, `config/ranking.yml`,
`config/profile.yml`, `portals.yml`, `skills-profile.md`, `data/`, `reports/`, `output/`,
`profiles/*`, `.env`, `mcp/.env`). `npm run hooks` installs a pre-push hook that runs
`scripts/secret-scan.sh` (gitleaks when installed, plus a pattern scan of what you are about to
push). Run `npm run secret-scan` any time.

## Updating from an older checkout

If your files carry an old personal prefix (`config/<name>-ranking.yml`, `data/<name>-enrich.json`), set
`CAREER_OPS_LEGACY_PREFIX=<name>-` and they are still read; `npm run migrate:legacy-names -- --prefix <name>-`
shows the renames for a profile (add `--apply` to do them, never overwriting). Copy `profile_rules` from
`presets/swe/config/ranking.yml` into your `config/ranking.yml` if you relied on the old built-in
software / Seattle rules: the library no longer assumes any field or city.

---

The rest of this page is the upstream career-ops setup guide (CLI modes, plugin installs, Docker, the Go dashboard). It applies here too.

# Setup Guide

## Prerequisites

- An AI coding CLI — [Claude Code](https://claude.ai/code), Codex, Qwen Code, OpenCode, Pi, Oh My Pi, GitHub Copilot CLI, Antigravity CLI, Grok Build CLI, or Hermes Agent (see [Supported CLIs](SUPPORTED_CLIS.md))
- [Node.js](https://nodejs.org) 22.13+ and `git` (`npx` ships with Node — the installer refuses to run without them). 22.13 is the first release where `node:sqlite`, used by the tracker index (see [tracker](SCRIPTS.md#tracker)), needs no flag
- (Optional) Go 1.26+ (for the dashboard TUI)

## Quick Start

### Browser-only — Claude Code on the web

[Claude Code on the web](https://code.claude.com/docs/en/web-quickstart) can run
career-ops without a local checkout. It is currently a research preview for
eligible Claude plans. A web session clones a GitHub repository into an
isolated cloud VM; it does not have your machine's files or local configuration.

1. Put career-ops in a **private GitHub repository** that your account can
   access. You can use [GitHub Importer](https://docs.github.com/en/migrations/importing-source-code/using-github-importer/importing-a-repository-with-github-importer)
   with `https://github.com/career-ops-hq/career-ops.git` as the source. A normal
   fork of this public repository is public, so do not use one for personal
   career data.
2. Open [claude.ai/code](https://claude.ai/code), connect GitHub, and select the
   private repository and branch. The Default cloud environment is enough for
   the first run; Anthropic's quick start explains plan-specific onboarding.
3. Submit this first task:

   ```text
   Set up career-ops in this checkout. Run npm install, then start the first-run
   onboarding. Keep cv.md, data/, and reports/ out of Git.
   ```

career-ops still uses ordinary workspace files in the cloud checkout, not
browser storage:

| Path (from the repository root) | What it holds |
|---|---|
| `cv.md` | Your master CV |
| `data/` | Tracker and other private workflow state |
| `reports/` | Job evaluations and generated reports |

`cv.md`, runtime content under `data/`, and Markdown files directly under
`reports/` are intentionally git-ignored because they contain personal data.
That also means a normal web-session branch push does **not** persist them to
GitHub: a new cloud session starts from the repository again, without the
ignored files from the previous VM. Keep a personal workflow in one session
and move any output you need to secure storage before its environment expires
([backup patterns](BACKUP_STRATEGIES.md)). Never force-add these paths. For a durable workspace shared across many
sessions, use the local quick start below.

### Recommended — one command

```bash
npx @santifer/career-ops init
```

`npx` ships with Node.js — it runs the installer once without installing anything globally. This clones the latest release into `./career-ops` and installs dependencies. Then move into the workspace and open your AI CLI:

```bash
cd career-ops
claude   # or codex / qwen / opencode / agy / grok
```

**On first launch, career-ops walks you through setup by chatting** — it asks for your CV, your details (name, target roles, salary), and sets up the job scanner with pre-configured companies. Nothing to edit by hand: just answer its questions. Then paste a job offer URL or description and it evaluates it, writes a report, generates a tailored PDF, and tracks it.

If you are using Codex, start the interactive session with `codex`. Slash commands are not guaranteed in Codex, so use the same mode names in a prompt if `/career-ops` is unavailable:

```text
Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123
Run the career-ops scan mode.
Run the career-ops pipeline mode.
Run the career-ops pdf mode.
Run the career-ops email mode for the latest evaluated role. Draft only; never sends, submits, or clicks.
Run the career-ops tracker mode.
```

For one-shot workers or batch tasks in Codex, use `codex exec`. See [docs/CODEX.md](CODEX.md) for the full guide.

```bash
codex exec "Evaluate this JD with career-ops auto-pipeline: https://company.com/jobs/123"
codex exec "Run career-ops scan mode in this repo."
codex exec "Run career-ops pipeline mode for data/pipeline.md."
codex exec "Run career-ops pdf mode for the latest evaluated role."
codex exec "Run career-ops email mode for the latest evaluated role. Draft only; do not send, submit, or click anything."
codex exec "Run career-ops tracker mode and summarize the current statuses."
```

### Advanced — clone manually

<details>
<summary>Prefer to clone the repo yourself?</summary>

```bash
git clone https://github.com/career-ops-hq/career-ops.git
cd career-ops
npm install
```

Then open your AI CLI in the folder — the same first-run onboarding applies. Use this path if you want to track a specific branch, contribute, or audit the code before installing dependencies.

</details>

### Contributing for the first time

If you want to contribute to career-ops, start with a small, focused change. Bug fixes, documentation, translations, and new zero-auth scanner providers can go straight to a pull request; new features, modes, commands, or architecture changes should start with an issue first.

The basic workflow is:

1. Fork the repository and create a branch from `main`.
2. Make one focused change and keep personal data such as `cv.md`, `profile.yml`, applications, and reports out of the commit.
3. Run the relevant checks; for a broad validation, use `node test-all.mjs --quick`.
4. Commit and push your branch to your fork.
5. Open a pull request against `career-ops-hq/career-ops` and explain what changed and why.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full contribution guidelines and examples of good first contributions.

### PDF rendering (one-time)

PDFs are rendered with a headless Chromium. Install it once per machine:

```bash
npx playwright install chromium
```

On NixOS, skip this step: the browsers it downloads can't run there. Use the flake dev shell instead, as described in [NIXOS.md](NIXOS.md).

On macOS releases where Playwright fails to install or launch bundled Chromium (e.g. macOS 12 Monterey), point Playwright to your system Google Chrome installation:

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The same setting applies to every command that launches a browser (scan, liveness checks, `doctor` and the PDF step), and it can go in your shell or in the `.env` of your data root. To let career-ops find an installed browser instead of naming one, set `CAREER_OPS_BROWSER_AUTODETECT=true`: it uses the first browser it finds at its standard install location, in this order: Brave, Chrome, Edge, Chromium on macOS; Brave, Chrome, Chromium, Edge on Linux; Brave, Chrome, Edge on Windows (it does not look for Chromium there, so name it with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`). Auto-detect is off by default, so a machine where the bundled Chromium works keeps using it, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` wins when both are set.

Pages career-ops does not control (job boards, ATS pages, application forms) open in your installed Google Chrome when no browser is configured, because Google patches it faster than Playwright ships Chromium builds, and always with Chromium's sandbox on where it can start. On Linux the sandbox needs either the setuid `chrome-sandbox` helper that Google's Chrome package installs, or unprivileged user namespaces, and it never runs as root; where neither is available, career-ops launches without it and `doctor` warns. If a launch fails with "No usable sandbox", set `CAREER_OPS_BROWSER_SANDBOX=off` in your shell or the data-root `.env` to launch without it, as Playwright does by default; `doctor` warns while it is set.

### Scanning through an outbound proxy

Node's ordinary `fetch()` may ignore `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` in a proxy-only sandbox. Provider requests can use those variables with `CAREER_OPS_TRUST_PROXY_EGRESS=1 node scan.mjs`. This uses a request-scoped proxy dispatcher; unrelated requests are unaffected, and `NO_PROXY` destinations still use the local private-address guard.

Set this flag **only when the configured proxy itself blocks connections to private, loopback and metadata addresses**. When a proxy resolves the destination remotely, career-ops cannot verify that final address locally; the proxy must enforce that part of the SSRF boundary. Without this explicit trust setting, provider requests keep their normal direct transport and a DNS failure names the proxy setup needed. Proxy URLs containing credentials must use HTTPS, except a loopback proxy (`localhost`, `127.*` or `::1`), where the credentials never leave the machine; credential-free HTTP proxies remain supported. Existing installations keep direct transport after a system update; proxy environment variables alone do not enable it. Before enabling the flag, run `npm install` in the career-ops directory to install the added `undici` dependency. It is loaded only for an opted-in request with a configured proxy, so direct scanning continues to work even before that dependency is installed.

The browser that the scanners, liveness checks and the dashboard's apply session start is different: all of its traffic goes through a local egress filter that refuses private, loopback and cloud-metadata addresses on every connection, redirects and DNS answers included. When `HTTPS_PROXY`, `HTTP_PROXY` or `ALL_PROXY` is set, the filter opens the browser's connections through that proxy, with or without `CAREER_OPS_TRUST_PROXY_EGRESS`, as Chromium does with those variables on Linux. A literal private address is still refused. A name is still checked when it resolves locally; a name that only the proxy can resolve is left to it. `NO_PROXY` destinations connect directly and are fully checked. The filter only chains through `http://` and `https://` proxies, not SOCKS, and the same credentials rule applies.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` or ask the agent to run `scan` |
| Process pending URLs | `/career-ops pipeline` or ask the agent to run `pipeline` |
| Generate a PDF | `/career-ops pdf` or ask the agent to run `pdf` |
| Draft application email | `/career-ops email` or ask the agent to run `email`; draft-only, never sends, submits, or clicks |
| Batch evaluate | `/career-ops batch` or use `codex exec "Run career-ops batch mode ..."` |
| Check tracker status | `/career-ops tracker` or ask the agent to run `tracker` |
| Fill application form | `/career-ops apply` or ask the agent to run `apply` |

## Verify Setup

```bash
node cv-sync-check.mjs      # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```

## Build Dashboard (Optional)

```bash
npm run serve:dashboard     # Opens TUI pipeline viewer
npm run build:dashboard     # Optional: build the standalone binary
```
