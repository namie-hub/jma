#!/usr/bin/env node
/* Feed health check for the Japan Weather Atlas + Japan Disaster Atlas.
   Verifies every external endpoint the app depends on:
     - all 56 unique JMA forecast office files (from jma_cities.js)
     - Amedas latest_time, the map snapshot for that time, and the station table
     - typhoon target list
     - weather-map (天気図) index
     - radar nowcast (hrpns) time indexes + a live tile, Himawari IR jp index + a live tile
     - Open-Meteo JMA model pressure endpoint
     - Disaster Atlas: quake list, r8 warning files, flood forecast,
       tsunami list, volcano registry + warnings, USGS FDSN history,
       Kikikuru risk mesh index + a live tile, 防災情報XML bulletin feed,
       class10 geometry and area constants
   Exits 1 if anything is broken, so a scheduled GitHub Action fails
   and GitHub emails the repo owner. No dependencies; Node 18+.

   FRESHNESS IS PART OF "WORKING".
   On 2026-05-28 JMA retired warning/data/warning/{office} and left the files
   in place: HTTP 200, valid JSON, correct shape, frozen forever at their last
   pre-reform bulletin. This checker passed it every single run for 79 days,
   because every assertion it made was about whether the feed ANSWERED, and
   none about whether the answer was current. The Atlas rendered a May
   dense-fog advisory as "active now" through the August Chiba flood.
   So: any feed carrying its own timestamp now declares a maxAgeH, and a feed
   whose payload is older than that FAILS even while it keeps answering. The
   thresholds are deliberately generous — set from each feed's real quiet-day
   reissue rhythm, not from its busy-day rhythm — because a checker that cries
   wolf gets ignored, and an ignored checker is the same as no checker.       */
"use strict";
const fs = require("fs");
const path = require("path");

// load the registry (plain script file, no exports) safely-ish via Function
const regSrc = fs.readFileSync(path.join(__dirname, "..", "jma_cities.js"), "utf8");
const CITIES = new Function(regSrc + "; return JMA_CITIES;")();

const TIMEOUT_MS = 20000;

/* Age assertion helper. Returns a failure string, or null when fresh.
   `where` names the field so a failure message says which timestamp went
   stale rather than just "too old". */
function stale(iso, maxAgeH, where){
  if (iso === null || iso === undefined || iso === "")
    return "no timestamp in payload (" + where + ") — freshness cannot be asserted";
  const t = new Date(iso);
  if (isNaN(t)) return "unparseable " + where + ": " + String(iso).slice(0, 40);
  const ageH = (Date.now() - t.getTime()) / 3600000;
  if (ageH > maxAgeH)
    return "payload is " + (ageH > 48 ? Math.round(ageH / 24) + " days" : Math.round(ageH) + " h")
         + " old (" + where + "=" + String(iso).slice(0, 25) + ", limit " + maxAgeH
         + " h) — feed is answering but no longer being updated";
  if (ageH < -2) return where + " is " + Math.round(-ageH) + " h in the future — clock or feed fault";
  return null;
}
/* JMA tile basetimes are bare UTC stamps: 20260815021000 */
function stampToIso(s){
  if (!s || String(s).length < 14) return null;
  s = String(s);
  return s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8)+"T"+s.slice(8,10)+":"+s.slice(10,12)+":"+s.slice(12,14)+"Z";
}
async function probeOnce(name, url, validate){
  try{
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const r = await fetch(url, {signal: ctl.signal});
    clearTimeout(t);
    if (!r.ok) return {name, url, ok:false, why:"HTTP " + r.status};
    if (validate){
      const why = await validate(r);
      if (why) return {name, url, ok:false, why};
    }
    return {name, url, ok:true};
  }catch(e){
    return {name, url, ok:false, why: e.name === "AbortError" ? "timeout" : e.message};
  }
}

/* One transient fetch hiccup once produced a false failure (and would have
 * meant a false-alarm email from the scheduled run): retry twice with a
 * pause before declaring a feed broken. A feed that fails three probes
 * over ~20 s is genuinely worth waking someone up for. */
