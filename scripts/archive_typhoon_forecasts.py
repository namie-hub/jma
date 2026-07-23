#!/usr/bin/env python3
"""Archive live JMA typhoon forecasts for hindsight verification.

Each run fetches the current target-TC list and, for every active system,
appends the current bulletin (forecast.json + specifications.json, stored
verbatim) to archive/tc_<ID>.json — deduplicated on the bulletin issue
time, so re-runs between bulletins change nothing and the Actions job
commits nothing.

Why this exists: jma_typhoon_history.js already holds the OUTCOME (the
best-track archive), but forecasts as they were issued cannot be
backfilled — every storm that passes unarchived is a verification case
lost forever. Scoring code can come later; the data has to start now.

Fail-loudly: any fetch or parse error exits 1 without writing, so the
scheduled workflow fails and GitHub emails the owner. No storms is a
normal, silent success.

Usage: python3 scripts/archive_typhoon_forecasts.py [archive_dir]
"""
import json, os, sys, datetime, urllib.request

JMA = "https://www.jma.go.jp/bosai"

def fetch_json(path):
    req = urllib.request.Request(JMA + path, headers={"User-Agent": "japan-weather-atlas archiver"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))

def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "archive"
    targets = fetch_json("/typhoon/data/targetTc.json")
    if not targets:
        print("No active tropical cyclones — nothing to archive.")
        return

    os.makedirs(out_dir, exist_ok=True)
    fetched_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    changed = 0

    for tc in targets:
        tc_id = tc.get("tropicalCyclone")
        if not tc_id:
            raise SystemExit("targetTc entry without tropicalCyclone id: %r" % tc)
        fc = fetch_json("/typhoon/data/%s/forecast.json" % tc_id)
        try:
            sp = fetch_json("/typhoon/data/%s/specifications.json" % tc_id)
        except Exception:
            sp = None  # specifications are optional for depressions

        title = fc[0] if fc and isinstance(fc[0], dict) else {}
        issue = ((title.get("issue") or {}).get("UTC")
                 or (title.get("issue") or {}).get("JST"))
        if not issue:
            raise SystemExit("bulletin for %s carries no issue time — refusing to archive blind" % tc_id)

        path = os.path.join(out_dir, "tc_%s.json" % tc_id)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        else:
            doc = {"tcId": tc_id,
                   "typhoonNumber": title.get("typhoonNumber"),
                   "nameEn": (title.get("name") or {}).get("en"),
                   "snapshots": []}

        if any(s["issue"] == issue for s in doc["snapshots"]):
            print("%s: bulletin %s already archived." % (tc_id, issue))
            continue

        doc["snapshots"].append({"issue": issue, "fetchedAt": fetched_at,
                                 "forecast": fc, "specifications": sp})
        doc["snapshots"].sort(key=lambda s: s["issue"])
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
        changed += 1
        print("%s: archived bulletin %s (%d snapshots total)." %
              (tc_id, issue, len(doc["snapshots"])))

    print("Done — %d file(s) updated." % changed)

if __name__ == "__main__":
    main()
