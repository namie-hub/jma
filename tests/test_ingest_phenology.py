"""Contract tests for scripts/ingest_phenology.py — fetch resilience and
commit-only-on-change.

Background (30 Sep 2026): the 28 Sep scheduled run died in 25 s on an
unretried JMA fetch, and every successful run committed a byte-identical
payload whose only change was the "generated" date. These tests pin:
  * transient errors (5xx, network) are retried; 4xx is not;
  * a 404 on a history page ends the history loop (fetch_optional -> None),
    but a 5xx/network failure there raises instead of silently truncating;
  * "generated" keeps its old date when the data is unchanged, and moves
    when the data changes — so the workflow's diff check skips no-op runs.
No network: urlopen and sleep are stubbed.
"""
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest_phenology.py"
SPEC = importlib.util.spec_from_file_location("ingest_phenology", SCRIPT)
INGEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INGEST)

URL = "https://www.data.jma.go.jp/sakura/data/sakura003_00.html"


def http_error(code):
    return urllib.error.HTTPError(URL, code, "x", {}, io.BytesIO(b""))


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def scripted(*outcomes):
    """urlopen stub: each call pops the next outcome (exception or body)."""
    seq = list(outcomes)

    def fake(req, timeout=None):
        o = seq.pop(0)
        if isinstance(o, BaseException):
            raise o
        return FakeResp(o.encode("utf-8"))
    return fake


class FetchRetry(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(INGEST.time, "sleep", lambda s: None)
        p.start()
        self.addCleanup(p.stop)

    def run_fetch(self, *outcomes, fn=None):
        with mock.patch.object(INGEST.urllib.request, "urlopen", scripted(*outcomes)) as _:
            return (fn or INGEST.fetch)(URL)

    def test_5xx_then_success_is_retried(self):
        self.assertEqual(self.run_fetch(http_error(503), http_error(502), "ok"), "ok")

    def test_network_error_then_success_is_retried(self):
        self.assertEqual(self.run_fetch(urllib.error.URLError("reset"), TimeoutError(), "ok"), "ok")

    def test_persistent_5xx_raises_after_all_attempts(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.run_fetch(*[http_error(500)] * 4)

    def test_4xx_is_not_retried(self):
        # only one outcome scripted: a retry would pop an empty list -> IndexError
        with self.assertRaises(urllib.error.HTTPError):
            self.run_fetch(http_error(403))

    def test_optional_404_means_no_page(self):
        self.assertIsNone(self.run_fetch(http_error(404), fn=INGEST.fetch_optional))

    def test_optional_5xx_raises_not_truncates(self):
        # the old loop swallowed any exception and silently dropped history
        with self.assertRaises(urllib.error.HTTPError):
            self.run_fetch(*[http_error(503)] * 4, fn=INGEST.fetch_optional)


class StableGenerated(unittest.TestCase):
    PAYLOAD = {"generated": None, "source": "s",
               "stations": {"東京": [35.69, 139.75]},
               "phen": {"sakura_kaika": {"years": {"2026": {"東京": "0319"}}}}}

    def write_js(self, path, generated, payload=None):
        d = dict(payload or self.PAYLOAD, generated=generated)
        Path(path).write_text("/* header */\nconst JMA_PHENOLOGY = "
                              + json.dumps(d, ensure_ascii=False) + ";\n", encoding="utf-8")

    def test_unchanged_data_keeps_old_date(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "jma_phenology.js"
            self.write_js(f, "2026-09-27")
            self.assertEqual(INGEST.stable_generated(f, dict(self.PAYLOAD), "2026-09-30"), "2026-09-27")

    def test_changed_data_takes_today(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "jma_phenology.js"
            self.write_js(f, "2026-09-27")
            new = json.loads(json.dumps(self.PAYLOAD))
            new["phen"]["sakura_kaika"]["years"]["2026"]["東京"] = "0320"
            self.assertEqual(INGEST.stable_generated(f, new, "2026-09-30"), "2026-09-30")

    def test_missing_or_garbled_file_takes_today(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "jma_phenology.js"
            self.assertEqual(INGEST.stable_generated(f, dict(self.PAYLOAD), "2026-09-30"), "2026-09-30")
            f.write_text("not js", encoding="utf-8")
            self.assertEqual(INGEST.stable_generated(f, dict(self.PAYLOAD), "2026-09-30"), "2026-09-30")

    def test_parses_the_committed_file(self):
        # the regex must match the real generated file, or the fix is a no-op
        real = Path(__file__).resolve().parents[1] / "jma_phenology.js"
        if not real.exists():
            self.skipTest("jma_phenology.js not present")
        txt = real.read_text(encoding="utf-8")
        import re
        m = re.search(r'const JMA_PHENOLOGY = (\{.*\});\s*$', txt, re.S)
        self.assertIsNotNone(m)
        prev = json.loads(m.group(1))
        self.assertEqual(INGEST.stable_generated(real, dict(prev, generated=None), "2099-01-01"),
                         prev["generated"])


if __name__ == "__main__":
    unittest.main()
