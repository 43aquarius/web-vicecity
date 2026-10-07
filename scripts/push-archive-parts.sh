#!/usr/bin/env bash
# Push the split archive parts to the web-vicecity archive-data branch.
#
# Usage:
#   GH_TOKEN=<token> bash scripts/push-archive-parts.sh "0 1 2"   # indices to add this batch
#
# Parts are 96,000,000 bytes (split -b 96MB, SI) and MUST match PART_SIZE
# in public/sw.js. Batches keep each push small enough to survive flaky
# networks; re-running a batch is safe (same content → same blobs).
set -euo pipefail

ROOT="/home/z/my-project"
DIR="$ROOT/gh-archive"
SLUG="43aquarius/web-vicecity"
BRANCH="archive-data"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "ERROR: GH_TOKEN is not set" >&2
  exit 1
fi
if [[ -z "${1:-}" ]]; then
  echo "ERROR: pass part indices, e.g. \"0 1 2\"" >&2
  exit 1
fi

GIT="git -c user.name=43aquarius -c user.email=43aquarius@users.noreply.github.com"
PUSH_URL="https://x-access-token:${GH_TOKEN}@github.com/${SLUG}.git"

cd "$DIR"
if [[ ! -d .git ]]; then
  git init -b "$BRANCH" -q
  cat > README.md <<'EOF'
# web-vicecity — archive data branch

This branch holds the reVCDOS packed game archive (`revcdos.bin`, 1,084,364,719 bytes)
split into 96,000,000-byte parts (`revcdos.bin.part00` … `revcdos.bin.part11`).

It exists so the browser Service Worker (`public/sw.js` of the `main` branch) can
fetch arbitrary byte ranges of the archive directly via
`raw.githubusercontent.com` (cross-origin ranged reads), with no game server involved.

Do NOT clone this branch casually — it is ~1.1 GB. If you need the archive:

    curl -O https://raw.githubusercontent.com/43aquaris/web-vicecity/archive-data/revcdos.bin.partNN
    cat revcdos.bin.part* > revcdos.bin
    sha256sum -c SHA256SUMS

The main branch README has full details.
EOF
  sha256sum revcdos.bin.part* > SHA256SUMS
  $GIT add README.md SHA256SUMS
  $GIT commit -q -m "archive mirror: README + checksums"
fi

for i in $1; do
  f="revcdos.bin.part$(printf '%02d' "$i")"
  [[ -f "$f" ]] || { echo "ERROR: missing $f" >&2; exit 1; }
  $GIT add "$f"
  if ! $GIT diff --cached --quiet; then
    $GIT commit -q -m "archive part $i ($(stat -c%s "$f") bytes)"
  else
    echo "part $i already committed — skipping"
  fi
done

echo "--- pushing $(git rev-list --count HEAD) commits, pack size below ---"
git count-objects -vH | grep -E "size-pack|size"

git push "$PUSH_URL" "HEAD:$BRANCH"
echo "push OK -> $SLUG:$BRANCH"
