#!/bin/bash
# Adapt the original reVCDOS index.html inline CSS into src/app/vc-game.css
set -e
SRC=/tmp/vc-style.css
DST=/home/z/my-project/src/app/vc-game.css

{
  echo "/* ============================================================"
  echo " * reVCDOS game shell styles (extracted from upstream dist/index.html)"
  echo " * https://github.com/Lolendor/reVCDOS — MIT"
  echo " * Patched: asset paths point at /game/*, plus landing-page rules."
  echo " * ============================================================ */"
  echo ""
  cat "$SRC"
  echo ""
  echo "/* ---- web integration additions ---- */"
  echo "body.gameIsStarted .vc-landing {"
  echo "    display: none !important;"
  echo "}"
  echo "body.gameIsStarted {"
  echo "    overflow: hidden;"
  echo "}"
} > "$DST"

# Fix asset path for the cover image
sed -i 's|url(/cover.jpg)|url(/game/cover.jpg)|g' "$DST"
sed -i 's|url("/cover.jpg")|url("/game/cover.jpg")|g' "$DST"

echo "written: $DST ($(wc -c < "$DST") bytes)"
grep -n "cover.jpg" "$DST" | head -3
