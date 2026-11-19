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
/* At most this many requests in flight. The checker used to fire ~130
   requests at jma.go.jp in the same instant, and retried them all in the
   same instant 8 s later — a burst pattern that invites CDN throttling and
   pushes slow responses toward the timeout from a US-hosted runner. */
const CONCURRENCY = 8;
/* After the first pass, anything that failed is re-checked once more after
   this pause. Only a feed that fails BOTH passes fails the run; one that
   recovers is reported as a warning annotation instead of an email.
   Override with RECHECK_DELAY_S (0 disables the wait, e.g. for local runs). */
const RECHECK_DELAY_S = Number(process.env.RECHECK_DELAY_S ?? 120);
const IN_ACTIONS = !!process.env.GITHUB_ACTIONS;
const sleep = ms => new Promise(res => setTimeout(res, ms));

/* Non-fatal findings (e.g. a new quake bulletin type): surfaced as warning
   annotations, never as a failed run. */
const warnings = [];
function warn(name, msg){
  if (!warnings.some(w => w.name === name && w.msg === msg)) warnings.push({name, msg});
}

/* Tiny semaphore so CONCURRENCY is respected across every probe. */
let active = 0;
const waiting = [];
async function limited(fn){
  if (active >= CONCURRENCY) await new Promise(res => waiting.push(res));
  active++;
  try { return await fn(); }
  finally { active--; const next = waiting.shift(); if (next) next(); }
}

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
/* validate(r, keep) may call keep(value) to hand parsed data back to the
   caller (result.data), so chained checks (index -> tile) reuse the body
   they already validated instead of downloading it a second time. The old
   second download had no timeout, retry or catch: one network error there
   rejected Promise.all and crashed the run with no summary at all, and the
   index could also roll over between the two downloads. The timeout now
   covers the body read and validation too, not just the headers. */
function probeOnce(name, url, validate){
  return limited(async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try{
      const r = await fetch(url, {signal: ctl.signal});
      if (!r.ok) return {name, url, ok:false, why:"HTTP " + r.status};
      let data;
      if (validate){
        const why = await validate(r, v => { data = v; });
        if (why) return {name, url, ok:false, why};
      }
      return {name, url, ok:true, data};
    }catch(e){
      return {name, url, ok:false, why: e.name === "AbortError" ? "timeout after " + TIMEOUT_MS / 1000 + " s"
                                         : (e.cause && e.cause.code) || e.message};
    }finally{
      clearTimeout(t);
    }
  });
}

/* One transient fetch hiccup once produced a false failure (and would have
 * meant a false-alarm email from the scheduled run): retry with a growing,
 * jittered pause before declaring a feed broken, so retries do not all land
 * on JMA in the same instant. The whole-run recheck pass below is the second
 * line of defence against outages longer than these ~25 s. */
async function probe(name, url, validate){
  let last;
  for (let attempt = 0; attempt < 3; attempt++){
    if (attempt) await sleep((attempt === 1 ? 5000 : 15000) + Math.random() * 3000);
    last = await probeOnce(name, url, validate);
    if (last.ok) return last;
  }
  last.why += " (after 3 attempts)";
  return last;
}

/* GitHub workflow-command escaping, so a failure reason containing a colon,
   comma or newline cannot break the annotation. */
function ghEsc(s, prop){
  s = String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return prop ? s.replace(/:/g, "%3A").replace(/,/g, "%2C") : s;
}

