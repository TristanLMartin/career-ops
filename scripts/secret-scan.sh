#!/usr/bin/env bash
# secret-scan: look for secrets and personal data before anything leaves this machine.
#
#   scripts/secret-scan.sh              scan the working tree (tracked + staged files)
#   scripts/secret-scan.sh --history    scan every commit in the repository's history too
#   scripts/secret-scan.sh --pre-push   used by the git pre-push hook: scans the commits being pushed
#                                       (refs on stdin, as git passes them)
#
# Two layers:
#   1. gitleaks (https://github.com/gitleaks/gitleaks) when it is on PATH or in ~/bin: API keys,
#      tokens, private keys, high-entropy secrets.
#   2. A pattern scan that needs nothing installed: Anthropic / OpenAI / AWS / GitHub / Slack /
#      Google keys, private keys, Bearer tokens, filled-in JOBHUNT_FEED_KEY / CAREER_OPS_MCP_TOKEN
#      values, Tailscale MagicDNS names, MCP URLs with a token, and YOUR OWN words: put your name,
#      email, phone, hostnames, LAN / Tailscale IPs etc. one per line in .secret-scan-words
#      (gitignored, never committed).
#
# Known false positives: one extended regex per line in .secret-scan-allow (committed); a match on
# a line that also matches one of those is ignored. gitleaks reads .gitleaks.toml. Exit 1 when anything is found.
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || dirname "$0"/..)" || exit 2
MODE="${1:-tree}"
case "$MODE" in -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;; esac

found=0
red() { printf '\033[31m%s\033[0m\n' "$*"; }

PATTERNS=(
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-(proj-)?[A-Za-z0-9]{32,}'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{30,}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '[Bb]earer [A-Za-z0-9._~+/-]{24,}'
  '(JOBHUNT_FEED_KEY|CAREER_OPS_MCP_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GEMINI_API_KEY)=["'"'"']?[A-Za-z0-9._~+/-]{12,}'
  'script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}'
  '[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net'
  '/mcp/[A-Za-z0-9_-]{32,}'
)
WORDS=()
if [ -f .secret-scan-words ]; then
  while IFS= read -r w; do w="${w%%#*}"; w="$(echo "$w" | sed 's/[[:space:]]*$//')"; [ -n "$w" ] && WORDS+=("$w"); done < .secret-scan-words
fi
ALLOW=()
if [ -f .secret-scan-allow ]; then
  while IFS= read -r a; do [ -n "$a" ] && [ "${a:0:1}" != "#" ] && ALLOW+=("$a"); done < .secret-scan-allow
fi

# filter: drop lines matching an allow regex
allow_filter() {
  if [ ${#ALLOW[@]} -eq 0 ]; then cat; return; fi
  local args=()
  for a in "${ALLOW[@]}"; do args+=(-e "$a"); done
  grep -v -E "${args[@]}" || true
}

report() { # $1 = label, stdin = hits
  local hits
  hits="$(allow_filter | head -50)"
  if [ -n "$hits" ]; then
    found=1
    red "secret-scan: $1"
    printf '%s\n' "$hits" | cut -c1-200
  fi
}

pattern_args() {
  local args=()
  for p in "${PATTERNS[@]}"; do args+=(-e "$p"); done
  printf '%s\0' "${args[@]}"
}

scan_tree() {
  local -a pargs
  mapfile -d '' pargs < <(pattern_args)
  report "secret-looking strings in tracked files" < <(git grep --cached -I -n -E "${pargs[@]}" -- . ':!package-lock.json' ':!web/package-lock.json' ':!mcp/package-lock.json' 2>/dev/null)
  if [ ${#WORDS[@]} -gt 0 ]; then
    local wargs=()
    for w in "${WORDS[@]}"; do wargs+=(-e "$w"); done
    report "your .secret-scan-words in tracked files" < <(git grep --cached -I -n -i -F "${wargs[@]}" 2>/dev/null)
  fi
}

# $1 = rev-list range arguments (e.g. "abc..def" or "--all")
scan_commits() {
  local -a pargs
  mapfile -d '' pargs < <(pattern_args)
  # added lines only, with the commit they came from
  git log -p --no-color --format='commit %h' "$@" 2>/dev/null \
    | awk '/^commit /{c=$2} /^\+\+\+ b\//{f=substr($0,7)} /^\+[^+]/{print f":"c": "substr($0,2)}' > "${TMPDIR:-/tmp}/secret-scan.$$"
  report "secret-looking strings in commit history" < <(grep -E "${pargs[@]}" "${TMPDIR:-/tmp}/secret-scan.$$")
  if [ ${#WORDS[@]} -gt 0 ]; then
    local wargs=()
    for w in "${WORDS[@]}"; do wargs+=(-e "$w"); done
    report "your .secret-scan-words in commit history" < <(grep -i -F "${wargs[@]}" "${TMPDIR:-/tmp}/secret-scan.$$")
    report "your .secret-scan-words in commit authors" < <(git log --format='%h %an <%ae> | %cn <%ce>' "$@" | grep -i -F "${wargs[@]}")
  fi
  rm -f "${TMPDIR:-/tmp}/secret-scan.$$"
}

GITLEAKS="$(command -v gitleaks || { [ -x "$HOME/bin/gitleaks" ] && echo "$HOME/bin/gitleaks"; } || true)"
run_gitleaks() { # $@ = gitleaks args
  if [ -z "$GITLEAKS" ]; then echo "secret-scan: gitleaks not installed (https://github.com/gitleaks/gitleaks/releases); pattern scan only"; return; fi
  local cfg=(); [ -f .gitleaks.toml ] && cfg=(--config "$PWD/.gitleaks.toml")
  if ! "$GITLEAKS" "$@" "${cfg[@]}" --no-banner --redact --exit-code 1 >/tmp/secret-scan-gitleaks.$$ 2>&1; then
    found=1; red "secret-scan: gitleaks found something"; tail -40 /tmp/secret-scan-gitleaks.$$
  fi
  rm -f /tmp/secret-scan-gitleaks.$$
}

case "$MODE" in
  tree|--tree)
    scan_tree
    tmp="$(mktemp -d)"; git ls-files -z | xargs -0 -I{} cp --parents {} "$tmp" 2>/dev/null
    run_gitleaks dir "$tmp"; rm -rf "$tmp"
    ;;
  --history)
    scan_tree
    scan_commits --all
    run_gitleaks git .
    ;;
  --pre-push)
    zero=0000000000000000000000000000000000000000
    while read -r _lref lsha _rref rsha; do
      [ "$lsha" = "$zero" ] && continue                       # deleting a branch
      if [ "$rsha" = "$zero" ]; then range=("$lsha" --not --remotes); else range=("$rsha..$lsha"); fi
      scan_commits "${range[@]}"
      if [ "$rsha" = "$zero" ]; then run_gitleaks git . --log-opts="$lsha --not --remotes"; else run_gitleaks git . --log-opts="$rsha..$lsha"; fi
    done
    scan_tree
    ;;
  *) echo "usage: $0 [--history|--pre-push]" >&2; exit 2 ;;
esac

if [ "$found" -ne 0 ]; then
  red "secret-scan: FAILED. Remove the secret (and rewrite history if it was committed), or add a narrow regex to .secret-scan-allow for a false positive."
  exit 1
fi
echo "secret-scan: clean ($MODE)"
