#!/usr/bin/env node
/* Feed health check for the Japan Weather Atlas + Japan Disaster Atlas.
   Verifies every external endpoint the app depends on:
     - all 56 unique JMA forecast office files (from jma_cities.js)
     - Amedas latest_time, the map snapshot for that time, and the station table
     - typhoon target list
     - weather-map (天気図) index
     - radar nowcast (hrpns) time indexes + a live tile, Himawari IR jp index + a live tile
     - Open-Meteo JMA model pressure endpoint
     - Disaster Atlas: quake list, warning file, tsunami list,
       volcano registry + warnings, USGS FDSN history endpoint
   Exits 1 if anything is broken, so a scheduled GitHub Action fails
   and GitHub emails the repo owner. No dependencies; Node 18+.        */
"use strict";
const fs = require("fs");
const path = require("path");

// load the registry (plain script file, no exports) safely-ish via Function
const regSrc = fs.readFileSync(path.join(__dirname, "..", "jma_cities.js"), "utf8");
const CITIES = new Function(regSrc + "; return JMA_CITIES;")();

const TIMEOUT_MS = 20000;
async function probe(name, url, validate){
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

(async () => {
  const checks = [];

  // one forecast file per unique office
  const offices = [...new Set(CITIES.map(c => c.office))];
  for (const o of offices){
    checks.push(probe("forecast office " + o,
      "https://www.jma.go.jp/bosai/forecast/data/forecast/" + o + ".json",
      async r => {
        const d = await r.json();
        return (Array.isArray(d) && d[0] && d[0].timeSeries) ? null : "unexpected JSON shape";
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
    return probe("amedas map snapshot",
      "https://www.jma.go.jp/bosai/amedas/data/map/" + stamp + ".json",
      async r => { const d = await r.json(); return Object.keys(d).length > 500 ? null : "suspiciously few stations"; });
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
  checks.push(probe("quake list",
    "https://www.jma.go.jp/bosai/quake/data/list.json",
    async r => { const d = await r.json(); return (Array.isArray(d) && d.length && d[0].eid) ? null : "unexpected JSON shape"; }));

  checks.push(probe("warning file (Tokyo sample)",
    "https://www.jma.go.jp/bosai/warning/data/warning/130000.json",
    async r => { const d = await r.json(); return (d.areaTypes && d.areaTypes[0] && d.areaTypes[0].areas) ? null : "unexpected JSON shape"; }));

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
