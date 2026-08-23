#!/usr/bin/env node
/* Regression test for the Ibaraki lesson (2026-08-23).
 * JMA's VXSE61 震源要素更新 bulletin writes cod in degrees+decimal-minutes and
 * carries no maxi. Before this fix it out-ranked the located report on ctt and
 * the M5.9 震度5弱 茨城県南部 quake was plotted at latitude 3559 — gone from the
 * map, no banner, no error. Fixture records are verbatim from the live feed.
 * Run:  node tests/test_quake_hypo_update.js */
const fs = require("fs"), path = require("path");
const {JSDOM} = require("jsdom");
const html = fs.readFileSync(path.join(__dirname, "..", "japan_disaster_jma.html"), "utf8");

// Extract the pure functions under test without booting the whole page.
function slice(name, next){
  const a = html.indexOf(name); if (a < 0) throw new Error("missing " + name);
  const b = html.indexOf(next, a); return html.slice(a, b);
}
const code = [
  slice("function parseCod(cod){", "function jstFmt("),
  slice("function selectQuakes(list){", "async function loadQuakes("),
].join("\n");
const win = new JSDOM("<!doctype html><html><body></body></html>", {runScripts:"outside-only"}).window;
win.eval(code + "\nwindow.__t = {parseCod, codFromDDMM, isHypoUpdate, selectQuakes};");
const {parseCod, codFromDDMM, isHypoUpdate, selectQuakes} = win.__t;

let n = 0, fail = 0;
function ok(c, msg){ n++; if (!c){ fail++; console.log("  FAIL " + msg); } else console.log("  ok   " + msg); }
const near = (a,b,eps) => Math.abs(a-b) < eps;

// ---- verbatim from https://www.jma.go.jp/bosai/quake/data/list.json, 2026-08-23 ----
const IBARAKI = [
 {eid:"20260823020050",ctt:"20260823040012",ttl:"顕著な地震の震源要素更新のお知らせ",anm:"茨城県南部",mag:"5.9",maxi:"",cod:"+3559.9+14005.7-68000/",at:"2026-08-23T02:00:00+09:00",rdt:"2026-08-23T04:00:00+09:00",json:"20260823040012_20260823020050_VXSE61_0.json"},
 {eid:"20260823020050",ctt:"20260823021215",ttl:"震源・震度情報",anm:"茨城県南部",mag:"5.9",maxi:"5-",cod:"+36.0+140.1-70000/",at:"2026-08-23T02:00:00+09:00",json:"20260823021215_20260823020050_VXSE5k_2.json"},
 {eid:"20260823020050",ctt:"20260823020635",ttl:"震源・震度情報",anm:"茨城県南部",mag:"5.9",maxi:"5-",cod:"+36.0+140.1-70000/",at:"2026-08-23T02:00:00+09:00",json:"20260823020635_20260823020050_VXSE5k_1.json"},
 {eid:"20260823020050",ctt:"20260823020406",ttl:"震度速報",anm:"",mag:"",maxi:"5-",cod:"",at:"2026-08-23T02:00:00+09:00",json:"20260823020406_20260823020050_VXSE51_0.json"},
 {eid:"20260823020050",ctt:"20260823020346",ttl:"震源に関する情報",anm:"茨城県南部",mag:"5.9",maxi:"",cod:"+36.0+140.1-70000/",at:"2026-08-23T02:00:00+09:00",json:"20260823020346_20260823020050_VXSE52_0.json"},
 {eid:"20260823075637",ctt:"20260823075923",ttl:"震源・震度情報",anm:"石川県能登地方",mag:"2.3",maxi:"1",cod:"+37.3+136.8-10000/",at:"2026-08-23T07:56:00+09:00",json:"20260823075923_20260823075637_VXSE5k_1.json"},
];

console.log("parseCod");
ok(parseCod("+36.0+140.1-70000/").lat === 36.0, "decimal-degree cod parses");
ok(parseCod("+36.0+140.1-70000/").depth === 70, "depth km");
ok(parseCod("+3559.9+14005.7-68000/") === null, "DDMM.M cod refused (lat 3559 must never plot)");
ok(parseCod("") === null && parseCod(undefined) === null, "empty cod → null");

console.log("codFromDDMM");
const c = parseCod(codFromDDMM("+3559.9+14005.7-68000/"));
ok(c && near(c.lat, 35.998, 0.002) && near(c.lon, 140.095, 0.002), "35°59.9' 140°05.7' → 35.998, 140.095");
ok(c && c.depth === 68, "depth preserved through conversion (68 km)");
const k = parseCod(codFromDDMM("+3237.5+13040.7-16000/"));
ok(k && near(k.lat, 32.625, 0.001) && near(k.lon, 130.678, 0.001), "Kumamoto VXSE61 fixture converts");
ok(codFromDDMM("+36.0+140.1-70000/") === null, "decimal-degree cod is NOT mistaken for DDMM.M");

console.log("isHypoUpdate");
ok(isHypoUpdate(IBARAKI[0]) === true, "VXSE61 recognised by title");
ok(isHypoUpdate({ttl:"x", json:"a_b_VXSE61_0.json"}) === true, "VXSE61 recognised by filename");
ok(isHypoUpdate(IBARAKI[1]) === false, "VXSE5k not an update");

console.log("selectQuakes — the bug itself");
const out = selectQuakes(IBARAKI);
const ib = out.find(q => q.eid === "20260823020050");
ok(out.length === 2, "one record per eid (Ibaraki + Noto)");
ok(!!ib, "Ibaraki quake present");
ok(ib && ib.maxi === "5-", "intensity 5弱 retained from located report (VXSE61 has none)");
ok(ib && ib.mag === "5.9", "magnitude retained");
const p = ib && parseCod(ib.cod);
ok(p && near(p.lat, 35.998, 0.002) && near(p.lon, 140.095, 0.002), "epicenter is the VXSE61-refined position in decimal degrees");
ok(p && p.depth === 68, "depth is the refined 68 km (was 70)");
ok(ib && ib.hypoUpdatedAt === "2026-08-23T04:00:00+09:00", "revision time recorded for popup provenance");
ok(ib && ib.json === "20260823021215_20260823020050_VXSE5k_2.json", "station detail still fetched from the located report");

console.log("selectQuakes — ordering independence & edge cases");
const shuffled = [...IBARAKI].reverse();
ok(JSON.stringify(selectQuakes(shuffled)) === JSON.stringify(out), "result independent of feed order");
const orphan = selectQuakes([IBARAKI[0]]);
ok(orphan.length === 0, "VXSE61 with no located report is not plotted on its own");
const noUpd = selectQuakes(IBARAKI.slice(1));
const nb = noUpd.find(q => q.eid === "20260823020050");
ok(nb && nb.cod === "+36.0+140.1-70000/" && !nb.hypoUpdatedAt, "without VXSE61 behaviour is unchanged");
const badUpd = selectQuakes([{...IBARAKI[0], cod:"+9999+99999-1000/"}, IBARAKI[1]]);
ok(badUpd[0].cod === "+36.0+140.1-70000/", "garbage VXSE61 cod → located report kept, nothing lost");

// quakeStatus-equivalent: 5弱 must rank for the live banner
const rank = {"5-":1,"5+":2,"6-":3,"6+":4,"7":5};
ok(ib && rank[ib.maxi] === 1, "live banner would fire (rank of 5弱 is truthy)");

console.log("\n" + (n - fail) + "/" + n + " assertions passed");
process.exit(fail ? 1 : 0);
