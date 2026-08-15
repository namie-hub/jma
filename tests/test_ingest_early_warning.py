#!/usr/bin/env python3
"""Parser contract tests for scripts/ingest_early_warning.py.

Runs in atlas-ingest.yml before any ingest, so a parser broken by a JMA
schema change writes nothing rather than writing a confidently empty file.

The fixtures are trimmed from a real VPFD61 telegram (青森地方気象台,
2026-08-15) — namespaces, the condition="値なし" empty-element form and the
refID/timeId indirection are all reproduced exactly, because those three are
where a naive parser silently yields nothing.
"""
import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import ingest_early_warning as ew


TELEGRAM = """<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://xml.kishou.go.jp/jmaxml1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<Control>
<Title>早期注意情報（明後日まで）</Title>
<PublishingOffice>青森地方気象台</PublishingOffice>
</Control>
<Head xmlns="http://xml.kishou.go.jp/jmaxml1/informationBasis1/">
<Title>青森県早期注意情報（明後日まで）</Title>
<ReportDateTime>2026-08-15T14:00:00+09:00</ReportDateTime>
<InfoType>発表</InfoType>
</Head>
<Body xmlns="http://xml.kishou.go.jp/jmaxml1/body/meteorology1/" xmlns:jmx_eb="http://xml.kishou.go.jp/jmaxml1/elementBasis1/">
<MeteorologicalInfos type="区域予報">
<TimeSeriesInfo>
<TimeDefines>
<TimeDefine timeId="1"><DateTime>2026-08-15T12:00:00+09:00</DateTime><Duration>PT6H</Duration><Name>１５日１２時から１８時</Name></TimeDefine>
<TimeDefine timeId="2"><DateTime>2026-08-15T18:00:00+09:00</DateTime><Duration>PT6H</Duration><Name>１５日１８時から２４時</Name></TimeDefine>
</TimeDefines>
<Item>
<Kind><Property>
<Type>大雨の警報級の可能性</Type>
<PossibilityRankOfWarningPart>
<jmx_eb:PossibilityRankOfWarning refID="1" type="大雨の警報級の可能性">高</jmx_eb:PossibilityRankOfWarning>
<jmx_eb:PossibilityRankOfWarning refID="2" type="大雨の警報級の可能性" condition="値なし"/>
</PossibilityRankOfWarningPart>
<Text>津軽では、１５日夕方までの期間内に、大雨警報を発表する可能性が高い。</Text>
</Property></Kind>
<Kind><Property>
<Type>雪の警報級の可能性</Type>
<PossibilityRankOfWarningPart>
<jmx_eb:PossibilityRankOfWarning refID="1" type="雪の警報級の可能性">なし</jmx_eb:PossibilityRankOfWarning>
<jmx_eb:PossibilityRankOfWarning refID="2" type="雪の警報級の可能性" condition="値なし"/>
</PossibilityRankOfWarningPart>
</Property></Kind>
<Area><Name>津軽</Name><Code>020010</Code></Area>
</Item>
<Item>
<Kind><Property>
<Type>波の警報級の可能性</Type>
<PossibilityRankOfWarningPart>
<jmx_eb:PossibilityRankOfWarning refID="2" type="波の警報級の可能性">中</jmx_eb:PossibilityRankOfWarning>
</PossibilityRankOfWarningPart>
</Property></Kind>
<Area><Name>下北</Name><Code>020020</Code></Area>
</Item>
<Item>
<Kind><Property>
<Type>雷の警報級の可能性</Type>
<PossibilityRankOfWarningPart>
<jmx_eb:PossibilityRankOfWarning refID="1" type="雷の警報級の可能性" condition="値なし"/>
</PossibilityRankOfWarningPart>
</Property></Kind>
<Area><Name>三八上北</Name><Code>020030</Code></Area>
</Item>
</TimeSeriesInfo>
</MeteorologicalInfos>
</Body>
</Report>
"""

