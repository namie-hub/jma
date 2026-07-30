# Consolidated batch — pipeline heartbeat + Japan ingest workflow
30 Jul 2026 · one root cause, three fixes: commit-only-on-change made a
healthy-but-quiet pipeline indistinguishable from a dead one. The pages now
ask the Actions run history directly (api.github.com, read-only, CORS-open),
and the Japan repo finally gets the workflow that runs its orphaned scripts.

## Repo namie-hub/jma — 3 files

1. **`.github/workflows/atlas-ingest.yml`** (NEW — Add file → Create new
   file, type the full path; if the leading dot drops, use the rename trick.)
   Runs every 30 min at :12/:42: HKO comparison track (`hko_tctrack.js`,
   frozen at its 23 Jul seed until now), Nankai latch, and the TC forecast
   archiver (`archive/tc_*.json` — starts banking bulletins for Batch 4).
   One serialized job, rebase-retry push, escalation = "no green run in 3 h".

2. **DELETE `.github/workflows/update-nankai.yml`** (open it → trash icon →
   commit). atlas-ingest.yml replaces it; keeping both would double-poll JMA
   and race pushes — the exact 23 Jul HK failure.

3. **`japan_weather_jma.html`** (replace) — HKO comparison popups now carry a
   heartbeat verdict instead of misreading data age as "ingest last ran".

4. **`japan_disaster_jma.html`** (replace) — live banner announces a dead
   Nankai latch pipeline (stalled/failed only; "couldn't check" stays quiet —
   the 10-min live poll is unaffected either way). Source line updated.

Then: Actions tab → "Japan Atlas data ingest" → Run workflow once.
Expected: green run + a commit touching `hko_tctrack.js` (current file is a
week old, so it WILL diff) and, with the active storm, `archive/tc_*.json`.

## Repo namie-hub/hka — 1 file

5. **`hk_storm_corridor.html`** (replace) — the false red "track ingest last
   ran 51 h ago" becomes: green pipeline → calm text ("data last changed X h
   ago · pipeline ran N min ago"); red only when the run history actually
   shows stalled (>3 h since a run) or failing (last run red). Heartbeat
   endpoint disclosed in the privacy footer. No other HK changes; the
   existing atlas-ingest.yml workflow is untouched.

## Verification (your one-time step)

- jma → Actions → "Update Nankai Trough advisory status": confirm hourly
  green runs existed before you delete it (run history survives deletion).
- After the manual dispatch of the new workflow: the weather page's HKO
  comparison should show the current storm within one Pages redeploy.

## Test record

- Workflow shell logic: 13/13 (git origin simulation: timestamp-only → no
  commit + clean worktree; per-file commits; archive detection; push-race
  rebase-retry; escalation vs stubbed API: transient/sustained/never-green).
- Pages: 32 checks × Chromium + WebKit, all passing — scenario matrix per
  page: green-fresh quiet, failing, stalled, unreachable+old data,
  unreachable+fresh data, active-storm green, active-storm stalled;
  zero page errors in every scenario.
- Not simulatable from here: live api.github.com responses (container IP is
  rate-limited; fixtures follow the documented schema) and real GITHUB_TOKEN
  permissions — the workflow's `actions: read` grant covers the escalation
  query, but the first live red run is the real test.

## Flag, not in this batch

The Japan pages load Leaflet from unpkg.com (CDN) — the HK Atlas vendors it
locally. Worth aligning with the no-CDN philosophy in a future batch.
