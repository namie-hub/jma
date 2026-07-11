#!/usr/bin/env python3
"""Generate jma_phenology.js from JMA's phenological observation pages.

Records, not forecasts: observed dates of sakura first bloom (開花) and
full bloom (満開) back to 1953, and maple red leaves (かえで紅葉) / ginkgo
yellow leaves (いちょう黄葉) for the seasons JMA publishes as HTML (the
two most recent; older foliage records exist only as PDFs). Climatological
normals (平年値) are included for every phenomenon.

Sources (data.jma.go.jp — no CORS, hence this static ingest):
  sakura_kaika.html / sakura_mankai.html      current-year tables + normals
  sakura003_00..07.html / sakura004_00..07    history 1953–present (<pre> text)
  phn_014.html (kaede) / phn_012.html (icho)  last two seasons + 平年差

Station coordinates are resolved by matching JMA station names against
amedastable.json (preferring pressure-capable staffed offices). Unresolved
stations are reported and skipped, never guessed.

Usage: python3 scripts/ingest_phenology.py [output_path]
"""
import json, re, sys, unicodedata, urllib.request
from datetime import datetime, timezone

SAKURA = "https://www.data.jma.go.jp/sakura/data/"
AMEDAS = "https://www.jma.go.jp/bosai/amedas/const/amedastable.json"

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "japan-weather-atlas-ingest"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")

def clean(s):
    return unicodedata.normalize("NFKC", s).replace("*", "").strip()

def mmdd(mon, day):
    return f"{int(mon):02d}{int(day):02d}"

# ---------- station coordinates via amedastable ----------
def build_resolver():
    tbl = json.loads(fetch(AMEDAS))
    byname = {}
    for sid, st in tbl.items():
        name = st.get("kjName", "")
        lat = st["lat"][0] + st["lat"][1]/60
        lon = st["lon"][0] + st["lon"][1]/60
        staffed = "pressure" in (st.get("elems") and st or {"elems": ""}).get("elems", "") \
                  or (st.get("type") == "A" and False)
        # prefer staffed offices (they host the specimen trees); JMA marks
        # capability in 'elems' string — offices observe pressure ('1' at pos 4?)
        score = 1 if st.get("type") in ("C", "D") else 0
        cur = byname.get(name)
        if cur is None or score > cur[2]:
            byname[name] = (round(lat, 3), round(lon, 3), score)
    return {k: (v[0], v[1]) for k, v in byname.items()}

# ---------- current-year sakura tables (real HTML) ----------
def parse_sakura_current(html):
    """rows: 地点名, 観測日, 平年差, 平年日, 昨年差, 昨年日, species"""
    out = {}
    rows = re.split(r'<tr[^>]*>', html, flags=re.I)[1:]
    for r in rows:
        cells = [re.sub(r'<[^>]+>', '', c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, re.S | re.I)]
        cells = [clean(c) for c in cells]
        if len(cells) < 4 or cells[0] in ("地点名", ""):
            continue
        st = cells[0]
        m_obs = re.match(r'(\d+)月\s*(\d+)日', cells[1] or "")
        m_nor = re.match(r'(\d+)月\s*(\d+)日', cells[3] or "")
        sp = cells[6] if len(cells) > 6 else ""
        out[st] = {"obs": mmdd(*m_obs.groups()) if m_obs else None,
                   "normal": mmdd(*m_nor.groups()) if m_nor else None,
                   "species": sp}
    return out

# ---------- historical sakura pages (<pre> fixed-width) ----------
def parse_sakura_history(html):
    """returns (years[list of int], {station: {year: 'MMDD'}}, {station:'MMDD' normals})"""
    pre = re.search(r'<pre>(.*?)</pre>', html, re.S | re.I)
    if not pre:
        return [], {}, {}
    lines = pre.group(1).splitlines()
    years = None
    data, normals = {}, {}
    for ln in lines:
        if years is None and re.search(r'\b(19|20)\d\d\b', ln):
            years = [int(y) for y in re.findall(r'\b((?:19|20)\d\d)\b', ln)]
            continue
        if years is None:
            continue
        m = re.match(r'^(\S+)\s*(\*?)\s+(.*)$', unicodedata.normalize("NFKC", ln))
        if not m:
            continue
        st = clean(m.group(1))
        rest = m.group(3)
        # tokens: pairs "M D" or single "-" per year, then 平年値 pair or -, then species
        toks = rest.split()
        vals, i = [], 0
        while i < len(toks) and len(vals) < len(years) + 1:   # +1 for the normals column
            if toks[i] == "-":
                vals.append(None); i += 1
            elif re.fullmatch(r'\d{1,2}', toks[i]) and i + 1 < len(toks) and re.fullmatch(r'\d{1,2}', toks[i+1]):
                vals.append(mmdd(toks[i], toks[i+1])); i += 2
            else:
                break
        if not st or not vals:
            continue
        yearvals, normal = vals[:len(years)], (vals[len(years)] if len(vals) > len(years) else None)
        d = data.setdefault(st, {})
        for y, v in zip(years, yearvals):
            if v: d[y] = v
        if normal: normals[st] = normal
    return years or [], data, normals