FEED = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<updated>2026-08-15T05:30:00Z</updated>
<entry>
<title>早期注意情報（明後日まで）</title>
<updated>2026-08-15T05:21:56Z</updated>
<author><name>青森地方気象台</name></author>
<link type="application/xml" href="https://example.invalid/aomori-new.xml"/>
</entry>
<entry>
<title>早期注意情報（明後日まで）</title>
<updated>2026-08-15T00:10:00Z</updated>
<author><name>青森地方気象台</name></author>
<link type="application/xml" href="https://example.invalid/aomori-old.xml"/>
</entry>
<entry>
<title>警報級の可能性（明日まで）</title>
<updated>2026-08-15T05:20:00Z</updated>
<author><name>青森地方気象台</name></author>
<link type="application/xml" href="https://example.invalid/vpfd60.xml"/>
</entry>
<entry>
<title>府県天気予報（Ｒ１）</title>
<updated>2026-08-15T05:00:00Z</updated>
<author><name>青森地方気象台</name></author>
<link type="application/xml" href="https://example.invalid/forecast.xml"/>
</entry>
<entry>
<title>早期注意情報（明後日まで）</title>
<updated>2026-08-15T05:22:00Z</updated>
<author><name>新潟地方気象台</name></author>
<link type="application/xml" href="https://example.invalid/niigata.xml"/>
</entry>
</feed>
"""


class TestFeedIndex(unittest.TestCase):
    def test_selects_only_vpfd61(self):
        got = ew.entry_urls(FEED.encode())
        titles = {u for _, _, u in got}
        self.assertNotIn("https://example.invalid/vpfd60.xml", titles,
                         "VPFD60 overlaps VPFD61's window and would double-count")
        self.assertNotIn("https://example.invalid/forecast.xml", titles)

    def test_newest_bulletin_per_office_wins(self):
        got = {o: href for o, _u, href in ew.entry_urls(FEED.encode())}
        self.assertEqual(got["青森地方気象台"], "https://example.invalid/aomori-new.xml",
                         "a superseded bulletin must never overwrite a current one")

    def test_one_entry_per_office(self):
        got = ew.entry_urls(FEED.encode())
        offices = [o for o, _, _ in got]
        self.assertEqual(len(offices), len(set(offices)))
        self.assertEqual(set(offices), {"青森地方気象台", "新潟地方気象台"})


class TestTelegram(unittest.TestCase):
    def setUp(self):
        self.report, self.office, self.areas = ew.parse_telegram(TELEGRAM.encode())

    def test_header(self):
        self.assertEqual(self.report, "2026-08-15T14:00:00+09:00")
        self.assertEqual(self.office, "青森地方気象台")

    def test_area_keyed_by_class10_code(self):
        # 020010 is exactly what city.region carries in jma_cities.js
        self.assertIn("020010", self.areas)
        self.assertEqual(self.areas["020010"]["name"], "津軽")

    def test_ranked_element_kept_with_its_time_window(self):
        rain = [k for k in self.areas["020010"]["kinds"] if k["jp"] == "大雨"][0]
        self.assertEqual(rain["el"], "rain")
        self.assertEqual(len(rain["hits"]), 1, "only the ranked window counts")
        self.assertEqual(rain["hits"][0]["rank"], "高")
        self.assertEqual(rain["hits"][0]["when"], "１５日１２時から１８時",
                         "refID must resolve through TimeDefines or the window is lost")

    def test_nashi_and_empty_condition_are_dropped(self):
        kinds = {k["jp"] for k in self.areas["020010"]["kinds"]}
        self.assertNotIn("雪", kinds, "'なし' is not a possibility")

    def test_area_with_no_real_rank_is_omitted_entirely(self):
        self.assertNotIn("020030", self.areas,
                         "an area whose every cell is 値なし has no level-1 state")

    def test_worst_rank_drives_the_area(self):
        self.assertEqual(self.areas["020010"]["worst"], "高")
        self.assertEqual(self.areas["020020"]["worst"], "中")

    def test_text_preserved_verbatim(self):
        self.assertIn("大雨警報を発表する可能性が高い", self.areas["020010"]["text"])

    def test_unknown_element_surfaces_rather_than_vanishing(self):
        xml = TELEGRAM.replace("大雨の警報級の可能性", "宇宙線の警報級の可能性")
        _r, _o, areas = ew.parse_telegram(xml.encode())
        k = [x for x in areas["020010"]["kinds"] if x["jp"] == "宇宙線"][0]
        self.assertTrue(k["unknown"])
        self.assertEqual(k["en"], "宇宙線")

    def test_malformed_xml_raises(self):
        with self.assertRaises(Exception):
            ew.parse_telegram(b"<<<not xml")


if __name__ == "__main__":
    unittest.main(verbosity=2)
