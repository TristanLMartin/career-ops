#!/usr/bin/env bash
# hunt-cron: scheduled zero-token jobs. Sends no email.
#   scripts/hunt-cron.sh scan      # scan the boards, then re-rank (enrich)
#   scripts/hunt-cron.sh messages  # Job Hunt mail feed (Apps Script) -> data/hunt-messages.jsonl; no-op until JOBHUNT_FEED_URL/KEY are set
#   scripts/hunt-cron.sh discover  # daily: HN Who is hiring boards + roles (discovery, separate from portals.yml)
#   scripts/hunt-cron.sh boards-search # daily: Dice + Indeed via claude.ai connectors (Haiku, search tools only)
#   scripts/hunt-cron.sh wide-vc   # daily: VC portfolio boards (Getro, a16z, Greylock), Built In, YC listings
#   scripts/hunt-cron.sh wide-weekly # weekly: recruiter-named company boards + funding-news (GeekWire/TechCrunch) boards
#   scripts/hunt-cron.sh targets   # daily: named target companies (ATS boards + big-tech careers APIs), then their JDs
#   scripts/hunt-cron.sh h2h       # weekly: Sonnet head-to-head of the top 100 groups (Borda) -> data/hunt-h2h.json
#   scripts/hunt-cron.sh autoscore # score the day's top unscored roles (auto_score_per_day, Haiku; Sonnet retry),
#                                     # then re-check that the top 50 + every >180-day posting is still open (zero tokens)
#   scripts/hunt-cron.sh comp-refresh # quarterly: DOL H-1B LCA senior base per company -> data/comp-lca-summary.json
#   scripts/hunt-cron.sh ui        # start the web UI (CAREER_OPS_WEB_PORT, default 3000) if it isn't running
#
# Machine settings (port, which hosts may reach the UI) go in config/cron.env; see the .example.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
# Profiles: CAREER_OPS_ROOT=profiles/<id> (or the older alias CAREER_OPS_PROFILE_DIR) runs the
# same jobs for another person; every script follows it through path-resolver.mjs. Unset = the
# default profile (this checkout). A non-default profile runs only when its config/person.yml
# says `active: true` (the web UI always runs, so an empty profile still shows its start page).
# Jobs that call an LLM get --yes here: scheduling them is the consent (see lib/cli-guard.mjs).
case "${1:-}" in -h|--help|help) sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;; esac
DATA=data
if [ -n "${CAREER_OPS_PROFILE_DIR:-${CAREER_OPS_ROOT:-}}" ]; then
  PROFILE_DIR="${CAREER_OPS_PROFILE_DIR:-$CAREER_OPS_ROOT}"
  case "$PROFILE_DIR" in /*) ;; *) PROFILE_DIR="$PWD/$PROFILE_DIR" ;; esac
  DATA="$PROFILE_DIR/data"
  mkdir -p "$DATA"
  if [ "${1:-}" != "ui" ] && ! grep -qE '^active:[[:space:]]*true\b' "$PROFILE_DIR/config/person.yml" 2>/dev/null; then exit 0; fi
fi
# config/cron.env (gitignored): CAREER_OPS_WEB_PORT, CAREER_OPS_WEB_ALLOWED_HOSTS, ...
for f in config/cron.env ${CAREER_OPS_LEGACY_PREFIX:+config/${CAREER_OPS_LEGACY_PREFIX}cron.env}; do [ -f "$f" ] && { set -a; . "./$f"; set +a; break; }; done
WEB_PORT="${CAREER_OPS_WEB_PORT:-3000}"
# Hosts allowed to reach the UI besides loopback (web/README.md), e.g. "192.168.1.50, mybox.local".
ALLOWED_HOSTS="${CAREER_OPS_WEB_ALLOWED_HOSTS:-localhost}"
LOG="$DATA/hunt-cron.log"
stamp() { date '+%Y-%m-%d %H:%M:%S'; }
# One run at a time per job.
exec 9>"$DATA/.hunt-cron-${1:-scan}.lock"
flock -n 9 || { echo "$(stamp) $1: previous run still going, skipped" >> "$LOG"; exit 0; }
case "${1:-}" in
  scan)
    echo "$(stamp) scan: start" >> "$LOG"
    # Another profile with config/shared-boards.yml picks up the default profile's boards (read-only).
    if [ -n "${PROFILE_DIR:-}" ] && [ -f "$PROFILE_DIR/config/shared-boards.yml" ]; then
      node scripts/hunt-profile-boards.mjs >> "$LOG" 2>&1
    fi
    node scan.mjs > "$DATA/hunt-last-scan.log" 2>&1
    echo "$(stamp) scan: exit $? ($(grep -m1 'New offers added' "$DATA/hunt-last-scan.log" | tr -s ' '))" >> "$LOG"
    # Boards found by discovery (HN / manual adds), same filters, separate portals file.
    node scripts/hunt-discover.mjs --no-fetch --scan boards >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --quiet >> "$LOG" 2>&1
    echo "$(stamp) enrich: exit $?" >> "$LOG"
    ;;
  messages)
    node scripts/hunt-messages-sync.mjs >> "$LOG" 2>&1
    # Rules place most threads for free; only new ambiguous ones go to Haiku (cached per thread).
    node scripts/hunt-message-kinds.mjs --yes >> "$LOG" 2>&1
    ;;
  discover)
    # Daily: refresh HN "Who is hiring?" boards, then scan the HN thread itself.
    node scripts/hunt-discover.mjs --scan hn >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --quiet >> "$LOG" 2>&1
    ;;
  boards-search)
    # Daily: one short Haiku call to the Dice and Indeed connectors, ingested via add-job.
    node scripts/hunt-discovery-boards.mjs --yes >> "$LOG" 2>&1
    ;;
  wide-vc)
    node scripts/hunt-discover-wide.mjs vc >> "$LOG" 2>&1
    node scripts/hunt-jd-fetch.mjs >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    ;;
  wide-weekly)
    # New boards join data/discovery-boards.yml, which every scan reads.
    node scripts/hunt-discover-wide.mjs boards >> "$LOG" 2>&1
    node scripts/hunt-discover-wide.mjs funding >> "$LOG" 2>&1
    ;;
  targets)
    node scripts/hunt-discover-wide.mjs targets >> "$LOG" 2>&1
    node scripts/hunt-jd-fetch.mjs >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    ;;
  h2h)
    node scripts/hunt-h2h.mjs --yes >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    ;;
  autoscore)
    echo "$(stamp) autoscore: start" >> "$LOG"
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    node scripts/hunt-autoscore.mjs --yes >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    # Quick 1-5 Haiku score for every posting that has none yet (batched, ~$0.0007 a posting).
    node scripts/hunt-quickscore.mjs --yes >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    # Posting age never demotes a job; a closed one leaves Best overall (data/hunt-liveness.json).
    node scripts/hunt-liveness.mjs >> "$LOG" 2>&1
    echo "$(stamp) autoscore: done" >> "$LOG"
    ;;
  comp-refresh)
    echo "$(stamp) comp-refresh: start" >> "$LOG"
    node scripts/hunt-comp-validate.mjs >> "$LOG" 2>&1
    node scripts/hunt-comp-refresh.mjs >> "$LOG" 2>&1
    node scripts/hunt-enrich.mjs --no-fetch --quiet >> "$LOG" 2>&1
    echo "$(stamp) comp-refresh: done" >> "$LOG"
    ;;
  ui)
    if ss -ltn "sport = :$WEB_PORT" | grep -q LISTEN; then exit 0; fi
    echo "$(stamp) ui: starting on :$WEB_PORT" >> "$LOG"
    case "$DATA" in /*) UI_LOG="$DATA/web-ui.log" ;; *) UI_LOG="$PWD/$DATA/web-ui.log" ;; esac
    # Production server (web/README.md: `npm start` after `npm run build`); `npm run ui` runs next dev.
    ( cd web && CAREER_OPS_WEB_ALLOWED_HOSTS="$ALLOWED_HOSTS" \
      setsid nohup npm start -- -p "$WEB_PORT" >> "$UI_LOG" 2>&1 < /dev/null & )
    ;;
  *) echo "usage: $0 scan|messages|discover|boards-search|wide-vc|wide-weekly|targets|h2h|autoscore|comp-refresh|ui" >&2; exit 2 ;;
esac
