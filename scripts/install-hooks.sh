#!/usr/bin/env bash
# install-hooks: install the pre-push hook that runs scripts/secret-scan.sh --pre-push.
# An existing pre-push hook is kept as pre-push.local and still runs first.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
case "${1:-}" in -h|--help) sed -n '2,3p' "$0" | sed 's/^# //'; exit 0 ;; esac
hooks="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks"
if [ -f "$hooks/pre-push" ] && ! grep -q "secret-scan.sh" "$hooks/pre-push"; then mv "$hooks/pre-push" "$hooks/pre-push.local"; fi
cat > "$hooks/pre-push" <<'HOOK'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh. Bypass once (not recommended): git push --no-verify
set -uo pipefail
input="$(cat)"
hooks="$(dirname "$0")"
if [ -x "$hooks/pre-push.local" ]; then printf '%s\n' "$input" | "$hooks/pre-push.local" "$@" || exit 1; fi
printf '%s\n' "$input" | "$(git rev-parse --show-toplevel)/scripts/secret-scan.sh" --pre-push
HOOK
chmod +x "$hooks/pre-push"
grep -qxF ".secret-scan-words" .gitignore || printf '\n# Personal words for scripts/secret-scan.sh (never committed)\n.secret-scan-words\n' >> .gitignore
echo "installed $hooks/pre-push (runs scripts/secret-scan.sh --pre-push)"
echo "tip: list your name, email, phone and hostnames in .secret-scan-words (gitignored) so pushes are checked for them"
