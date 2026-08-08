import contextlib
import importlib.util
import io
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "ingest_hko_tctrack.py"
SPEC = importlib.util.spec_from_file_location("ingest_hko_tctrack", SCRIPT)
INGEST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INGEST)


def track_xml(*, forecast=""):
    return f"""\
<TropicalCycloneTrack>
  <BulletinHeader><BulletinTime>2026-08-08T15:30:27+08:00</BulletinTime></BulletinHeader>
  <WeatherReport>
    <PastInformation>
      <Index>1</Index><Time>2026-08-08T00:00:00+00:00</Time>
      <Latitude>19.70N</Latitude><Longitude>108.90E</Longitude>
    </PastInformation>
    <AnalysisInformation>
      <Intensity>Low Pressure Area</Intensity><MaximumWind>40km/h</MaximumWind>
      <Time>2026-08-08T06:00:00+00:00</Time>
      <Latitude>19.50N</Latitude><Longitude>109.30E</Longitude>
    </AnalysisInformation>
    {forecast}
  </WeatherReport>
</TropicalCycloneTrack>
""".encode()


class ParseTrackTests(unittest.TestCase):
    def test_accepts_analysis_only_track(self):
        with contextlib.redirect_stderr(io.StringIO()):
            track = INGEST.parse_track(track_xml(), "2622")

        self.assertEqual(track["forecast"], [])
        self.assertEqual(track["analysis"]["intensity"], "Low Pressure Area")
        self.assertEqual(track["past"][0]["i"], 1)

    def test_keeps_forecast_points_when_present(self):
        forecast = """
        <ForecastInformation>
          <Index>24</Index><Intensity>Tropical Storm</Intensity>
          <Time>2026-08-09T06:00:00+00:00</Time>
          <Latitude>20.50N</Latitude><Longitude>110.30E</Longitude>
        </ForecastInformation>
        """

        track = INGEST.parse_track(track_xml(forecast=forecast), "2622")

        self.assertEqual(track["forecast"][0]["i"], 24)
        self.assertEqual(track["forecast"][0]["intensity"], "Tropical Storm")

    def test_analysis_only_track_is_logged_not_silent(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            INGEST.parse_track(track_xml(), "2622")

        self.assertIn("no forecast track", err.getvalue())
        self.assertIn("2622", err.getvalue())

    def test_still_rejects_missing_analysis(self):
        xml = track_xml().replace(b"<AnalysisInformation>", b"<Removed>")
        xml = xml.replace(b"</AnalysisInformation>", b"</Removed>")

        with self.assertRaisesRegex(ValueError, "missing AnalysisInformation"):
            INGEST.parse_track(xml, "2622")


class FetchRetryTests(unittest.TestCase):
    """A transient 5xx must not fail the leg; a 4xx must fail immediately."""

    def _run_fetch(self, urlopen):
        err = io.StringIO()
        with mock.patch.object(INGEST.urllib.request, "urlopen", urlopen), \
             mock.patch.object(INGEST.time, "sleep", lambda _s: None), \
             contextlib.redirect_stderr(err):
            try:
                return INGEST.fetch("https://example.invalid/tc.xml"), err.getvalue()
            except urllib.error.HTTPError:
                raise

    def test_retries_5xx_then_succeeds(self):
        calls = []

        def urlopen(req, timeout=None):
            calls.append(req.full_url)
            if len(calls) < 3:
                raise urllib.error.HTTPError(req.full_url, 503,
                                             "Service Unavailable", {}, None)
            return io.BytesIO(b"<ok/>")

        body, log = self._run_fetch(urlopen)

        self.assertEqual(body, b"<ok/>")
        self.assertEqual(len(calls), 3)
        self.assertIn("HTTP 503", log)

    def test_gives_up_after_last_attempt(self):
        calls = []

        def urlopen(req, timeout=None):
            calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 502, "Bad Gateway", {}, None)

        with self.assertRaises(urllib.error.HTTPError):
            self._run_fetch(urlopen)
        self.assertEqual(len(calls), 3)

    def test_does_not_retry_4xx(self):
        calls = []

        def urlopen(req, timeout=None):
            calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

        with self.assertRaises(urllib.error.HTTPError):
            self._run_fetch(urlopen)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
