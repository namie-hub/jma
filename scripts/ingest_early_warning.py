#!/usr/bin/env python3
"""
ingest_early_warning.py — 警戒レベル1 早期注意情報 into jma_early.js

Level 1 is the only rung of the 警戒レベル ladder the Atlas could not read.
Levels 2-5 arrive as codes in warning/data/r8/{office}.json; level 1 does
not exist there at all. It lives in a separate product family carried by the
developer XML *regular* feed:

    VPFD61  早期注意情報（明後日まで）      through the day after tomorrow
    VPFD60  警報級の可能性（明日まで）      through tomorrow
    VPFW60  警報級の可能性（明後日以降）    day 3 onward, weekly outlook

VPFD61 is the one ingested here: it is the widest near-term window (P2DT10H)
and supersedes VPFD60's coverage, so taking both would double-count the same
forecast under two titles.

WHY AN ACTIONS INGEST AND NOT A BROWSER FETCH
The Atom index gives only a title per entry — the 高/中 grading lives inside
each individual telegram. There are ~62 of them at ~23 kB each, so a browser
doing this would pull about 1.4 MB before it could colour a single chip.
Once per cron run from Actions, committed as a compact registry, is the
right shape. Same reasoning as ingest_nankai.py.

WHAT THIS IS, AND WHAT IT IS NOT
This is a forecast of POSSIBILITY, not an observation and not a warning.
JMA grades it 高 ("high") or 中 ("medium") per 6- or 12-hour window, meaning
"we may issue a 警報 for this in that window". Nothing has happened yet. The
Atlas must never render it in the same visual language as an in-force
warning, and the generated file is deliberately shaped to make that hard to
get wrong: every record carries kind="possibility" and no warning code.

Usage:  python3 scripts/ingest_early_warning.py jma_early.js
Exit:   0 on success (file written), non-zero on feed failure so the
        workflow failure email fires — the established reactive model.
"""
import json, re, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

FEED = "https://www.data.jma.go.jp/developer/xml/feed/regular.xml"
UA = {"User-Agent": "namie-hub-jma-atlas early-warning ingest (github.com/namie-hub/jma)"}
WANTED_TITLE = "早期注意情報（明後日まで）"

ATOM = "{http://www.w3.org/2005/Atom}"
JMX_IB = "{http://xml.kishou.go.jp/jmaxml1/informationBasis1/}"
JMX_MB = "{http://xml.kishou.go.jp/jmaxml1/body/meteorology1/}"
JMX_EB = "{http://xml.kishou.go.jp/jmaxml1/elementBasis1/}"

# JMA writes "大雨の警報級の可能性"; the leading noun is what we keep.
TYPE_RE = re.compile(r"^(.+?)の警報級の可能性$")

# Only ranks that mean something. "なし" and condition="値なし" are the
# overwhelming majority of cells and carry no information worth shipping.
REAL_RANKS = {"高", "中"}

# Maps JMA's forecast-element noun onto the same element vocabulary the
# warning table uses, so the page can pair a level-1 possibility with the
# level-2..5 code family it would become. Anything unmapped is kept with its
# Japanese name rather than dropped — an unrecognised element must surface.
ELEM = {
    "大雨":      {"el": "rain",      "en": "Heavy rain"},
    "土砂災害":  {"el": "landslide", "en": "Landslide"},
    "洪水":      {"el": "flood",     "en": "Flood"},
    "雪":        {"el": "snow",      "en": "Heavy snow"},
    "風（風雪）": {"el": "wind",      "en": "Wind / snowstorm"},
    "風":        {"el": "wind",      "en": "Wind"},
    "波":        {"el": "wave",      "en": "High waves"},
    "潮位":      {"el": "tide",      "en": "Storm surge"},
    "雷":        {"el": "thunder",   "en": "Thunderstorm"},
}


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def entry_urls(feed_xml):
    """Every VPFD61 telegram URL in the feed index, newest per office only.

    JMA reissues these; the feed can hold several generations of the same
    office's bulletin. Keyed by office name and kept newest-first so a
    superseded bulletin never overwrites a current one."""
    root = ET.fromstring(feed_xml)
    by_office = {}
    for e in root.iter(ATOM + "entry"):
        title = (e.findtext(ATOM + "title") or "").strip()
        if title != WANTED_TITLE:
            continue
        updated = (e.findtext(ATOM + "updated") or "").strip()
        # <author><name> is the publishing office
        office = ""
        author = e.find(ATOM + "author")
        if author is not None:
            office = (author.findtext(ATOM + "name") or "").strip()
        link = e.find(ATOM + "link")
        href = link.get("href") if link is not None else None
        if not href:
            continue
        prev = by_office.get(office)
        if prev is None or updated > prev[0]:
            by_office[office] = (updated, href)
    return [(o, u, h) for o, (u, h) in by_office.items()]


