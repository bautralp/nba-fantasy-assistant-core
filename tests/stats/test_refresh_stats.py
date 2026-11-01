"""Synthetic fixtures only; production snapshots always come from provider Parquet."""
from copy import deepcopy
from datetime import date
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from refresh_stats import FIELDS, parse_games as parse_source_games, aggregate, calendar_window, build_snapshot as build_source_snapshot, publish, main
from parquet_io import read_parquet
from regular_season import schedule_index

AS_OF = date(2026, 10, 22)


def game(day='2026-10-22', **changes):
    result = dict(game_id=1, season=2027, season_type=2, game_date=date.fromisoformat(day),
                  athlete_id=7, athlete_display_name='Test Player', did_not_play=False,
                  team_abbreviation='AAA', team_id=1, opponent_team_id=2, athlete_position_abbreviation='G', minutes=20.0,
                  **dict.fromkeys(FIELDS.values(), 0))
    result.update(changes)
    return result


def parquet(rows):
    output = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows), output)
    return output.getvalue()


def schedule_fixture(content):
    rows = read_parquet(content).to_pylist()
    events = {r['game_id']: dict(game_id=r['game_id'], season=r['season'], season_type=2,
        game_date=r['game_date'], type_id=1, type_abbreviation='STD', notes_headline='',
        home_id=r['team_id'], away_id=r['opponent_team_id'], status_type_completed=True)
        for r in rows}
    return parquet(list(events.values()))


def parse_games(content, season, as_of):
    return parse_source_games(content, season, as_of,
        schedule_index(schedule_fixture(content), int(season[:4])+1, as_of))


def build_snapshot(contents, as_of, refreshed_at):
    # These one-player unit fixtures test aggregation, not full NBA schedules.
    # Unmocked coverage and completed-season rules have real-source tests separately.
    with patch('refresh_stats.coverage', return_value={}):
        return build_source_snapshot(contents, as_of, refreshed_at,
            {s: schedule_fixture(c) for s, c in contents.items()})


def snapshot(rows=None):
    return build_snapshot({'2026-27': parquet(rows or [game()]),
        '2025-26': parquet([game('2026-04-12', season=2026)])}, AS_OF, '2026-10-22T10:23:00+00:00')