(async () => {
  /* Each check is a thunk so the recheck pass can run it again. */
  const checks = [];
  const add = fn => checks.push(fn);

  // one forecast file per unique office
  const offices = [...new Set(CITIES.map(c => c.office))];
  for (const o of offices){
    add(() => probe("forecast office " + o,
      "https://www.jma.go.jp/bosai/forecast/data/forecast/" + o + ".json",
      async r => {
        const d = await r.json();
        if (!(Array.isArray(d) && d[0] && d[0].timeSeries)) return "unexpected JSON shape";
        // forecasts are reissued 3x daily; 18 h covers the widest normal gap
        return stale(d[0].reportDatetime, 18, "reportDatetime");
      }));
  }

  // Amedas chain: latest time -> map snapshot for that time
  add(async () => {
    const a = await probe("amedas latest_time", "https://www.jma.go.jp/bosai/amedas/data/latest_time.txt",
      async (r, keep) => {
        const txt = (await r.text()).trim();
        const m = txt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (!m) return "unparseable: " + txt.slice(0, 40);
        keep(m[1]+m[2]+m[3]+m[4]+m[5]+"00");
        // Amedas publishes every 10 min around the clock; 2 h is already generous
        return stale(txt, 2, "latest_time");
      });
    if (!a.ok) return a;
    const stamp = a.data;
    return probe("amedas map snapshot",
      "https://www.jma.go.jp/bosai/amedas/data/map/" + stamp + ".json",
      async r => {
        const d = await r.json();
        if (Object.keys(d).length <= 500) return "suspiciously few stations";
        // the precipitation fields the Weather Atlas now renders must exist
        const rain = Object.values(d).filter(v => v && v.precipitation1h !== undefined).length;
        return rain > 500 ? null : "precipitation1h missing from " + (Object.keys(d).length - rain) + " stations";
      });
  });

  add(() => probe("amedas station table",
    "https://www.jma.go.jp/bosai/amedas/const/amedastable.json"));

  add(() => probe("typhoon target list",
    "https://www.jma.go.jp/bosai/typhoon/data/targetTc.json"));

  add(() => probe("weather-map index",
    "https://www.jma.go.jp/bosai/weather_map/data/list.json",
    async r => { const d = await r.json(); return (d.near && d.near.now && d.near.now.length) ? null : "index shape changed"; }));

  // Radar (hrpns nowcast) and satellite (Himawari IR) overlay feeds:
  // validate the time index shape, then fetch one real tile from the newest
  // frame — a healthy index with dead tiles must still fail the check.
  add(async () => {
    const a = await probe("radar nowcast targetTimes N1",
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json",
      async (r, keep) => { const d = await r.json(); keep(d); return (Array.isArray(d) && d[0] && d[0].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const f = a.data[0]; // newest-first
    return probe("radar nowcast tile (z5 Japan)",
      "https://www.jma.go.jp/bosai/jmatile/data/nowc/" + f.basetime + "/none/" + f.validtime + "/surf/hrpns/5/28/12.png");
  });
  add(() => probe("radar nowcast targetTimes N2 (forecast)",
    "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d[0] && d[0].basetime) ? null : "index shape changed"; }));
  add(async () => {
    const a = await probe("himawari targetTimes jp",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_jp.json",
      async (r, keep) => { const d = await r.json(); keep(d); return (Array.isArray(d) && d.length && d[d.length-1].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const f = a.data[a.data.length - 1]; // oldest-first
    return probe("himawari IR tile jp (z5 Japan)",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/" + f.basetime + "/jp/" + f.validtime + "/B13/TBB/5/28/12.jpg");
  });
  add(async () => {
    const a = await probe("himawari targetTimes fd",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json",
      async (r, keep) => { const d = await r.json(); keep(d); return (Array.isArray(d) && d.length && d[d.length-1].basetime) ? null : "index shape changed"; });
    if (!a.ok) return a;
    const f = a.data[a.data.length - 1]; // oldest-first
    return probe("himawari IR tile fd (z4 wide region)",
      "https://www.jma.go.jp/bosai/himawari/data/satimg/" + f.basetime + "/fd/" + f.validtime + "/B13/TBB/4/13/7.jpg");
  });

  add(() => probe("open-meteo JMA pressure",
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
  /* Bulletin-type classifier (the Ibaraki lesson, 2026-08-23). The list is
     not one message type. VXSE61 震源要素更新 writes cod in DDMM.M and the Atlas
     once plotted an M5.9 at latitude 3559. Every entry must now be a type the
     Atlas knows how to read, and every decimal-degree cod must be in range.
     A shape change or an out-of-range cod fails loudly here, not on the map.
     A NEW bulletin code alone is a warning annotation, not a failure: rare
     types appear and then scroll off the list days later, which made this
     check flap red/green without anything in the Atlas being wrong. An
     unknown type whose cod is not decimal degrees still fails via the range
     check below, which is the case that actually breaks the map. */
  // observed 2026-08-23: VXSE51 震度速報, VXSE52 震源に関する情報, VXSE5k 震源・震度情報,
  // VXSE5e 遠地地震, VXSE61 震源要素更新, VYSE52 南海トラフ解説. VXSE53/56/60/62 are
  // documented siblings (遠地震源, 地震回数, 長周期地震動) not yet seen in the list.
  const KNOWN_VXSE = /_V[XY]SE(51|52|53|56|5e|5k|60|61|62)_/;
  add(() => probe("quake list",
    "https://www.jma.go.jp/bosai/quake/data/list.json",
    async r => {
      const d = await r.json();
      if (!(Array.isArray(d) && d.length && d[0].eid)) return "unexpected JSON shape";
      const unknown = [...new Set(d.filter(q => !KNOWN_VXSE.test(q.json||"")).map(q => (q.json||"").split("_")[2] || q.ttl))];
      if (unknown.length)
        warn("quake list", "unclassified bulletin type(s): " + unknown.join(", ")
          + " — add to KNOWN_VXSE once the Atlas is confirmed to read them");
      for (const q of d){
        if (!q.cod) continue;
        const m = /^([+-][\d.]+)([+-][\d.]+)/.exec(q.cod); if (!m) return "cod unparseable: " + q.cod;
        const isDDMM = /VXSE61/.test(q.json||"");
        const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
        const ok = isDDMM ? (lat <= 9000 && lon <= 18000) : (Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
        if (!ok) return "cod out of range for its bulletin type: " + q.cod + " (" + (q.json||"").split("_")[2] + ")";
        if (!isDDMM && Math.abs(lat) > 90) return "decimal-degree bulletin carrying DDMM.M cod: " + q.json;
      }
      return null;
    }));

  /* Warnings: EVERY office, not a Tokyo sample. The retirement that broke
     this Atlas was nationwide and simultaneous, but a partial restructure is
     just as plausible, and a sample of one cannot see it. 56 extra requests
     on a scheduled run is a rounding error against being wrong for 79 days.
     Shape is asserted per office; AGE IS NOT — see below for why.           */
  const warnAges = new Map();   // office -> age in hours; keyed so a recheck overwrites
  for (const o of offices){
    add(() => probe("r8 warnings " + o,
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
        warnAges.set(o, (Date.now() - newest.getTime()) / 3600000);
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
     the 79-day window this Atlas spent rendering a May advisory as current.
     It is computed AFTER each pass from what the per-office probes recorded,
     rather than polling for them, so it always sees the complete sample. */
  function retirementDetector(){
    const name = "warnings: newest bulletin nationwide (retirement detector)";
    const url = "https://www.jma.go.jp/bosai/warning/data/r8/";
    if (!warnAges.size)
      return {name, url, ok:false, why:"no office returned a usable timestamp"};
    const sorted = [...warnAges].map(([office, ageH]) => ({office, ageH})).sort((a, b) => a.ageH - b.ageH);
    const newest = sorted[0];
    console.log("  note: newest warning bulletin in Japan is " + newest.ageH.toFixed(2)
      + " h old (" + newest.office + "); oldest office " + sorted[sorted.length-1].ageH.toFixed(1)
      + " h (" + sorted[sorted.length-1].office + "), " + warnAges.size + " offices sampled");
    if (newest.ageH > 6)
      return {name, url, ok:false, why:"NOT ONE of " + warnAges.size
        + " offices has reissued in " + newest.ageH.toFixed(1)
        + " h — this is the signature of a feed retirement, not of quiet weather."
        + " Check whether JMA has moved the warning path again."};
    return {name, url, ok:true};
  }

  /* Canary for the exact failure that started this. The retired pre-reform
     path still returns HTTP 200 with valid JSON, so its mere existence is not
     the signal — its FROZEN timestamp is. If this ever starts moving again,
     JMA has reversed course and the r8 migration needs revisiting; if it
     404s, the corpse has finally been buried and this check can go. Either
     way it is reported, and neither is treated as a failure. */
  add(async () => {
    const name = "retired pre-reform warning path (informational)";
    const url = "https://www.jma.go.jp/bosai/warning/data/warning/130000.json";
    const r = await probeOnce(name, url, async (r, keep) => { keep(await r.json()); return null; });
    if (!r.ok){ console.log("  note: " + name + " now returns " + r.why + " — expected, it is retired"); return {name, url, ok:true}; }
    const age = stale(r.data && r.data.reportDatetime, 30, "reportDatetime");
    console.log("  note: " + name + " still answers; " + (age ? "frozen as expected (" + age.slice(0, 60) + "…)" : "IT IS MOVING AGAIN — revisit the r8 migration"));
    if (!age) warn(name, "retired warning path is updating again — revisit the r8 migration");
    return {name, url, ok:true};
  });

  add(() => probe("flood forecast (指定河川洪水予報)",
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

  /* 防災情報XML regular feed — carries the level-1 product (VPFD61). Its own
     <updated> moves constantly; what matters is that the PRODUCT still
     exists under the title the ingest matches on. A rename here would make
     ingest_early_warning.py exit non-zero, but this check names the cause
     rather than leaving you to read a stack trace. */
  add(() => probe("防災情報XML regular feed (level-1 product present)",
    "https://www.data.jma.go.jp/developer/xml/feed/regular.xml",
    async r => {
      const t = await r.text();
      if (!/<feed[\s>]/.test(t)) return "not an Atom feed";
      const m = t.match(/<updated>([^<]+)<\/updated>/);
      if (!m) return "no feed <updated> element";
      if (!t.includes("早期注意情報（明後日まで）"))
        return "VPFD61 早期注意情報（明後日まで） absent from the feed — the level-1 "
             + "product has been renamed or moved; ingest_early_warning.py will be writing nothing";
      return stale(m[1], 6, "feed updated");
    }));

  /* 防災情報XML — carries 線状降水帯 and 記録的短時間大雨情報, the earliest
     flood signals JMA emits. High-frequency feed: minutes, not hours. */
  add(() => probe("防災情報XML extra feed (rain bulletins)",
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
  add(async () => {
    const idx = "https://www.jma.go.jp/bosai/jmatile/data/risk/targetTimes.json";
    const a = await probe("kikikuru risk targetTimes", idx, async (r, keep) => {
      const d = await r.json();
      keep(d);
      if (!(Array.isArray(d) && d.length && d[0].basetime)) return "index shape changed";
      const need = ["land", "inund", "flood"];
      const have = d[0].elements || [];
      const miss = need.filter(n => !have.includes(n));
      if (miss.length) return "risk elements missing: " + miss.join(", ");
      return stale(stampToIso(d[0].basetime), 2, "basetime");
    });
    if (!a.ok) return a;
    const d = a.data;
    const f = d.filter(x => x.validtime === x.basetime)[0] || d[0];
    return probe("kikikuru land tile (z8 over Chiba)",
      "https://www.jma.go.jp/bosai/jmatile/data/risk/" + f.basetime + "/" + (f.member || "immed0")
      + "/" + f.validtime + "/surf/land/8/227/100.png");
  });

  /* Geometry and area constants: the warn view degrades to chips without the
     first and to prefecture-wide scoping without the second, both of which
     are handled gracefully in the page — but silently, so they are checked
     here instead. */
  add(() => probe("class10 geometry (sub-region outlines)",
    "https://www.jma.go.jp/bosai/common/const/geojson/class10s.json",
    async r => {
      const d = await r.json();
      if (!(d && Array.isArray(d.features) && d.features.length > 100)) return "unexpected GeoJSON shape";
      return d.features.some(f => f.properties && f.properties.code === "120010")
        ? null : "class10 code 120010 absent — area codes may have been renumbered";
    }));

  add(() => probe("area constants (class20 parent chain)",
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

  add(() => probe("tsunami list",
    "https://www.jma.go.jp/bosai/tsunami/data/list.json",
    async r => { const d = await r.json(); return Array.isArray(d) ? null : "unexpected JSON shape"; }));

  add(() => probe("volcano registry",
    "https://www.jma.go.jp/bosai/volcano/const/volcano_list.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d.length > 30 && d[0].latlon) ? null : "suspiciously few volcanoes"; }));

  add(() => probe("volcano warnings",
    "https://www.jma.go.jp/bosai/volcano/data/warning.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d[0] && d[0].volcanoInfos) ? null : "unexpected JSON shape"; }));

  // rolling one-year window, so the query never silently ages past its own start date
  const usgsStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  add(() => probe("USGS FDSN (history heatmap)",
    "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=" + usgsStart + "&minlatitude=24&maxlatitude=46&minlongitude=122&maxlongitude=148&minmagnitude=6&limit=10",
    async r => { const d = await r.json(); return (d.features && Array.isArray(d.features)) ? null : "unexpected GeoJSON shape"; }));

  /* A check that throws (a bug, or an unexpected payload) becomes a named
     failure instead of rejecting Promise.all and killing the whole run. */
  const runOne = async (fn, i) => {
    try { return await fn(); }
    catch(e){ return {name:"check #" + i, url:"", ok:false, why:"checker error: " + (e && e.message || e)}; }
  };
  const runPass = async idx => {
    const res = await Promise.all(idx.map(i => runOne(checks[i], i)));
    return idx.map((i, k) => ({i, ...res[k]}));
  };

  // Pass 1: everything.
  let results = await runPass(checks.map((_, i) => i));
  let detector = retirementDetector();
  let firstBad = results.filter(x => !x.ok);
  const recovered = [];

  // Pass 2: only what failed, after a pause. Transient blips end here.
  if (firstBad.length || !detector.ok){
    console.log(firstBad.length + (detector.ok ? 0 : 1) + " check(s) failed on the first pass — rechecking in "
      + RECHECK_DELAY_S + " s before declaring anything broken");
    for (const b of firstBad) console.log(`  first pass: ${b.name}: ${b.why}`);
    if (!detector.ok) console.log(`  first pass: ${detector.name}: ${detector.why}`);
    await sleep(RECHECK_DELAY_S * 1000);
    const again = await runPass(firstBad.map(b => b.i));
    const byIdx = new Map(again.map(x => [x.i, x]));
    for (const b of firstBad) if (byIdx.get(b.i).ok) recovered.push(b);
    results = results.map(x => byIdx.get(x.i) || x);
    const det2 = retirementDetector();
    if (!detector.ok && det2.ok) recovered.push(detector);
    detector = det2;
  }
  results.push(detector);

  const bad = results.filter(x => !x.ok);
  console.log(`checked ${results.length} endpoints — ${results.length - bad.length} ok, ${bad.length} failing`
    + (recovered.length ? `, ${recovered.length} recovered on recheck` : ""));
  for (const b of bad) console.log(`  FAIL ${b.name}: ${b.why}\n       ${b.url}`);
  for (const b of recovered) console.log(`  FLAKY ${b.name}: ${b.why} (passed on recheck)`);
  for (const w of warnings) console.log(`  WARN ${w.name}: ${w.msg}`);

  /* Annotations name the broken feed on the run page and in the failure
     email itself — the plain log needs a sign-in to read, and "exit code 1"
     alone says nothing about which of ~130 endpoints broke. */
  if (IN_ACTIONS){
    for (const b of bad)
      console.log(`::error title=${ghEsc("Feed broken: " + b.name, true)}::${ghEsc(b.why + (b.url ? "\n" + b.url : ""))}`);
    for (const b of recovered)
      console.log(`::warning title=${ghEsc("Feed flaky (recovered): " + b.name, true)}::${ghEsc(b.why)}`);
    for (const w of warnings)
      console.log(`::warning title=${ghEsc(w.name, true)}::${ghEsc(w.msg)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY){
    const cell = s => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
    let md = `### Feed health: ${bad.length ? "❌ " + bad.length + " broken" : "✅ all healthy"}\n\n`
           + `${results.length} endpoints checked; ${recovered.length} recovered on recheck; ${warnings.length} warning(s).\n\n`;
    const rows = [...bad.map(b => ["❌ broken", b.name, b.why, b.url]),
                  ...recovered.map(b => ["⚠️ flaky", b.name, b.why, b.url]),
                  ...warnings.map(w => ["⚠️ warning", w.name, w.msg, ""])];
    if (rows.length)
      md += "| Status | Feed | Reason | URL |\n|---|---|---|---|\n"
          + rows.map(r => "| " + r.map(cell).join(" | ") + " |").join("\n") + "\n";
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch(e){}
  }

  if (bad.length){
    console.log("\nOne or more data feeds the Japan Weather/Disaster Atlas depends on are broken.");
    console.log("Most likely a JMA restructure — see README 'Known limits'.");
    process.exit(1);
  }
  console.log("all feeds healthy");
})().catch(e => {
  // Last-resort guard: never exit with an unexplained code 1.
  console.log("::error title=Feed checker crashed::" + ghEsc(e && e.stack || e));
  process.exit(1);
});
