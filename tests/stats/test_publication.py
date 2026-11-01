"""Publication success requires matching live statistics AND timestamps."""
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from verify_published_stats import verify_published


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.snapshot = Path(self.directory.name) / 'snapshot.json'
        self.data = {'refreshedAt': '2026-10-22T10:23:00Z', 'periods': {'lastSeason': {'GP': 65}}}
        self.snapshot.write_text(json.dumps(self.data))

    def test_success_requires_full_payload_match_but_allows_json_whitespace(self):
        with patch('verify_published_stats.urlopen', return_value=io.BytesIO(json.dumps(self.data, indent=2).encode())) as fetch:
            verify_published(self.snapshot, 'https://example.test/data/player-stats.json', timeout=0)
        self.assertIn('snapshot_sha256=', fetch.call_args.args[0].full_url)

    def test_old_timestamp_wrong_statistics_html_and_http_failure_are_not_success(self):
        for value in [{**self.data, 'refreshedAt': '2026-10-21T10:23:00Z'},
                      {**self.data, 'periods': {'lastSeason': {'GP': 66}}}, '<html>old site</html>']:
            body = value if isinstance(value, str) else json.dumps(value)
            with self.subTest(value=value), patch('verify_published_stats.urlopen', return_value=io.BytesIO(body.encode())), self.assertRaises(RuntimeError):
                verify_published(self.snapshot, 'https://example.test/data/player-stats.json', timeout=0)
        with patch('verify_published_stats.urlopen', side_effect=URLError('unavailable')), self.assertRaises(RuntimeError):
            verify_published(self.snapshot, 'https://example.test/data/player-stats.json', timeout=0)

    def test_delayed_deployment_is_rechecked_then_verified(self):
        with patch('verify_published_stats.urlopen', side_effect=[io.BytesIO(b'{}'), io.BytesIO(json.dumps(self.data).encode())]), patch('verify_published_stats.time.sleep') as sleep:
            verify_published(self.snapshot, 'https://example.test/data/player-stats.json', timeout=60)
        self.assertEqual(sleep.call_count, 1)