# ---------- foliage pages (vintage HTML, unclosed tags) ----------
def parse_foliage(html):
    """title has (YYYY年-YYYY年); rows: station, obsA, 平年差A, 昨年差A, obsB, 平年差B, 昨年差B"""
    t = re.search(r'<h1>.*?\((\d{4})年-(\d{4})年\)', html, re.S)
    y1, y2 = int(t.group(1)), int(t.group(2))
    rows = re.split(r'<TR[^>]*>', html, flags=re.I)[1:]
    out = {y1: {}, y2: {}}
    normals = {}
    for r in rows:
        cells = re.findall(r'<T[DH][^>]*>\s*(.*?)\s*(?=<T[DHR]|</T|$)', r, re.S | re.I)
        cells = [clean(re.sub(r'<[^>]+>', '', c)) for c in cells]
        if len(cells) < 7 or cells[0] in ("地点名", ""):
            continue
        st = cells[0]
        for year, obs_i, diff_i in ((y1, 1, 2), (y2, 4, 5)):
            m = re.match(r'(\d+)月\s*(\d+)日', cells[obs_i] or "")
            if not m:
                continue
            val = mmdd(*m.groups())
            out[year][st] = val
            dm = re.match(r'([+-]?\d+)', cells[diff_i] or "")
            if dm and st not in normals:
                # normal = observed - diff  (diff = observed minus normal, in days)
                from datetime import date, timedelta
                d = date(year, int(val[:2]), int(val[2:])) - timedelta(days=int(dm.group(1)))
                normals[st] = f"{d.month:02d}{d.day:02d}"
    return {str(y1): out[y1], str(y2): out[y2]}, normals

def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "jma_phenology.js"
    coords = build_resolver()
    print(f"amedas name resolver: {len(coords)} station names")

    phen = {}
    this_year = str(datetime.now(timezone.utc).year)

    for key, cur_page, hist_prefix, label in (
        ("sakura_kaika",  "sakura_kaika.html",  "sakura003", "Sakura first bloom 桜開花"),
        ("sakura_mankai", "sakura_mankai.html", "sakura004", "Sakura full bloom 桜満開")):
        cur = parse_sakura_current(fetch(SAKURA + cur_page))
        years_map, normals, species = {}, {}, {}
        for st, v in cur.items():
            if v["obs"]: years_map.setdefault(this_year, {})[st] = v["obs"]
            if v["normal"]: normals[st] = v["normal"]
            if v["species"]: species[st] = v["species"]
        n_hist_pages = 0
        for i in range(0, 12):
            try:
                html = fetch(f"{SAKURA}{hist_prefix}_{i:02d}.html")
            except Exception:
                break
            yrs, data, nrm = parse_sakura_history(html)
            if not yrs:
                break
            n_hist_pages += 1
            for st, ymap in data.items():
                for y, v in ymap.items():
                    years_map.setdefault(str(y), {})[st] = v
            for st, v in nrm.items():
                normals.setdefault(st, v)
        phen[key] = {"label": label, "normal": normals, "years": years_map, "species": species}
        yr_keys = sorted(int(y) for y in years_map)
        print(f"{key}: {n_hist_pages} history pages, years {yr_keys[0]}–{yr_keys[-1]}, "
              f"{len(normals)} station normals")

    for key, page, label in (("kaede", "phn_014.html", "Maple red leaves かえで紅葉"),
                             ("icho",  "phn_012.html", "Ginkgo yellow leaves いちょう黄葉")):
        years_map, normals = parse_foliage(fetch(SAKURA + page))
        phen[key] = {"label": label, "normal": normals, "years": years_map, "species": {}}
        print(f"{key}: seasons {sorted(years_map)} · {len(normals)} station normals "
              f"(older foliage records are PDF-only at JMA)")

    # station coordinate table: every station name used anywhere, resolved
    used = set()
    for p in phen.values():
        used |= set(p["normal"])
        for ymap in p["years"].values():
            used |= set(ymap)
    stations, missing = {}, []
    for st in sorted(used):
        hit = st if st in coords else (st.rstrip("島") if st.rstrip("島") in coords
              else (st + "島" if st + "島" in coords else None))
        if hit:
            stations[st] = list(coords[hit])
        else:
            missing.append(st)
    if missing:
        print(f"WARNING unresolved station names (skipped, {len(missing)}): {'、'.join(missing)}")

    payload = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
               "source": "JMA phenological observations (data.jma.go.jp/sakura/data/)",
               "stations": stations, "phen": phen}
    js = ("/* Generated by scripts/ingest_phenology.py — do not edit by hand.\n"
          "   JMA phenology: sakura bloom 1953–present; foliage recent seasons.  */\n"
          "const JMA_PHENOLOGY = " + json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + ";\n")
    open(out_path, "w", encoding="utf-8").write(js)
    print(f"wrote {out_path}: {len(stations)} stations, {len(js)/1e3:.0f} KB")

if __name__ == "__main__":
    main()