class ConversionTests(unittest.TestCase):
    def test_parquet_and_ending_year_mapping(self):
        result = snapshot()
        self.assertEqual(result['periods']['lastSeason']['season'], '2025-26')
        self.assertEqual(result['periods']['season']['season'], '2026-27')
        self.assertTrue(all(s['url'].endswith('.parquet') and len(s['sha256']) == 64 for s in result['sources']))
        self.assertEqual(result['periods']['lastSeason']['dataThrough'], '2026-04-12')

    def test_calendar_boundaries_inclusive_and_not_last_n_games(self):
        # Sparse schedule: last 7 days contains two games, not seven games.
        dates = ['2026-09-22', '2026-09-23', '2026-10-08', '2026-10-09', '2026-10-15', '2026-10-16', '2026-10-22', '2026-10-23']
        data = snapshot([game(day, game_id=i) for i, day in enumerate(dates)])['periods']
        self.assertEqual(data['season']['players'][0]['gp'], 7)
        self.assertEqual(data['last7']['players'][0]['gp'], 2)
        self.assertEqual(data['last14']['players'][0]['gp'], 4)
        self.assertEqual(data['last30']['players'][0]['gp'], 6)
        self.assertEqual(data['last7']['from'], '2026-10-16')

    def test_excludes_dnp_preseason_postseason_playin_future(self):
        rows = [game(), game(game_id=2, did_not_play=True), game(game_id=3, season_type=1),
                game(game_id=4, season_type=3), game(game_id=5, season_type=5), game('2026-10-23', game_id=6)]
        self.assertEqual(snapshot(rows)['periods']['season']['players'][0]['gp'], 1)

    def test_source_placeholder_not_counted_as_gp(self):
        rows = [game(), game(game_id=2, minutes=None), game(game_id=3, minutes=None, athlete_id=None, athlete_display_name=None)]
        self.assertEqual(snapshot(rows)['periods']['season']['players'][0]['gp'], 1)

    def test_zero_minutes_with_recorded_participation_counts(self):
        self.assertEqual(snapshot([game(minutes=0)])['periods']['season']['players'][0]['gp'], 1)

    def test_trade_merges_by_id_and_same_name_different_ids_stay_separate(self):
        rows = [game('2026-10-21', field_goals_made=1, field_goals_attempted=2, points=4),
                game(game_id=2, team_abbreviation='BBB', field_goals_made=9, field_goals_attempted=18, points=20),
                game(game_id=3, athlete_id=8)]
        players = snapshot(rows)['periods']['season']['players']
        p = next(p for p in players if p['id'] == '7')
        self.assertEqual(len(players), 2)
        self.assertEqual(p['gp'], 2)
        self.assertEqual(p['team'], 'BBB')
        self.assertEqual(p['totals']['PTS'], 24)
        self.assertEqual(p['stats']['PTS'], 12)
        self.assertEqual(p['stats']['FG%'], 50)

    def test_percentages_are_ratio_of_sums_and_zero_attempts_are_null(self):
        rows = [game(field_goals_made=1, field_goals_attempted=1, free_throws_made=1, free_throws_attempted=1),
                game(game_id=2, field_goals_made=0, field_goals_attempted=9, free_throws_made=0, free_throws_attempted=3)]
        p = snapshot(rows)['periods']['season']['players'][0]
        self.assertEqual(p['stats']['FG%'], 10)
        self.assertEqual(p['stats']['FT%'], 25)
        zero = snapshot()['periods']['season']['players'][0]
        self.assertIsNone(zero['stats']['FG%'])
        self.assertIsNone(zero['stats']['FT%'])

    def test_exact_duplicates_not_double_counted_conflicts_rejected(self):
        self.assertEqual(snapshot([game(), game()])['periods']['season']['players'][0]['gp'], 1)
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate'):
            snapshot([game(), game(points=1)])

    def test_corrupt_parquet_missing_columns_wrong_season_and_empty_rejected(self):
        for content in [b'bad parquet', parquet([{'season': 2027}]), parquet([game(season=2026)]), parquet([game(did_not_play=True)])]:
            with self.subTest(content=content[:20]), self.assertRaises(Exception):
                parse_source_games(content, '2026-27', AS_OF, {})

    def test_invalid_stats_and_identity_rejected(self):
        for changes in [dict(points=None), dict(points=-1), dict(points=float('nan')),
                        dict(points=1.5), dict(field_goals_made=1), dict(free_throws_made=1),
                        dict(three_point_field_goals_made=1), dict(athlete_id=None),
                        dict(did_not_play=None), dict(minutes=None, points=1), dict(minutes=-1)]:
            with self.subTest(changes=changes), self.assertRaises((ValueError, TypeError)):
                snapshot([game(**changes)])

    def test_empty_calendar_window_is_valid_and_aggregation_is_independent(self):
        result = snapshot([game('2026-10-01')])
        self.assertEqual(result['periods']['last7']['players'], [])
        self.assertIsNone(result['periods']['last7']['dataThrough'])
        games = parse_games(parquet([game()]), '2026-27', AS_OF)
        self.assertEqual(aggregate(calendar_window(games, AS_OF, AS_OF))[0]['gp'], 1)

    def test_rolling_window_after_season_end_remains_valid_empty_calendar_range(self):
        result = build_snapshot({'2026-27': parquet([game()]),
            '2025-26': parquet([game('2026-04-12', season=2026)])},
            date(2027, 8, 1), '2027-08-01T10:23:00+00:00')
        for key in ['last7', 'last14', 'last30']:
            p = result['periods'][key]
            self.assertLessEqual(p['from'], p['to'])
            self.assertEqual(p['to'], '2027-08-01')
            self.assertEqual(p['players'], [])
        self.assertEqual(result['periods']['season']['to'], '2027-06-30')

    def test_atomic_write_and_failed_replace_preserve_previous_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stats.json'
            publish(snapshot(), output)
            original = output.read_bytes()
            with patch('refresh_stats.os.replace', side_effect=OSError('disk error')), self.assertRaises(OSError):
                publish(snapshot(), output)
            self.assertEqual(output.read_bytes(), original)
            self.assertEqual(list(Path(directory).iterdir()), [output])
            self.assertEqual(json.loads(original)['schemaVersion'], 1)

    def test_coverage_regression_and_lost_player_games_preserve_previous(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stats.json'
            publish(snapshot([game('2026-10-21'), game(game_id=2)]), output)
            original = output.read_bytes()
            for candidate in [snapshot([game('2026-10-21')]), snapshot([game()])]:
                with self.assertRaises(ValueError):
                    publish(candidate, output)
                self.assertEqual(output.read_bytes(), original)

    def test_older_snapshot_preserves_previous(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stats.json'
            publish(snapshot(), output)
            original = output.read_bytes()
            old = deepcopy(snapshot()); old['asOf'] = '2026-10-21'
            with self.assertRaises(ValueError):
                publish(old, output)
            self.assertEqual(output.read_bytes(), original)

    def test_network_failure_does_not_publish_or_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'stats.json'
            publish(snapshot(), output)
            original = output.read_bytes()
            with patch.object(sys, 'argv', ['refresh_stats.py', '--output', str(output)]), patch('refresh_stats.urlopen', side_effect=OSError('network failure')), self.assertRaises(OSError):
                main()
            self.assertEqual(output.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
