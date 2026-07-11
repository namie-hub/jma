/* jma_pressure.js — shared sea-level pressure engine for the Japan Weather
   Atlas and the Japan Disaster Atlas. Single source of truth: model fetch
   (Open-Meteo, JMA GSM), bilinear upsampling, marching-squares isolines,
   低/高 centre detection (including weak "forming" lows), and drawing.
   Loaded via <script> tag, like jma_cities.js, so file:// still works.   */
"use strict";

const JMA_PRESSURE = (() => {

  async function fetchModelPressure(){
    const lat0=20, lat1=48, lon0=115, lon1=155, dl=2;
    const rows=(lat1-lat0)/dl+1, cols=(lon1-lon0)/dl+1;
    const lats=[], lons=[];
    for (let j=0;j<rows;j++) for (let i=0;i<cols;i++){ lats.push(lat0+j*dl); lons.push(lon0+i*dl); }
    const vals = new Array(lats.length);
    const chunk = 160;
    for (let a=0; a<lats.length; a+=chunk){
      const b = Math.min(a+chunk, lats.length);
      const u = "https://api.open-meteo.com/v1/jma?latitude=" + lats.slice(a,b).join(",")
              + "&longitude=" + lons.slice(a,b).join(",") + "&current=pressure_msl";
      const d = await (await fetch(u)).json();
      if (!Array.isArray(d) && d && d.error) throw new Error(d.reason || "model API error");
      const arr = Array.isArray(d) ? d : [d];
      for (let k=0;k<arr.length;k++)
        vals[a+k] = (arr[k].current && arr[k].current.pressure_msl != null) ? arr[k].current.pressure_msl : NaN;
    }
    const V = [];
    for (let j=0;j<rows;j++) V.push(vals.slice(j*cols,(j+1)*cols));
    return {V, rows, cols, lat0, lon0, dl};
  }

  function upsample3(g){ // bilinear, 3x finer for smoother contour curves
    const f = 3, rows = (g.rows-1)*f+1, cols = (g.cols-1)*f+1, dl = g.dl/f;
    const V = new Array(rows);
    for (let j=0;j<rows;j++){
      V[j] = new Array(cols);
      const y = j/f, j0 = Math.min(Math.floor(y), g.rows-2), ty = y-j0;
      for (let i=0;i<cols;i++){
        const x = i/f, i0 = Math.min(Math.floor(x), g.cols-2), tx = x-i0;
        const a=g.V[j0][i0], b=g.V[j0][i0+1], c=g.V[j0+1][i0], d=g.V[j0+1][i0+1];
        V[j][i] = a*(1-tx)*(1-ty) + b*tx*(1-ty) + c*(1-tx)*ty + d*tx*ty;
      }
    }
    return {V, rows, cols, lat0:g.lat0, lon0:g.lon0, dl};
  }

  /* Japanese landmass, approximated by generous bounding boxes, so isobar
     value labels land clearly offshore. Continental Asia is NOT masked.  */
  const JAPAN_LAND = [
    [41.2,45.7,139.6,146.0],[37.4,41.7,139.3,142.2],[34.4,38.6,135.9,141.3],
    [33.3,35.9,130.7,136.6],[32.5,34.6,131.9,134.9],[30.8,34.1,128.4,132.3],
    [33.9,34.9,129.0,129.6],[37.6,38.5,138.1,138.7],[29.9,31.0,130.2,131.3],
    [27.8,28.7,129.0,129.9],[25.9,27.1,127.4,128.6],[24.2,24.9,123.6,124.4],
    [24.6,25.1,125.1,125.6]
  ];
  function overJapan(lat, lon){
    for (const b of JAPAN_LAND)
      if (lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]) return true;
    return false;
  }

  function findCentres(g, win, prom){ // local extrema with prominence + edge guard
    const nMin = (2*win+1)*(win+1)-1;
    const cand = [];
    for (let j=0;j<g.rows;j++) for (let i=0;i<g.cols;i++){
      const v = g.V[j][i];
      if (isNaN(v)) continue;
      let minNb=Infinity, maxNb=-Infinity, sum=0, n=0;
      for (let dj=-win;dj<=win;dj++) for (let di=-win;di<=win;di++){
        if (!dj && !di) continue;
        const jj=j+dj, ii=i+di;
        if (jj<0||jj>=g.rows||ii<0||ii>=g.cols) continue;
        const u = g.V[jj][ii];
        if (isNaN(u)) continue;
        minNb=Math.min(minNb,u); maxNb=Math.max(maxNb,u); sum+=u; n++;
      }
      if (n < nMin) continue;
      const mean = sum/n;
      if (v <= minNb && mean - v >= prom) cand.push({kind:"L", v, j, i});
      if (v >= maxNb && v - mean >= prom) cand.push({kind:"H", v, j, i});
    }
    cand.sort((a,b) => (a.kind==="L" ? a.v-b.v : b.v-a.v));
    const kept = [];
    for (const c of cand)
      if (!kept.some(k => k.kind===c.kind && Math.abs(k.j-c.j)<=win && Math.abs(k.i-c.i)<=win)) kept.push(c);
    return kept.map(c => ({kind:c.kind, v:c.v, lat:g.lat0+c.j*g.dl, lon:g.lon0+c.i*g.dl}));
  }

  function isolines(grid, T){
    const {V, rows, cols, lat0, lon0, dl} = grid;
    const segs = [];
    const P = (j,i)=>[lat0+j*dl, lon0+i*dl];
    const lerp=(p0,p1,v0,v1)=>{const t=(T-v0)/(v1-v0);return [p0[0]+(p1[0]-p0[0])*t, p0[1]+(p1[1]-p0[1])*t];};
    for (let j=0;j<rows-1;j++) for (let i=0;i<cols-1;i++){
      const a=V[j][i], b=V[j][i+1], c=V[j+1][i+1], d=V[j+1][i];
      if (isNaN(a)||isNaN(b)||isNaN(c)||isNaN(d)) continue;
      const idx=(a>T?1:0)|(b>T?2:0)|(c>T?4:0)|(d>T?8:0);
      if (idx===0||idx===15) continue;
      const A=P(j,i),B=P(j,i+1),C=P(j+1,i+1),D=P(j+1,i);
      const AB=()=>lerp(A,B,a,b), BC=()=>lerp(B,C,b,c), CD=()=>lerp(C,D,c,d), DA=()=>lerp(D,A,d,a);
      switch(idx){
        case 1: case 14: segs.push([DA(),AB()]); break;
        case 2: case 13: segs.push([AB(),BC()]); break;
        case 3: case 12: segs.push([DA(),BC()]); break;
        case 4: case 11: segs.push([BC(),CD()]); break;
        case 5:          segs.push([DA(),CD()],[AB(),BC()]); break;
        case 6: case 9:  segs.push([AB(),CD()]); break;
        case 7: case 8:  segs.push([DA(),CD()]); break;
        case 10:         segs.push([DA(),AB()],[BC(),CD()]); break;
      }
    }
    return segs;
  }

  /* Draw the full chart into a Leaflet layer group.
     opts: { canvas       — L.canvas renderer to use for polylines,
             formingLows  — also mark weak lows (dashed 低), default true }
     Requires CSS classes .isoLabel, .lhBadge (.low/.high/.forming) on the page. */
  function drawIsobars(layer, field, opts){
    if (!field) return;
    opts = opts || {};
    const fine = upsample3(field);
    let lo=Infinity, hi=-Infinity;
    for (const row of field.V) for (const v of row){
      if (isNaN(v)) continue;
      if (v<lo) lo=v; if (v>hi) hi=v;
    }
    if (!isFinite(lo)) return;

    const placed = [];
    const LABEL_LAT = 33.5, MIN_SEP = 0.9;
    for (let T = Math.ceil(lo/4)*4; T <= Math.floor(hi/4)*4; T += 4){
      const segs = isolines(fine, T);
      if (!segs.length) continue;
      L.polyline(segs, {renderer:opts.canvas, color:"#24425F",
        opacity:0.8, weight:(T % 20 === 0) ? 2.4 : 1.3, interactive:false}).addTo(layer);
      const mids = segs.map(sg => [(sg[0][0]+sg[1][0])/2, (sg[0][1]+sg[1][1])/2])
                       .filter(m => !overJapan(m[0], m[1]));
      if (!mids.length) continue;
      mids.sort((a,b) => Math.abs(a[0]-LABEL_LAT) - Math.abs(b[0]-LABEL_LAT));
      let spot = null, fallback = null, fallbackD = -1;
      for (const m of mids){
        let dmin = Infinity;
        for (const pp of placed){
          const d = Math.max(Math.abs(pp[0]-m[0]), Math.abs(pp[1]-m[1])*0.85);
          if (d < dmin) dmin = d;
        }
        if (dmin >= MIN_SEP){ spot = m; break; }
        if (dmin > fallbackD){ fallbackD = dmin; fallback = m; }
      }
      if (!spot) spot = fallback || mids[0];
      placed.push(spot);
      L.marker(spot, {interactive:false,
        icon:L.divIcon({className:"", html:'<div class="isoLabel">' + T + '</div>',
        iconSize:null, iconAnchor:[13,8]})}).addTo(layer);
    }

    const strong = findCentres(field, 2, 1.0);
    for (const c of strong){
      const low = c.kind === "L";
      L.marker([c.lat, c.lon], {interactive:false, icon:L.divIcon({className:"",
        html:'<div class="lhBadge ' + (low?"low":"high") + '"><span>' + (low?"低":"高")
          + '</span><em>' + c.v.toFixed(0) + '</em></div>',
        iconSize:null, iconAnchor:[13,15]})}).addTo(layer);
    }
    if (opts.formingLows !== false){
      // weak lows below the full prominence test: an organising system,
      // visible before JMA upgrades it to a numbered tropical cyclone.
      const weak = findCentres(field, 2, 0.4).filter(c =>
        c.kind === "L" && !strong.some(sc =>
          sc.kind === "L" && Math.abs(sc.lat - c.lat) < 4.5 && Math.abs(sc.lon - c.lon) < 4.5));
      for (const c of weak){
        L.marker([c.lat, c.lon], {interactive:false, icon:L.divIcon({className:"",
          html:'<div class="lhBadge forming"><span>低</span><em>' + c.v.toFixed(0) + '</em></div>',
          iconSize:null, iconAnchor:[13,15]})}).addTo(layer);
      }
    }
  }

  return {fetchModelPressure, upsample3, isolines, findCentres, overJapan, drawIsobars};
})();
