#!/usr/bin/env python3
"""ingest_tctrack.py — fetch HKO tropical-cyclone forecast tracks and write hko_tctrack.js.

Why this exists: HKO publishes machine-readable TC track XML (tc_list.xml +
hko_tctrack_{TCID}.xml) on www.weather.gov.hk, but with NO CORS headers —
verified on www.weather.gov.hk, www.hko.gov.hk, data.weather.gov.hk (301s
back to www.hko.gov.hk), and the CSDI dataset zip. A static page cannot
fetch any of these live, so this is the AQHI pattern: GitHub Actions ingest
into a <script>-tag data file.

Cadence honesty: HKO updates forecast tracks 3-hourly for TCs inside
10-30N/105-125E and 6-hourly outside (per tc_fixarea.htm). A 30-minute
Actions run keeps the file at most half an hour behind a 3-hourly product.
The page shows BulletinTime (publication) and generatedAt (fetch)
separately, so staleness is always visible, never hidden.

Output:
    const HK_TCTRACK = { generatedAt, source, storms: [
        { id, nameEn, nameZh, bulletinTime,
          analysis: {lat, lon, time, intensity, wind},
          past:     [{lat, lon, time, intensity, wind}, ...],
          forecast: [{i, lat, lon, time?, intensity?, wind?}, ...] } ] };

forecast is hourly-interpolated by HKO (Index = hours ahead, typically
1..120); only 24-hour waypoints carry time/intensity/wind. All points are
kept: the full list draws the smooth line, the waypoints get markers.

storms: [] with a fresh generatedAt is a REAL ANSWER (no forecast track
currently issued by HKO), not a failure.

Fail-loudly policy: any fetch or parse failure exits non-zero WITHOUT
writing, so the previous file stays in place and its ageing generatedAt
makes the outage visible on the page, while the Actions failure email is
the alert. A partially-written file could silently hide a storm.
"""
from __future__ import annotations

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

LIST_URL = "https://www.weather.gov.hk/wxinfo/currwx/tc_list.xml"
OUT = Path(__file__).resolve().parent.parent / "hko_tctrack.js"
UA = {"User-Agent": "hk-weather-atlas-tctrack-ingest"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=30).read()


def parse_deg(txt: str, kind: str) -> float:
    """'15.00N' -> 15.0 ; '130.20E' -> 130.2. S/W become negative."""
    txt = (txt or "").strip()
    if not txt or txt[-1] not in "NSEW":
        raise ValueError(f"bad {kind}: {txt!r}")
    v = float(txt[:-1])
    if txt[-1] in "SW":
        v = -v
    # Sanity bounds for the western North Pacific / South China Sea:
    if kind == "lat" and not (-10.0 <= v <= 60.0):
        raise ValueError(f"lat out of basin: {v}")
    if kind == "lon" and not (90.0 <= v <= 180.0):
        raise ValueError(f"lon out of basin: {v}")
    return v


def point(el: ET.Element, want_index: bool) -> dict:
    p: dict = {}
    if want_index:
        idx = el.findtext("Index")
        if idx is not None:
            p["i"] = int(idx)
    p["lat"] = parse_deg(el.findtext("Latitude"), "lat")
    p["lon"] = parse_deg(el.findtext("Longitude"), "lon")
    for src, dst in (("Time", "time"), ("Intensity", "intensity"), ("MaximumWind", "wind")):
        v = el.findtext(src)
        if v:
            p[dst] = v.strip()
    return p


def parse_track(xml_bytes: bytes, tcid: str) -> dict:
    root = ET.fromstring(xml_bytes)
    if root.tag != "TropicalCycloneTrack":
        raise ValueError(f"unexpected root tag {root.tag!r} for TC {tcid}")
    bulletin = root.findtext("BulletinHeader/BulletinTime")
    wr = root.find("WeatherReport")
    if wr is None or not bulletin:
        raise ValueError(f"missing WeatherReport/BulletinTime for TC {tcid}")
    ana_el = wr.find("AnalysisInformation")
    if ana_el is None:
        raise ValueError(f"missing AnalysisInformation for TC {tcid}")
    past = [point(e, want_index=True) for e in wr.findall("PastInformation")]
    past.sort(key=lambda p: p.get("i", 0))
    forecast = [point(e, want_index=True) for e in wr.findall("ForecastInformation")]
    forecast.sort(key=lambda p: p.get("i", 0))
    if not forecast:
        raise ValueError(f"no forecast points for TC {tcid} — format may have changed")
    return {
        "bulletinTime": bulletin,
        "analysis": point(ana_el, want_index=False),
        "past": past,
        "forecast": forecast,
    }


def main() -> int:
    list_xml = ET.fromstring(fetch(LIST_URL))
    if list_xml.tag != "TropicalCycloneList":
        print(f"FAIL: unexpected list root {list_xml.tag!r}", file=sys.stderr)
        return 1

    storms = []
    for tc in list_xml.findall("TropicalCyclone"):
        tcid = (tc.findtext("TropicalCycloneID") or "").strip()
        url = (tc.findtext("TropicalCycloneURL") or "").strip()
        if not tcid or not url:
            print(f"FAIL: list entry missing ID or URL: {ET.tostring(tc)[:120]!r}", file=sys.stderr)
            return 1
        url = url.replace("http://", "https://", 1)  # list still gives http://
        track = parse_track(fetch(url), tcid)
        storms.append({
            "id": tcid,
            "nameEn": (tc.findtext("TropicalCycloneEnglishName") or "").strip(),
            "nameZh": (tc.findtext("TropicalCycloneChineseName") or "").strip(),
            **track,
        })

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "HKO tc_list.xml + hko_tctrack_{TCID}.xml on www.weather.gov.hk "
                  "(no CORS headers; ingested every 30 min by GitHub Actions)",
        "storms": storms,
    }
    OUT.write_text(
        "/* hko_tctrack.js — GENERATED by scripts/ingest_tctrack.py. Do not edit by hand.\n"
        " * HKO updates TC forecast tracks 3-hourly (6-hourly for distant systems);\n"
        " * this file is refreshed every 30 minutes by Actions, commit-only-on-change.\n"
        " * storms: [] means HKO currently issues no forecast track — a real answer.\n"
        " * The page shows bulletinTime and generatedAt separately: staleness is\n"
        " * always visible, never hidden. */\n"
        f"const HK_TCTRACK = {json.dumps(payload, indent=2, ensure_ascii=False)};\n",
        encoding="utf-8",
    )
    if storms:
        names = ", ".join(f"{s['nameEn']} (#{s['id']}, {len(s['forecast'])} fc pts)" for s in storms)
        print(f"OK: {len(storms)} storm(s): {names}")
    else:
        print("OK: no forecast track currently issued by HKO (real answer, file written).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # fail loudly, write nothing
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
