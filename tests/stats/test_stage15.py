"""Source-derived MPG and display-only roster evidence regressions."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from refresh_stats import aggregate
from refresh_rosters import build_rosters, ESPN_TEAM_ABBREVIATIONS
from test_refresh_stats import snapshot, game

class MPGTests(unittest.TestCase):
    def test_independent_period_minutes_and_zero_minutes(self):
        result = snapshot([game('2026-10-01', game_id=1, minutes=40), game('2026-10-22', game_id=2, minutes=10)])
        self.assertEqual(result['periods']['season']['players'][0]['mpg'], 25)
        self.assertEqual(result['periods']['last7']['players'][0]['mpg'], 10)
        self.assertEqual(snapshot([game(minutes=0)])['periods']['season']['players'][0]['mpg'], 0)
        self.assertEqual(aggregate([]), [])

    def test_missing_invalid_and_conflicting_minutes_fail(self):
        for minutes in (None, -1, float('nan'), float('inf')):
            with self.subTest(minutes=minutes), self.assertRaises((ValueError, TypeError)):
                snapshot([game(minutes=minutes, points=1)])
        with self.assertRaisesRegex(ValueError, 'Conflicting duplicate'):
            snapshot([game(minutes=10), game(minutes=20)])

class RosterTests(unittest.TestCase):
    def setUp(self):
        self.contents = {i: json.dumps({'timestamp': '2026-10-23T00:00:00Z', 'status': 'success', 'season': {'year': 2027, 'type': 2},
            'team': {'id': str(i), 'abbreviation': abbr},
            'athletes': [{'id': str(10000+i), 'displayName': f'Player {i}', 'status': {'type': 'active'}}]}).encode()
            for i, abbr in ESPN_TEAM_ABBREVIATIONS.items()}

    def test_roster_membership_source_is_explicit_not_fantasy_team_association(self):
        result = build_rosters(self.contents, '2026-10-23T00:00:00Z')
        self.assertEqual(len(result['players']), 30)
        self.assertEqual(len(result['sources']), 30)
        self.assertTrue(all('/roster?season=2027' in p['source'] for p in result['players']))

    def test_incomplete_wrong_season_unknown_team_and_duplicate_ids_rejected(self):
        incomplete = dict(self.contents); incomplete.pop(1)
        with self.assertRaises(ValueError): build_rosters(incomplete, '2026-10-23T00:00:00Z')
        for patch in ({'timestamp': '2026-10-01T00:00:00Z'}, {'timestamp': '2026-10-24T00:00:00Z'}, {'season': {'year': 2026, 'type': 2}}, {'team': {'id': '0', 'abbreviation': 'ATL'}}, {'athletes': []}):
            bad = dict(self.contents); row = json.loads(bad[1]); row.update(patch); bad[1] = json.dumps(row).encode()
            with self.subTest(patch=patch), self.assertRaises(ValueError): build_rosters(bad, '2026-10-23T00:00:00Z')
        bad = dict(self.contents); row = json.loads(bad[2]); row['athletes'][0]['id']='10001';bad[2]=json.dumps(row).encode()
        with self.assertRaises(ValueError): build_rosters(bad, '2026-10-23T00:00:00Z')
