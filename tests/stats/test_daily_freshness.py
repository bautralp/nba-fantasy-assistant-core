"""Freshness is game coverage, not the age of the last refresh timestamp."""
from datetime import date, datetime, timezone
import json
import hashlib
import shutil
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from daily_refresh_stats import board_days, completed_games, freshness, run
from refresh_stats import build_snapshot, SEASONS

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests/fixtures/stats'
DAY = date(2026, 10, 23)


def event(key='1', day='2026-10-24T02:00Z', **status):
    return {'id': key, 'date': day, 'season': {'year': 2027, 'type': 2},
            'competitions': [{'type': {'id': '1', 'abbreviation': 'STD'},
                              'competitors': [{'id': '1'}, {'id': '2'}]}],
            'status': {'type': {'completed': True, 'name': 'STATUS_FINAL', **status}}}


class FreshnessTests(unittest.TestCase):
    def test_eastern_cutoff_and_dst_do_not_use_utc_or_turkey_match_date(self):
        self.assertEqual(board_days(datetime(2026, 10, 25, 1, tzinfo=timezone.utc))[-1], date(2026, 10, 23))
        self.assertEqual(board_days(datetime(2026, 11, 2, 14, 23, tzinfo=timezone.utc))[-1], date(2026, 11, 1))
        self.assertEqual(completed_games({'events': [event()]}, DAY, 2027)['1']['date'], DAY.isoformat())

    def test_same_date_hole_and_both_provider_files_stale_are_detected(self):
        boards = {DAY.isoformat(): {'events': [event(), event('2')]}}
        report = freshness(['1'], {}, boards, [DAY], 2027)
        self.assertEqual(report['status'], 'source-lag')
        self.assertEqual(report['missingGameIds'], ['2'])
        self.assertEqual(report['missingGamesByDate'], {'2026-10-23': 1})

    def test_no_games_allstar_cup_preseason_and_postponement_do_not_alarm(self):
        events = [event(completed=False, name='STATUS_POSTPONED')]
        for kind in [('4', 'ALLSTAR'), ('39', 'CC')]:
            e = event(); e['competitions'][0]['type'] = dict(zip(['id', 'abbreviation'], kind)); events.append(e)
        e = event(); e['season']['type'] = 1; events.append(e)
        for rows in [[], events]:
            report = freshness([], {}, {DAY.isoformat(): {'events': rows}}, [DAY], 2027)
            self.assertEqual(report['status'], 'verified')
            self.assertIsNone(report['expectedDataThrough'])

    def test_malformed_unsettled_wrong_day_unknown_types_fail_closed(self):
        cases = [{}, {'events': [event(completed=False, name='STATUS_IN_PROGRESS')]},
                 {'events': [event(day='2026-10-25T02:00Z')]}, {'events': [event(completed='true')]}]
        e = event(); e['competitions'][0]['type']['id'] = '999'; cases.append({'events': [e]})
        e = event(); e['season']['type'] = '2'; cases.append({'events': [e]})
        for board in cases:
            with self.subTest(board=board), self.assertRaises((ValueError, KeyError)):
                completed_games(board, DAY, 2027)

    def test_older_schedule_missing_games_and_unresolved_entries_are_retained(self):
        index = {'1': {'date': '2026-10-01', 'teams': [1, 2], 'excluded': None}}
        board = {DAY.isoformat(): {'events': []}}
        self.assertEqual(freshness([], index, board, [DAY], 2027)['status'], 'source-lag')
        index['1']['excluded'] = 'unplayed'
        self.assertEqual(freshness([], index, board, [DAY], 2027)['status'], 'unknown')

    def test_schedule_team_disagreement_fails(self):
        index = {'1': {'date': DAY.isoformat(), 'teams': [1, 3], 'excluded': None}}
        with self.assertRaisesRegex(ValueError, 'disagreement'):
            freshness(['1'], index, {DAY.isoformat(): {'events': [event()]}}, [DAY], 2027)


class DailyIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.args = SimpleNamespace(output=root/'stats.json', cache_dir=root/'cache', report=root/'report.json',
                                    input_dir=FIXTURES, scoreboard_dir=root/'boards')
        self.now = datetime(2026, 10, 22, 14, 23, tzinfo=timezone.utc)
        self.args.scoreboard_dir.mkdir()
        for day in board_days(self.now):
            (self.args.scoreboard_dir/f'espn-{day:%Y%m%d}.json').write_text('{"events": []}')
        contents = {s: (FIXTURES/f'player_box_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
        schedules = {s: (FIXTURES/f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
        self.original = json.dumps(build_snapshot(contents, self.now.date(), 'old-refresh', schedules)).encode()
        self.args.output.write_bytes(self.original)

    def invoke(self):
        with patch('builtins.print'):
            code = run(self.args, self.now)
        return code, json.loads(self.args.report.read_text())

    def test_no_new_games_is_explicit_and_validated_cache_is_available(self):
        code, report = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(report['status'], 'no-new-games')
        self.assertEqual(report['newGames'], 0)
        self.assertEqual(report['candidate']['dataThrough'], '2026-10-21')
        self.assertEqual(len(list(self.args.cache_dir.iterdir())), 4)

    def test_genuine_new_games_are_counted_against_previous_coverage(self):
        contents = {s: (FIXTURES/f'player_box_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
        schedules = {s: (FIXTURES/f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
        older = build_snapshot(contents, date(2026, 10, 20), 'old-refresh', schedules)
        self.args.output.write_text(json.dumps(older))
        code, report = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(report['status'], 'updated')
        self.assertEqual(report['newGames'], 11)
        self.assertEqual(report['candidate']['games'], 14)
        self.assertEqual(report['previous']['dataThrough'], '2026-10-20')

    def test_lag_preserves_exact_bytes_and_prevents_ros_cache(self):
        e = event('999', day='2026-10-21T23:00Z')
        (self.args.scoreboard_dir/'espn-20261021.json').write_text(json.dumps({'events': [e]}))
        code, report = self.invoke()
        self.assertEqual(code, 42)
        self.assertFalse(report['published'])
        self.assertEqual(report['freshness']['missingGameIds'], ['999'])
        self.assertEqual(self.args.output.read_bytes(), self.original)
        self.assertFalse(self.args.cache_dir.exists())

    def test_missing_independent_evidence_or_provider_failure_preserves_bytes(self):
        (self.args.scoreboard_dir/'espn-20261021.json').unlink()
        for failure in [False, True]:
            with patch('daily_refresh_stats.inventory', side_effect=ValueError('bad source')) if failure else patch('builtins.print'):
                code, report = self.invoke()
            self.assertEqual(code, 1)
            self.assertEqual(report['status'], 'unknown')
            self.assertEqual(self.args.output.read_bytes(), self.original)
            self.assertFalse(self.args.cache_dir.exists())

    def test_regression_still_blocks_publication(self):
        old = json.loads(self.original); old['asOf'] = '2026-10-23'
        self.original = json.dumps(old).encode(); self.args.output.write_bytes(self.original)
        code, report = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn('newer snapshot', report['error'])
        self.assertEqual(self.args.output.read_bytes(), self.original)


class RealDailySourceTests(unittest.TestCase):
    def test_october_24_finals_missing_in_latest_provider_preserve_verified_snapshot(self):
        evidence = ROOT / 'tests/fixtures/freshness'
        provenance = json.loads((evidence/'provenance.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for year in [2026, 2027]:
                for prefix in ['player_box', 'nba_schedule']:
                    name = f'{prefix}_{year}.parquet'
                    source = evidence/name if year == 2027 else FIXTURES/name
                    shutil.copyfile(source, root/name)
                    if year == 2027:
                        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), provenance[name]['sha256'])
            for path in evidence.glob('espn-*.json'):
                self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), provenance[path.name]['fixtureSha256'])
            contents = {s: (root/f'player_box_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
            schedules = {s: (root/f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
            output = root/'stats.json'
            output.write_text(json.dumps(build_snapshot(contents, date(2026, 10, 22), 'verified-before-lag', schedules)))
            original = output.read_bytes()
            args = SimpleNamespace(input_dir=root, scoreboard_dir=evidence, output=output,
                                   cache_dir=root/'cache', report=root/'report.json')
            with patch('builtins.print'):
                code = run(args, datetime(2026, 10, 25, 8, 50, tzinfo=timezone.utc))
            report = json.loads(args.report.read_text())
            self.assertEqual(code, 42)
            self.assertEqual(report['sources']['2026-27']['dataThrough'], '2026-10-23')
            self.assertEqual(report['sources']['2026-27']['games'], 28)
            self.assertEqual(report['sources']['2025-26']['games'], 1230)
            self.assertEqual(report['previous']['games'], 16)
            self.assertEqual(report['newGames'], 12)
            self.assertEqual(report['freshness']['expectedCompletedGames'], 36)
            self.assertEqual(report['freshness']['missingGamesByDate'], {'2026-10-24': 8})
            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(args.cache_dir.exists())


if __name__ == '__main__':
    unittest.main()
