#!/usr/bin/env bash
# make_manifest.sh — regenerate MANIFEST.sha256, the integrity record for
# hand-authored source.
#
# Why this script exists: the 23 Jul manifest was written by hand and was
# stale within days. It listed two workflows that had been consolidated away
# (archive-forecasts.yml, update-hko-tctrack.yml), wrote their paths without
# the leading dot so they could not even be opened, and carried hashes for
# files it simultaneously declared would diverge. A record that cannot pass
# is a record nobody runs. This makes regeneration a single command.
#
# Scope decision: Actions-owned generated files are EXCLUDED, not listed and
# excused. hko_tctrack.js, jma_early.js, jma_nankai.js, jma_phenology.js and
# jma_typhoon_history.js are rewritten by the ingest workflows — including
# them guarantees a failing verify and trains you to ignore the output.
#
# Adding a new ingest means adding its output here. jma_early.js was caught
# on its first manifest regeneration precisely because it was not: it landed
# in the list, which would have failed verify-manifest on the very next
# atlas-ingest commit.
# archive/* is bot-appended for the same reason. japan-weather-atlas.zip is a
# derived bundle of the pages, not a source.
#
# jma_cities.js IS included: its header says "Generated from JMA constants",
# but no script in this repo writes it — it was derived once and committed,
# so for integrity purposes it is hand-authored source.
#
# Usage:  bash scripts/make_manifest.sh
# Verify: sha256sum -c MANIFEST.sha256      (macOS: shasum -a 256 -c)
set -euo pipefail
cd "$(dirname "$0")/.."

GENERATED='^(hko_tctrack|jma_early|jma_nankai|jma_phenology|jma_typhoon_history)\.js$'

{
  echo "# Japan Weather/Disaster Atlas — hand-authored source integrity record"
  echo "# Generated: $(date -u '+%Y-%m-%d %H:%M UTC') by scripts/make_manifest.sh"
  echo "#"
  echo "# EXCLUDED by design (Actions-owned, rewritten by the ingest workflows):"
  echo "#   hko_tctrack.js  jma_early.js  jma_nankai.js  jma_phenology.js"
  echo "#   jma_typhoon_history.js"
  echo "#   archive/*  and the derived japan-weather-atlas.zip bundle."
  echo "# Everything below is hand-authored: a mismatch is a real finding."
  echo "#"
  echo "# Verify: sha256sum -c MANIFEST.sha256   (macOS: shasum -a 256 -c)"
  echo "#"
  echo "# sha256  path"
  # git ls-files keeps this to tracked files so the manifest cannot drift
  # from the repo; the find fallback lets it run from a downloaded ZIP too.
  if git rev-parse --git-dir >/dev/null 2>&1; then
    git ls-files
  else
    find . -type f -not -path './.git/*' -not -path '*/__pycache__/*' \
      | sed 's|^\./||'
  fi \
    | grep -Ev "$GENERATED" \
    | grep -Ev '^archive/' \
    | grep -Ev '\.zip$' \
    | grep -Fxv 'MANIFEST.sha256' \
    | LC_ALL=C sort \
    | xargs sha256sum
} > MANIFEST.sha256

echo "MANIFEST.sha256 regenerated: $(grep -cv '^#' MANIFEST.sha256) entries."
