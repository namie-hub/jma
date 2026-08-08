"""Contract tests for scripts/archive_typhoon_forecasts.py.

The archiver's value is entirely in what it refuses to do: it must not
re-append an already-banked bulletin (which would churn a commit every 30
min and corrupt hindsight scoring), and it must not archive a bulletin whose
issue time it cannot read (an undated snapshot is unscoreable and worse than
none). Those two refusals plus the append path are what these tests pin.

fetch_json is monkeypatched, so no network is touched; the output directory
is a per-test tmpdir passed through argv, exactly as the workflow does.
"""
import importlib.util
import io
import json
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


SCRIPT = (Path(__file__).resolve().parents[1] / "scripts"
          / "archive_typhoon_forecasts.py")
SPEC = importlib.util.spec_from_file_location("archive_typhoon_forecasts", SCRIPT)
ARCHIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVER)


def bulletin(issue="2026-08-08T12:00:00Z", tc_id="2618", name="DOLPHIN"):
    """A minimal JMA forecast.json: title dict first, then records."""
    return [
        {"typhoonNumber": tc_id, "name": {"en": name},
         "issue": {"UTC": issue, "JST": "2026-08-08T21:00:00"}},
        {"advancedHours": 0, "center": [27.0, 124.8]},
    ]


class ArchiverTests(unittest.TestCase):
    def _run(self, out_dir, responses):
        """Run main() against a fake JMA, returning captured stdout."""
        def fetch_json(path):
            if path not in responses:
                raise RuntimeError(f"unexpected fetch: {path}")
            value = responses[path]
            if isinstance(value, Exception):
                raise value
            return value

        buf = io.StringIO()
        with mock.patch.object(ARCHIVER, "fetch_json", fetch_json), \
             mock.patch.object(ARCHIVER.sys, "argv",
                               ["archive_typhoon_forecasts.py", out_dir]), \
             redirect_stdout(buf):
            ARCHIVER.main()
        return buf.getvalue()

    def test_no_active_cyclones_writes_nothing(self):
        """Quiet season is a normal success, not an empty-file event."""
        with TemporaryDirectory() as tmp:
            out = self._run(tmp, {"/typhoon/data/targetTc.json": []})

            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertIn("nothing to archive", out)

    def test_new_bulletin_is_archived(self):
        with TemporaryDirectory() as tmp:
            self._run(tmp, {
                "/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2618"}],
                "/typhoon/data/TC2618/forecast.json": bulletin(),
                "/typhoon/data/TC2618/specifications.json": [{"advancedHours": 0}],
            })

            doc = json.loads((Path(tmp) / "tc_TC2618.json").read_text(encoding="utf-8"))
            self.assertEqual(doc["tcId"], "TC2618")
            self.assertEqual(doc["nameEn"], "DOLPHIN")
            self.assertEqual(len(doc["snapshots"]), 1)
            self.assertEqual(doc["snapshots"][0]["issue"], "2026-08-08T12:00:00Z")

    def test_duplicate_bulletin_is_not_reappended(self):
        """Runs between bulletins must leave the file byte-identical: no commit."""
        with TemporaryDirectory() as tmp:
            responses = {
                "/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2618"}],
                "/typhoon/data/TC2618/forecast.json": bulletin(),
                "/typhoon/data/TC2618/specifications.json": None,
            }
            self._run(tmp, responses)
            first = (Path(tmp) / "tc_TC2618.json").read_bytes()

            out = self._run(tmp, responses)

            self.assertEqual((Path(tmp) / "tc_TC2618.json").read_bytes(), first)
            self.assertIn("already archived", out)
            self.assertIn("0 file(s) updated", out)

    def test_second_bulletin_appends_in_issue_order(self):
        with TemporaryDirectory() as tmp:
            base = {"/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2618"}],
                    "/typhoon/data/TC2618/specifications.json": None}
            self._run(tmp, {**base,
                            "/typhoon/data/TC2618/forecast.json":
                                bulletin(issue="2026-08-08T18:00:00Z")})
            self._run(tmp, {**base,
                            "/typhoon/data/TC2618/forecast.json":
                                bulletin(issue="2026-08-08T12:00:00Z")})

            doc = json.loads((Path(tmp) / "tc_TC2618.json").read_text(encoding="utf-8"))
            issues = [s["issue"] for s in doc["snapshots"]]
            self.assertEqual(issues, sorted(issues))
            self.assertEqual(len(issues), 2)

    def test_missing_issue_time_refuses_to_archive(self):
        """An undated snapshot cannot be scored — fail loudly, write nothing."""
        with TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                self._run(tmp, {
                    "/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2618"}],
                    "/typhoon/data/TC2618/forecast.json": [{"name": {"en": "X"}}],
                    "/typhoon/data/TC2618/specifications.json": None,
                })

            self.assertFalse((Path(tmp) / "tc_TC2618.json").exists())

    def test_missing_specifications_is_tolerated(self):
        """Depressions carry no specifications — optional, not fatal."""
        with TemporaryDirectory() as tmp:
            self._run(tmp, {
                "/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2699"}],
                "/typhoon/data/TC2699/forecast.json": bulletin(tc_id="2699", name=""),
                "/typhoon/data/TC2699/specifications.json": RuntimeError("404"),
            })

            doc = json.loads((Path(tmp) / "tc_TC2699.json").read_text(encoding="utf-8"))
            self.assertIsNone(doc["snapshots"][0]["specifications"])

    def test_targetTc_entry_without_id_is_fatal(self):
        with TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                self._run(tmp, {"/typhoon/data/targetTc.json": [{"name": "nope"}]})

    def test_forecast_payload_is_stored_verbatim(self):
        """Hindsight scoring needs the bulletin as issued, not a reduction."""
        with TemporaryDirectory() as tmp:
            fc = bulletin()
            self._run(tmp, {
                "/typhoon/data/targetTc.json": [{"tropicalCyclone": "TC2618"}],
                "/typhoon/data/TC2618/forecast.json": fc,
                "/typhoon/data/TC2618/specifications.json": None,
            })

            doc = json.loads((Path(tmp) / "tc_TC2618.json").read_text(encoding="utf-8"))
            self.assertEqual(doc["snapshots"][0]["forecast"], fc)


if __name__ == "__main__":
    unittest.main()
