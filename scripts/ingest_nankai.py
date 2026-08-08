#!/usr/bin/env python3
"""
ingest_nankai.py — latch 南海トラフ地震臨時情報 status into jma_nankai.js

Reads the JMA developer XML long feed (eqvol_l.xml, ~7-day window), finds
南海トラフ telegrams by their Atom entry <title> (which mirrors the telegram
Control/Title), extracts the advisory keyword, and merges with the previously
latched state so the status survives the telegram aging out of the feed
window. 巨大地震注意 runs ~1 week and 警戒 longer; the feed only holds 7 days.

Usage:  python3 scripts/ingest_nankai.py jma_nankai.js
Exit:   0 on success (file written), non-zero on feed failure (so the
        workflow failure email fires — the established reactive model).

Keyword model (配信資料に関する仕様 No.40601):
  VYSE50 南海トラフ地震臨時情報       → 調査中 / 巨大地震警戒 / 巨大地震注意 / 調査終了
  VYSE51/52 南海トラフ地震関連解説情報 → recorded as lastKaisetsu, never a status

NOTE: keyword extraction is built from the JMA spec, not an observed VYSE50
(none has been issued inside a feed window we could capture). The first real
advisory is a verification event. Extraction is deliberately forgiving:
InfoSerial/Name first, then a priority-ordered regex over Head, then the
whole telegram; if a VYSE50 exists but no keyword matches, status becomes
"unknown-advisory" — surfaced, never silently discarded.

The InfoSerial pattern is verified against a live VYSE52 telegram (8 Aug
2026): the element carries a codeType attribute, so the pattern must
tolerate attributes. An earlier version matched a bare opening tag only and
therefore never fired, silently demoting every extraction to the Head
fallback. tests/test_ingest_nankai.py pins this.
"""
import json, re, sys, urllib.request
from datetime import datetime, timezone

FEED = "https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml"
UA = {"User-Agent": "namie-hub-jma-atlas nankai monitor (github.com/namie-hub/jma)"}

TITLE_RINJI    = "南海トラフ地震臨時情報"
TITLE_KAISETSU = "南海トラフ地震関連解説情報"

# priority order matters: a 警戒 headline may also mention 調査
KEYWORDS = ["巨大地震警戒", "巨大地震注意", "調査終了", "調査中"]
END_KEYWORDS = {"調査終了"}          # keywords that clear the latch

def fetch(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

def parse_entries(feed_xml):
    """Return [(title, url, updated_iso)] for every feed entry."""
    out = []
    for m in re.finditer(r"<entry>(.*?)</entry>", feed_xml, re.S):
        e = m.group(1)
        t = re.search(r"<title>([^<]*)</title>", e)
        u = re.search(r'href="([^"]+)"', e)
        d = re.search(r"<updated>([^<]*)</updated>", e)
        if t and u and d:
            out.append((t.group(1).strip(), u.group(1), d.group(1)))
    return out

def extract_keyword(telegram_xml):
    """InfoSerial/Name first, then priority regex over Head, then whole body."""
    m = re.search(r"<InfoSerial\b[^>]*>.*?<Name>([^<]+)</Name>", telegram_xml, re.S)
    if m:
        name = m.group(1).strip()
        for k in KEYWORDS:
            if k in name:
                return k
    head = re.search(r"<Head>(.*?)</Head>", telegram_xml, re.S)
    for scope in ([head.group(1)] if head else []) + [telegram_xml]:
        for k in KEYWORDS:
            if k in scope:
                return k
    return None

def extract_report_time(telegram_xml):
    m = re.search(r"<ReportDateTime>([^<]+)</ReportDateTime>", telegram_xml)
    return m.group(1).strip() if m else None

def extract_headline(telegram_xml):
    m = re.search(r"<Headline>.*?<Text>([^<]*)</Text>", telegram_xml, re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None

def load_prev(path):
    try:
        txt = open(path, encoding="utf-8").read()
        m = re.search(r"const JMA_NANKAI\s*=\s*(\{.*\});", txt, re.S)
        return json.loads(m.group(1)) if m else None
    except (OSError, json.JSONDecodeError):
        return None

def build_state(entries, prev, fetch_fn=fetch):
    """Pure latch logic — separated from I/O so fixtures can drive it."""
    rinji = sorted((e for e in entries if e[0] == TITLE_RINJI),
                   key=lambda e: e[2], reverse=True)
    kaisetsu = sorted((e for e in entries if e[0].startswith(TITLE_KAISETSU)),
                      key=lambda e: e[2], reverse=True)

    state = {
        "status": "none", "keyword": None, "headline": None,
        "reportTime": None, "telegramUrl": None,
        "latchedSince": None,       # first workflow run that saw this advisory
        "lastKaisetsu": None,
    }
    if prev:
        for k in ("status", "keyword", "headline", "reportTime",
                  "telegramUrl", "latchedSince", "lastKaisetsu"):
            state[k] = prev.get(k, state[k])

    if rinji:
        # newest 臨時情報 inside the window is authoritative — overrides latch
        title, url, updated = rinji[0]
        xml = fetch_fn(url)
        kw = extract_keyword(xml)
        rt = extract_report_time(xml) or updated
        if kw in END_KEYWORDS:
            state.update(status="none", keyword=kw, headline=extract_headline(xml),
                         reportTime=rt, telegramUrl=url, latchedSince=None)
        else:
            new_kw = kw if kw else "unknown-advisory"
            if state["status"] != new_kw or state["telegramUrl"] != url:
                state["latchedSince"] = _now_jst()
            state.update(status=new_kw, keyword=kw, headline=extract_headline(xml),
                         reportTime=rt, telegramUrl=url)
    # else: no 臨時情報 in the 7-day window → keep the latch untouched.
    # An advisory in force keeps displaying; 平常 stays 平常.

    if kaisetsu:
        title, url, updated = kaisetsu[0]
        xml = fetch_fn(url)
        state["lastKaisetsu"] = {
            "title": title,
            "reportTime": extract_report_time(xml) or updated,
            "headline": extract_headline(xml),
            "url": url,
        }
    return state

def _now_jst():
    # JST without external deps: UTC+9, fixed offset, no DST
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(hours=9)).strftime(
        "%Y-%m-%dT%H:%M:%S+09:00")

def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "jma_nankai.js"
    prev = load_prev(out_path)
    feed = fetch(FEED)                      # raises on failure → nonzero exit
    entries = parse_entries(feed)
    if not entries:
        print("FATAL: feed parsed to zero entries — format change?", file=sys.stderr)
        sys.exit(1)
    state = build_state(entries, prev)
    state["generated"] = _now_jst()
    state["source"] = ("JMA 防災情報XML developer feed (eqvol_l.xml) — "
                       "latched by GitHub Actions; status persists past the "
                       "7-day feed window until an ending telegram is seen")
    js = ("/* Generated by scripts/ingest_nankai.py — do not edit by hand. */\n"
          "const JMA_NANKAI = "
          + json.dumps(state, ensure_ascii=False, indent=1) + ";\n")
    open(out_path, "w", encoding="utf-8").write(js)
    nankai_hits = sum(1 for e in entries if "南海トラフ" in e[0])
    print(f"wrote {out_path}: status={state['status']} "
          f"({nankai_hits} Nankai entries in {len(entries)}-entry window)")

if __name__ == "__main__":
    main()
