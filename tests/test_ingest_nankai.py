"""Contract tests for scripts/ingest_nankai.py.

The latch is the whole point of this leg: a 南海トラフ臨時情報 must keep
displaying after the telegram ages out of the 7-day feed window, and must
clear only when an ending telegram is seen. These tests pin that, plus the
keyword-extraction priority order.

Fixture provenance: the InfoSerial/Head/Headline shapes below are taken from
a live VYSE52 telegram (20260807080028_0_VYSE52_010000.xml, fetched 8 Aug
2026) — note the codeType attribute on InfoSerial, which an attribute-less
pattern silently fails to match. No real VYSE50 臨時情報 has ever been
observed, so the 臨時情報 keywords are synthesised per spec 40601; when the
first real one lands it is a verification event against these fixtures.
"""
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest_nankai.py"
SPEC = importlib.util.spec_from_file_location("ingest_nankai", SCRIPT)
INGEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INGEST)

RINJI = INGEST.TITLE_RINJI
KAISETSU = INGEST.TITLE_KAISETSU


def telegram(*, serial_name=None, head_text="", body_text="", headline=""):
    """Build a telegram with the real element shapes (attributes included)."""
    info_serial = (
        f'<InfoSerial codeType="地震関連情報番号コード">'
        f"<Name>{serial_name}</Name><Code>200</Code></InfoSerial>"
        if serial_name else ""
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Report>
<Head>
<Title>{head_text}</Title>
<ReportDateTime>2026-08-07T17:00:00+09:00</ReportDateTime>
<Headline><Text>
　{headline}
</Text></Headline>
</Head>
<Body>
<EarthquakeInfo>
{info_serial}
<Text>{body_text}</Text>
</EarthquakeInfo>
</Body>
</Report>"""


def entry(title, url, updated):
    return (title, url, updated)


class ExtractKeywordTests(unittest.TestCase):
    def test_infoserial_with_attributes_is_matched(self):
        """The live element carries codeType — an attribute-less pattern misses it.

        The Head deliberately names a HIGHER-priority keyword than InfoSerial,
        so a pattern that fails to match falls through and returns the wrong
        answer rather than accidentally passing on the whole-telegram scan.
        """
        xml = telegram(serial_name="調査中", head_text="巨大地震警戒に関する解説")

        self.assertEqual(INGEST.extract_keyword(xml), "調査中")

    def test_infoserial_outranks_head(self):
        """InfoSerial/Name is authoritative; Head is only a fallback."""
        xml = telegram(serial_name="巨大地震注意", head_text="南海トラフ地震臨時情報（調査中）")

        self.assertEqual(INGEST.extract_keyword(xml), "巨大地震注意")

    def test_head_used_when_no_infoserial(self):
        xml = telegram(head_text="南海トラフ地震臨時情報（調査中）")

        self.assertEqual(INGEST.extract_keyword(xml), "調査中")

    def test_keiaki_outranks_chosa_in_same_head(self):
        """A 警戒 headline also mentions 調査 — priority order must not flip."""
        xml = telegram(head_text="巨大地震警戒　調査を継続します")

        self.assertEqual(INGEST.extract_keyword(xml), "巨大地震警戒")

    def test_no_keyword_anywhere_returns_none(self):
        self.assertIsNone(INGEST.extract_keyword(telegram(head_text="平常")))


class ExtractFieldTests(unittest.TestCase):
    def test_report_time_and_headline(self):
        xml = telegram(headline="第１０８回南海トラフ沿いの地震に関する評価検討会")

        self.assertEqual(INGEST.extract_report_time(xml), "2026-08-07T17:00:00+09:00")
        self.assertIn("評価検討会", INGEST.extract_headline(xml))

    def test_headline_whitespace_is_collapsed(self):
        xml = telegram(headline="行頭　　空白\n　を潰す")

        self.assertNotIn("\n", INGEST.extract_headline(xml))


class BuildStateTests(unittest.TestCase):
    """build_state is the latch. fetch_fn is injected so no network is touched."""

    def _fetch(self, mapping):
        return lambda url: mapping[url]

    def test_advisory_sets_status_and_latch(self):
        url = "https://example.invalid/VYSE50.xml"
        entries = [entry(RINJI, url, "2026-08-08T09:00:00+09:00")]

        state = INGEST.build_state(
            entries, None,
            fetch_fn=self._fetch({url: telegram(serial_name="巨大地震注意")}))

        self.assertEqual(state["status"], "巨大地震注意")
        self.assertEqual(state["telegramUrl"], url)
        self.assertIsNotNone(state["latchedSince"])

    def test_latch_survives_empty_feed_window(self):
        """The telegram ages out after 7 days; 注意 runs ~1 week, 警戒 longer."""
        prev = {"status": "巨大地震注意", "keyword": "巨大地震注意",
                "headline": "h", "reportTime": "r", "telegramUrl": "u",
                "latchedSince": "2026-08-01T00:00:00+09:00", "lastKaisetsu": None}

        state = INGEST.build_state([], prev, fetch_fn=self._fetch({}))

        self.assertEqual(state["status"], "巨大地震注意")
        self.assertEqual(state["latchedSince"], "2026-08-01T00:00:00+09:00")

    def test_end_keyword_clears_latch(self):
        url = "https://example.invalid/end.xml"
        prev = {"status": "巨大地震注意", "latchedSince": "2026-08-01T00:00:00+09:00",
                "telegramUrl": "old"}
        entries = [entry(RINJI, url, "2026-08-08T09:00:00+09:00")]

        state = INGEST.build_state(
            entries, prev,
            fetch_fn=self._fetch({url: telegram(serial_name="調査終了")}))

        self.assertEqual(state["status"], "none")
        self.assertIsNone(state["latchedSince"])
        self.assertEqual(state["keyword"], "調査終了")

    def test_latched_since_is_stable_across_reruns(self):
        """Same advisory, same URL — the clock must not restart every 30 min."""
        url = "https://example.invalid/VYSE50.xml"
        entries = [entry(RINJI, url, "2026-08-08T09:00:00+09:00")]
        fetch = self._fetch({url: telegram(serial_name="巨大地震注意")})

        first = INGEST.build_state(entries, None, fetch_fn=fetch)
        second = INGEST.build_state(entries, dict(first), fetch_fn=fetch)

        self.assertEqual(second["latchedSince"], first["latchedSince"])

    def test_new_telegram_url_restarts_latch(self):
        prev = {"status": "巨大地震注意", "telegramUrl": "https://example.invalid/old.xml",
                "latchedSince": "2026-08-01T00:00:00+09:00"}
        url = "https://example.invalid/new.xml"
        entries = [entry(RINJI, url, "2026-08-08T09:00:00+09:00")]

        state = INGEST.build_state(
            entries, prev,
            fetch_fn=self._fetch({url: telegram(serial_name="巨大地震注意")}))

        self.assertNotEqual(state["latchedSince"], "2026-08-01T00:00:00+09:00")

    def test_unmatched_keyword_becomes_unknown_advisory(self):
        """A VYSE50 exists but no keyword matches — surface it, never discard."""
        url = "https://example.invalid/VYSE50.xml"
        entries = [entry(RINJI, url, "2026-08-08T09:00:00+09:00")]

        state = INGEST.build_state(
            entries, None, fetch_fn=self._fetch({url: telegram(head_text="不明な文言")}))

        self.assertEqual(state["status"], "unknown-advisory")
        self.assertIsNone(state["keyword"])

    def test_kaisetsu_is_recorded_but_never_a_status(self):
        """VYSE51/52 are commentary — they must not move the latch."""
        url = "https://example.invalid/VYSE52.xml"
        entries = [entry(KAISETSU, url, "2026-08-07T17:00:00+09:00")]

        state = INGEST.build_state(
            entries, None,
            fetch_fn=self._fetch({url: telegram(serial_name="定例解説",
                                                headline="定例の評価検討会")}))

        self.assertEqual(state["status"], "none")
        self.assertIsNotNone(state["lastKaisetsu"])
        self.assertEqual(state["lastKaisetsu"]["url"], url)

    def test_newest_rinji_wins(self):
        old_url = "https://example.invalid/old.xml"
        new_url = "https://example.invalid/new.xml"
        entries = [entry(RINJI, old_url, "2026-08-01T09:00:00+09:00"),
                   entry(RINJI, new_url, "2026-08-08T09:00:00+09:00")]

        state = INGEST.build_state(entries, None, fetch_fn=self._fetch({
            old_url: telegram(serial_name="調査中"),
            new_url: telegram(serial_name="巨大地震警戒"),
        }))

        self.assertEqual(state["status"], "巨大地震警戒")


class ParseEntriesTests(unittest.TestCase):
    def test_entries_are_extracted(self):
        feed = """<feed>
<entry><title>南海トラフ地震関連解説情報</title>
<link href="https://example.invalid/a.xml"/>
<updated>2026-08-07T08:00:28Z</updated></entry>
<entry><title>震源・震度に関する情報</title>
<link href="https://example.invalid/b.xml"/>
<updated>2026-08-08T01:00:00Z</updated></entry>
</feed>"""

        entries = INGEST.parse_entries(feed)

        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0][0], "南海トラフ地震関連解説情報")
        self.assertEqual(entries[0][1], "https://example.invalid/a.xml")


if __name__ == "__main__":
    unittest.main()
