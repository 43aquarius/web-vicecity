#!/usr/bin/env bash
# Push ALL THREE branches of 43aquarius/web-vicecity to GitHub:
#   main    (from gh-deploy/)     — the Next.js site (center node)
#   relay-a (from gh-relay-a/)    — auxiliary relay, partition [0, 361454906)
#   relay-b (from gh-relay-b/)    — auxiliary relay, partition [361454906, 722909812)
#
# Usage:
#   GH_TOKEN=<personal access token> bash scripts/gh-push-all.sh
#
# The token is NEVER written to any file (push URL injection only, no remotes
# are configured). Each branch push is independent; a summary is printed at
# the end. --force is used so the locally assembled trees always win (they
# are the source of truth assembled by this workspace).
set -uo pipefail

ROOT="/home/z/my-project"
SLUG="43aquarius/web-vicecity"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "ERROR: GH_TOKEN is not set" >&2
  echo "Usage: GH_TOKEN=<token> bash $0" >&2
  exit 1
fi
PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${SLUG}.git"

declare -A RESULT=()

push_branch() {
  local dir="$1" branch="$2" label="$3"
  echo ""
  echo "=== pushing $label -> $branch ==="
  if (cd "$dir" && git push -q --force "$PUSH_URL" "$branch" 2>&1); then
    RESULT[$label]="OK"
    echo "push $label: OK"
  else
    RESULT[$label]="FAILED"
    echo "push $label: FAILED — retry manually: (cd $dir && git push --force $PUSH_URL $branch)"
  fi
}

push_branch "$ROOT/gh-deploy"  "main"    "main (center node)"
push_branch "$ROOT/gh-relay-a" "relay-a" "relay-a [0, 361454906)"
push_branch "$ROOT/gh-relay-b" "relay-b" "relay-b [361454906, 722909812)"

echo ""
echo "================ SUMMARY ================"
for k in main relay-a relay-b; do
  echo "  $k: ${RESULT[$k]:-UNKNOWN}"
done
echo ""

echo "--- remote refs after push ---"
git ls-remote "https://github.com/${SLUG}.git" | sed 's/\t/  /'

# Token hygiene: confirm nothing was persisted.
for d in gh-deploy gh-relay-a gh-relay-b; do
  if git -C "$ROOT/$d" remote -v | grep -q .; then
    echo "WARNING: $d has a remote configured — check for token leakage!"
  fi
done
echo "token hygiene check done (no remotes configured = clean)"