def parse_telegram(xml_bytes):
    """-> (report_iso, office, {areaCode: {...}}). Raises on malformed XML."""
    root = ET.fromstring(xml_bytes)
    head = root.find(JMX_IB + "Head")
    report = (head.findtext(JMX_IB + "ReportDateTime") or "") if head is not None else ""
    ctrl = root.find("{http://xml.kishou.go.jp/jmaxml1/}Control")
    office = (ctrl.findtext("{http://xml.kishou.go.jp/jmaxml1/}PublishingOffice") or "") if ctrl is not None else ""

    # TimeDefines are shared across all Items in the TimeSeriesInfo; refID on
    # each rank points back into them, which is the only way to know WHEN a
    # 高 applies. A possibility with no time window is not actionable.
    times = {}
    for td in root.iter(JMX_MB + "TimeDefine"):
        tid = td.get("timeId")
        if not tid:
            continue
        times[tid] = {
            "at": (td.findtext(JMX_MB + "DateTime") or ""),
            "dur": (td.findtext(JMX_MB + "Duration") or ""),
            "name": (td.findtext(JMX_MB + "Name") or ""),
        }

    areas = {}
    for item in root.iter(JMX_MB + "Item"):
        area = item.find(JMX_MB + "Area")
        if area is None:
            continue
        code = (area.findtext(JMX_MB + "Code") or "").strip()
        name = (area.findtext(JMX_MB + "Name") or "").strip()
        if not code:
            continue
        kinds, texts = [], []
        for prop in item.iter(JMX_MB + "Property"):
            raw_type = (prop.findtext(JMX_MB + "Type") or "").strip()
            m = TYPE_RE.match(raw_type)
            if not m:
                continue
            noun = m.group(1)
            info = ELEM.get(noun, {"el": "unknown", "en": noun})
            hits = []
            for rank in prop.iter(JMX_EB + "PossibilityRankOfWarning"):
                # condition="値なし" carries no text node at all
                val = (rank.text or "").strip()
                if val not in REAL_RANKS:
                    continue
                t = times.get(rank.get("refID") or "", {})
                hits.append({"rank": val, "at": t.get("at", ""),
                             "dur": t.get("dur", ""), "when": t.get("name", "")})
            if not hits:
                continue
            kinds.append({"jp": noun, "en": info["en"], "el": info["el"],
                          "unknown": info["el"] == "unknown", "hits": hits})
            txt = (prop.findtext(JMX_MB + "Text") or "").strip()
            if txt and txt not in texts:
                texts.append(txt)
        if kinds:
            # Worst rank drives the chip: 高 outranks 中.
            worst = "高" if any(h["rank"] == "高" for k in kinds for h in k["hits"]) else "中"
            areas[code] = {"name": name, "office": office, "report": report,
                           "worst": worst, "kinds": kinds, "text": " ".join(texts)}
    return report, office, areas


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "jma_early.js"
    try:
        feed = fetch(FEED)
    except Exception as e:
        print("FATAL: could not fetch %s: %s" % (FEED, e), file=sys.stderr)
        return 2

    try:
        targets = entry_urls(feed)
    except ET.ParseError as e:
        print("FATAL: feed did not parse: %s" % e, file=sys.stderr)
        return 2

    if not targets:
        # A feed with zero VPFD61 entries is not a quiet day — these are
        # issued on a fixed schedule nationwide. It means the product moved
        # or was renamed, which is exactly the class of silent retirement
        # this repo already got caught by once.
        print("FATAL: no '%s' entries in the feed — product renamed or moved?"
              % WANTED_TITLE, file=sys.stderr)
        return 3

    areas, failures, newest = {}, [], ""

    def work(t):
        office, updated, href = t
        try:
            return office, parse_telegram(fetch(href)), None
        except Exception as e:
            return office, None, "%s: %s" % (office or href, e)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for office, parsed, err in pool.map(work, targets):
            if err:
                failures.append(err)
                continue
            report, _office, got = parsed
            if report > newest:
                newest = report
            areas.update(got)

    # Partial data is worse than none if we cannot say how partial. A
    # tolerated failure count is fine; a silent one is not.
    if len(failures) > len(targets) // 3:
        print("FATAL: %d of %d telegrams failed — refusing to write a "
              "misleadingly thin file:\n  %s"
              % (len(failures), len(targets), "\n  ".join(failures[:10])),
              file=sys.stderr)
        return 4
    for f in failures:
        print("WARN: %s" % f, file=sys.stderr)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "reportDatetime": newest,
        "product": WANTED_TITLE,
        "offices": len(targets),
        "officesFailed": len(failures),
        "areas": areas,
    }
    body = json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("/* Generated by scripts/ingest_early_warning.py — do not edit by hand.\n"
                 "   警戒レベル1 早期注意情報（警報級の可能性）.\n"
                 "   A FORECAST OF POSSIBILITY, not an observation and not a warning:\n"
                 "   JMA is saying it may issue a 警報 in the stated window. */\n")
        fh.write("const JMA_EARLY = " + body + ";\n")

    hi = sum(1 for a in areas.values() if a["worst"] == "高")
    print("jma_early.js written: %d areas (%d 高, %d 中) from %d offices, "
          "%d failed, newest %s"
          % (len(areas), hi, len(areas) - hi, len(targets), len(failures), newest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