async function probe(name, url, validate){
  let last;
  for (let attempt = 0; attempt < 3; attempt++){
    if (attempt) await new Promise(res => setTimeout(res, 8000));
    last = await probeOnce(name, url, validate);
    if (last.ok) return last;
  }
  last.why += " (after 3 attempts)";
  return last;
}

(async () => {
  const checks = [];

  // one forecast file per unique office
  const offices = [...new Set(CITIES.map(c => c.office))];
  for (const o of offices){
    checks.push(probe("forecast office " + o,
      "https://www.jma.go.jp/bosai/forecast/data/forecast/" + o + ".json",
      async r => {
        const d = await r.json();
        if (!(Array.isArray(d) && d[0] && d[0].timeSeries)) return "unexpected JSON shape";
        // forecasts are reissued 3x daily; 18 h covers the widest normal gap
        return stale(d[0].reportDatetime, 18, "reportDatetime");
      }));
  }

  // Amedas chain: latest time -> map snapshot for that time
  checks.push((async () => {
    const a = await probe("amedas latest_time", "https://www.jma.go.jp/bosai/amedas/data/latest_time.txt");
    if (!a.ok) return a;
    const txt = (await (await fetch("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt")).text()).trim();
    const m = txt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return {name:"amedas latest_time", url:"", ok:false, why:"unparseable: " + txt};
    const stamp = m[1]+m[2]+m[3]+m[4]+m[5]+"00";
    // Amedas publishes every 10 min around the clock; 2 h is already generous
    const age = stale(txt, 2, "latest_time");
    if (age) return {name:"amedas latest_time", url:"", ok:false, why:age};
    return probe("amedas map snapshot",
      "https://www.jma.go.jp/bosai/amedas/data/map/" + stamp + ".json",
      async r => {
        const d = await r.json();
        if (Object.keys(d).length <= 500) return "suspiciously few stations";
        // the precipitation fields the Weather Atlas now renders must exist
        const rain = Object.values(d).filter(v => v && v.precipitation1h !== undefined).length;
        return rain > 500 ? null : "precipitation1h missing from " + (Object.keys(d).length - rain) + " stations";
      });
  })());

  checks.push(probe("amedas station table",
    "https://www.jma.go.jp/bosai/amedas/const/amedastable.json"));

  checks.push(probe("typhoon target list",
    "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json"));

  checks.push(probe("weather-map index",
    "https://www.jma.go.jp/bosai/weather_map/data/list.json",
    async r => { const d = await r.json(); return (d.near && d.near.now && d.near.now.length) ? null : "index shape changed"; }));

  // Radar (hrpns nowcast) and satellite (Himawari IR) overlay feeds:
  // validate the time index shape, then fetch one real tile from the newest
  // frame — a healthy index with dead tiles must still fail the check.
  checks.push((async () => {
    const a = await probe("radar nowcast targetTimes N1",
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json",
      async r => { const d = await r.json(); return (Array.isArray(d) && d[0] && d[0].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const d = await (await fetch("https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json")).json();
    const f = d[0]; // newest-first
    return probe("radar nowcast tile (z5 Japan)",
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/" + f.basetime + "/none/" + f.validtime + "/surf/hrpns/5/28/12.png");
  })());
  checks.push(probe("radar nowcast targetTimes N2 (forecast)",
    "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d[0] && d[0].basetime) ? null : "index shape changed"; }));
  checks.push((async () => {
    const a = await probe("himawari targetTimes jp",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_jp.json",
      async r => { const d = await r.json(); return (Array.isArray(d) && d.length && d[d.length-1].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const d = await (await fetch("https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_jp.json")).json();
    const f = d[d.length - 1]; // oldest-first
    return probe("himawari IR tile jp (z5 Japan)",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/" + f.basetime + "/jp/" + f.validtime + "/B13/TBB/5/28/12.jpg");
  })());
  checks.push((async () => {
    const a = await probe("himawari targetTimes fd",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json",
      async r => { const d = await r.json(); return (Array.isArray(d) && d.length && d[d.length-1].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const d = await (await fetch("https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json")).json();
    const f = d[d.length - 1]; // oldest-first
    return probe("himawari IR tile fd (z4 wide region)",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/" + f.basetime + "/fd/" + f.validtime + "/B13/TBB/4/13/7.jpg");
  })());

  checks.push(probe("open-meteo JMA pressure",
    "https://api.open-meteo.com/v1/jma?latitude=35&longitude=139&current=pressure_msl",
    async r => { const d = await r.json(); return (d.current && d.current.pressure_msl != null) ? null : "no pressure in response"; }));

  // ---- Japan Disaster Atlas feeds ----
  /* Quake and tsunami are genuinely event-driven: a week of silence is a
     good week, not a dead feed, so no age assertion is meaningful here and
     none is made. That is a deliberate exemption, not an oversight — the
     list is long enough that a frozen file would still show old events, so
     the guard instead is that the newest entry must not be absurdly old
     relative to the list itself changing, which only the ingest side can
     see. Shape is checked; freshness explicitly is not. */
  checks.push(probe("quake list",
    "https://www.jma.go.jp/bosai/quake/data/list.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d.length && d[0].eid) ? null : "unexpected JSON shape"; }));

  /* Warnings: EVERY office, not a Tokyo sample. The retirement that broke
     this Atlas was nationwide and simultaneous, but a partial restructure is
     just as plausible, and a sample of one cannot see it. 56 extra requests
     on a scheduled run is a rounding error against being wrong for 79 days.
     Shape is asserted per office; AGE IS NOT — see below for why.           */
  const warnAges = [];
  for (const o of offices){
    checks.push(probe("r8 warnings " + o,
      "https://www.jma.go.jp/bosai/warning/data/r8/" + o + ".json",
      async r => {
        const d = await r.json();
        if (!Array.isArray(d)) return "not an array — r8 bulletin shape changed";
        if (!d.length) return "empty bulletin array";
        const b = d[0];
        if (!b.warning || !Array.isArray(b.warning.class10Items))
          return "missing warning.class10Items — r8 shape changed";
        if (!Array.isArray(b.warning.class20Items))
          return "missing warning.class20Items — municipality detail would silently vanish";
        const newest = d.map(x => new Date(x.reportDatetime))
                        .filter(t => !isNaN(t)).sort((a, c) => c - a)[0];
        if (!newest) return "no parseable reportDatetime in any bulletin";
        warnAges.push({office:o, ageH:(Date.now() - newest.getTime()) / 3600000});
        /* Per-office bound is deliberately enormous. Measured across all 56
           offices on a quiet August afternoon: median 2.4 h, p90 20 h, and a
           genuine maximum of 55 h — Sapporo, Aichi, Miyazaki, Okinawa and
           Miyakojima had all been silent for over two days with nothing
           whatsoever wrong. A quiet prefecture in a quiet season simply has
           nothing to reissue. Any threshold tight enough to catch a dead
           office is therefore tight enough to cry wolf about a calm one, and
           a checker that cries wolf is a checker that gets filtered to a
           folder nobody reads. 7 days catches a single office genuinely
           falling off the map and nothing else; the simultaneous case — the
           one that actually happened — is caught below instead.            */
        return stale(newest.toISOString(), 24 * 7, "reportDatetime");
      }));
  }

  /* THE RETIREMENT DETECTOR.
     A per-office age limit cannot separate "quiet prefecture" from "dead
     feed" at any usable threshold. The nationwide MAXIMUM can, because the
     retirement signature is that every office freezes at the same instant.
     At least one of 56 offices is always reissuing: measured newest-in-Japan
     was 5 minutes old, and it is structurally hard for it to exceed an hour
     when 56 independent offices publish on their own schedules. A 6 h bound
     is roughly a 65x margin over observed behaviour and still catches a
     simultaneous retirement inside a single scheduled run — which is exactly
     the 79-day window this Atlas spent rendering a May advisory as current. */
  checks.push((async () => {
    const name = "warnings: newest bulletin nationwide (retirement detector)";
    const url = "https://www.jma.go.jp/bosai/warning/data/r8/";
    // runs after the per-office probes above have populated warnAges
    for (let i = 0; i < 60 && warnAges.length < offices.length; i++)
      await new Promise(res => setTimeout(res, 1000));
    if (!warnAges.length)
      return {name, url, ok:false, why:"no office returned a usable timestamp"};
    const sorted = [...warnAges].sort((a, b) => a.ageH - b.ageH);
    const newest = sorted[0];
    console.log("  note: newest warning bulletin in Japan is " + newest.ageH.toFixed(2)
      + " h old (" + newest.office + "); oldest office " + sorted[sorted.length-1].ageH.toFixed(1)
      + " h (" + sorted[sorted.length-1].office + "), " + warnAges.length + " offices sampled");
    if (newest.ageH > 6)
      return {name, url, ok:false, why:"NOT ONE of " + warnAges.length
        + " offices has reissued in " + newest.ageH.toFixed(1)
        + " h — this is the signature of a feed retirement, not of quiet weather."
        + " Check whether JMA has moved the warning path again."};
    return {name, url, ok:true};
  })());

  /* Canary for the exact failure that started this. The retired pre-reform
     path still returns HTTP 200 with valid JSON, so its mere existence is not
     the signal — its FROZEN timestamp is. If this ever starts moving again,
     JMA has reversed course and the r8 migration needs revisiting; if it
     404s, the corpse has finally been buried and this check can go. Either
     way it is reported, and neither is treated as a failure. */
  checks.push((async () => {
    const name = "retired pre-reform warning path (informational)";
    const url = "https://www.jma.go.jp/bosai/warning/data/warning/130000.json";
    try{
      const r = await fetch(url);
      if (!r.ok){ console.log("  note: " + name + " now returns HTTP " + r.status + " — expected, it is retired"); return {name, url, ok:true}; }
      const d = await r.json();
      const age = stale(d.reportDatetime, 30, "reportDatetime");
      console.log("  note: " + name + " still answers; " + (age ? "frozen as expected (" + age.slice(0, 60) + "…)" : "IT IS MOVING AGAIN — revisit the r8 migration"));
      return {name, url, ok:true};
    }catch(e){ return {name, url, ok:true}; }
  })());

  checks.push(probe("flood forecast (指定河川洪水予報)",
    "https://www.jma.go.jp/bosai/flood/data/r8/flood_xml.json",
    async r => {
      const d = await r.json();
      if (!Array.isArray(d)) return "not an array — flood feed shape changed";
      /* An empty list is the normal state: no river is in flood most days.
         Emptiness is therefore never a failure, and because an empty file
         carries no timestamp, its age genuinely cannot be asserted from the
         payload. Saying so is better than inventing a check that passes for
         the wrong reason. */
      if (!d.length) return null;
      const newest = d.map(x => new Date(x.reportDatetime))
                      .filter(t => !isNaN(t)).sort((a, c) => c - a)[0];
      if (!d[0].item || !d[0].item.code) return "flood item missing code";
      return stale(newest ? newest.toISOString() : null, 36, "reportDatetime");
    }));

  /* 防災情報XML — carries 線状降水帯 and 記録的短時間大雨情報, the earliest
     flood signals JMA emits. High-frequency feed: minutes, not hours. */
  checks.push(probe("防災情報XML extra feed (rain bulletins)",
    "https://www.data.jma.go.jp/developer/xml/feed/extra.xml",
    async r => {
      const t = await r.text();
      if (!/<feed[\s>]/.test(t)) return "not an Atom feed";
      const m = t.match(/<updated>([^<]+)<\/updated>/);
      if (!m) return "no feed <updated> element";
      if (!/<entry>/.test(t)) return "feed carries no entries at all";
      return stale(m[1], 3, "feed updated");
    }));

  /* Kikikuru risk mesh: index shape, freshness, and one real tile. A healthy
     index over dead tiles is exactly the failure mode the radar check already
     guards against, one host over. */
  checks.push((async () => {
    const idx = "https://www.jma.go.jp/bosai/jmatile/data/risk/targetTimes.json";
    const a = await probe("kikikuru risk targetTimes", idx, async r => {
      const d = await r.json();
      if (!(Array.isArray(d) && d.length && d[0].basetime)) return "index shape changed";
      const need = ["land", "inund", "flood"];
      const have = d[0].elements || [];
      const miss = need.filter(n => !have.includes(n));
      if (miss.length) return "risk elements missing: " + miss.join(", ");
      return stale(stampToIso(d[0].basetime), 2, "basetime");
    });
    if (!a.ok) return a;
    const d = await (await fetch(idx)).json();
    const f = d.filter(x => x.validtime === x.basetime)[0] || d[0];
    return probe("kikikuru land tile (z8 over Chiba)",
      "https://www.jma.go.jp/bosai/jmatile/data/risk/" + f.basetime + "/" + (f.member || "immed0")
      + "/" + f.validtime + "/surf/land/8/227/100.png");
  })());

  /* Geometry and area constants: the warn view degrades to chips without the
     first and to prefecture-wide scoping without the second, both of which
     are handled gracefully in the page — but silently, so they are checked
     here instead. */
  checks.push(probe("class10 geometry (sub-region outlines)",
    "https://www.jma.go.jp/bosai/common/const/geojson/class10s.json",
    async r => {
      const d = await r.json();
      if (!(d && Array.isArray(d.features) && d.features.length > 100)) return "unexpected GeoJSON shape";
      return d.features.some(f => f.properties && f.properties.code === "120010")
        ? null : "class10 code 120010 absent — area codes may have been renumbered";
    }));

  checks.push(probe("area constants (class20 parent chain)",
    "https://www.jma.go.jp/bosai/common/const/area.json",
    async r => {
      const d = await r.json();
      if (!(d.class20s && d.class15s && d.class10s)) return "area constant shape changed";
      const chiba = d.class20s["1210000"];
      if (!chiba) return "class20 1210000 (千葉市) absent — municipality codes renumbered";
      const c15 = d.class15s[chiba.parent];
      if (!c15 || !c15.parent) return "class20 -> class15 -> class10 parent chain broken";
      return null;
    }));

  checks.push(probe("tsunami list",
    "https://www.jma.go.jp/bosai/tsunami/data/list.json",
    async r => { const d = await r.json(); return Array.isArray(d) ? null : "unexpected JSON shape"; }));

  checks.push(probe("volcano registry",
    "https://www.jma.go.jp/bosai/volcano/const/volcano_list.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d.length > 30 && d[0].latlon) ? null : "suspiciously few volcanoes"; }));

  checks.push(probe("volcano warnings",
    "https://www.jma.go.jp/bosai/volcano/data/warning.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d[0] && d[0].volcanoInfos) ? null : "unexpected JSON shape"; }));

  checks.push(probe("USGS FDSN (history heatmap)",
    "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-01-01&minlatitude=24&maxlatitude=46&minlongitude=122&maxlongitude=148&minmagnitude=6&limit=10",
    async r => { const d = await r.json(); return (d.features && Array.isArray(d.features)) ? null : "unexpected GeoJSON shape"; }));

  const results = await Promise.all(checks);
  const bad = results.filter(x => !x.ok);
  console.log(`checked ${results.length} endpoints — ${results.length - bad.length} ok, ${bad.length} failing`);
  for (const b of bad) console.log(`  FAIL ${b.name}: ${b.why}\n       ${b.url}`);
  if (bad.length){
    console.log("\nOne or more data feeds the Japan Weather/Disaster Atlas depends on are broken.");
    console.log("Most likely a JMA restructure — see README 'Known limits'.");
    process.exit(1);
  }
  console.log("all feeds healthy");
})();
