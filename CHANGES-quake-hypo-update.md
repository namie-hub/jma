# Quake layer: VXSE61 震源要素更新 handling (2026-08-23)

## Why
The M5.9 震度5弱 茨城県南部 quake (02:00 JST) vanished from the Disaster Atlas at 04:00 JST.
JMA issued a VXSE61 顕著な地震の震源要素更新のお知らせ — only ever sent for notable quakes —
whose `cod` is degrees+decimal-minutes (`+3559.9+14005.7-68000/`) and whose `maxi` is empty.
`loadQuakes()` took it as the newest located report → marker at lat 3559, no 震度 rank,
no live banner, no error. Only two VXSE61 records exist in the current 904-entry feed.

## Files (upload via Add file → Upload files)
| path | change |
|---|---|
| `japan_disaster_jma.html` | `parseCod` refuses out-of-range coords; new `codFromDDMM`, `isHypoUpdate`, `selectQuakes` (pure, testable); VXSE61 applied as overlay (refined cod/mag/depth, intensity kept); popup gets "Hypocenter: revised by JMA 震源要素更新 HH:MM JST" |
| `scripts/check_feeds.js` | quake-list validator now classifies every bulletin type (`V[XY]SE51/52/53/56/5e/5k/60/61/62`) and range-checks every `cod` per type — a new JMA message type or a DDMM.M cod in a decimal-degree bulletin fails the scheduled run loudly |
| `tests/test_quake_hypo_update.js` | 24 jsdom assertions using verbatim feed records; `node tests/test_quake_hypo_update.js` |

No other layer touched. Tsunami/warning/Nankai/volcano/typhoon unchanged. Record shape consumed by
`renderQuakes`, `showQuake`, `quakeStatus` is unchanged plus three optional fields (`hypoUpdatedAt`,
`hypoUpdateCtt`, `hypoUpdateJson`). Without a VXSE61 in the feed, behaviour is byte-identical.

## Verified
- 24/24 unit assertions.
- Full render against today's live list.json with stubbed Leaflet: Ibaraki marker at 35.998/140.095,
  summary "largest M5.9", `quakeStatus()` → 茨城県南部 震度5- (live banner fires), zero jsdom errors,
  no marker outside ±90/±180.
- `check_feeds.js` validator: passes on live list; fails on injected DDMM cod in VXSE5k; fails on
  unknown VXSE99.

## Note
The feed also carries `VXSE5e` 遠地地震 and `VYSE52` 南海トラフ解説 entries; both are cod-less and
already fell through harmlessly, now explicitly classified. If feed-check ever reports
"unclassified bulletin type", that is JMA adding a message kind — classify before trusting its cod.
