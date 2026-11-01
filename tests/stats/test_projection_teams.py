"""Current catalog team display must not alter any numerical ROS behavior."""
from copy import deepcopy
from datetime import date
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
from espn_teams import ESPN_TEAM_ABBREVIATIONS, catalog_team_name
from fantasy_positions import URL
from generate_projections import build
from refresh_projection_team_labels import update_labels, without_teams
from verify_projection_team_change import audit
from test_ros_model import games


def catalog(team=27):
    return {'schemaVersion': 1, 'season': '2026-27', 'players': [
        {'playerId': '1', 'name': 'Player', 'season': '2026-27', 'positions': ['PG'],
         'provider': 'ESPN Fantasy FBA', 'source': URL+'kona_player_info',
         'retrievedAt': '2026-10-22T00:00:00Z', 'status': 'verified', 'proTeamId': team}]}


class ProjectionTeamTests(unittest.TestCase):
    def generate(self, cat=None, previous=None, current=None, legacy=False):
        cat = cat if cat is not None else catalog()
        previous, current = previous or [], current or []
        for row in previous+current: row['team'] = 'ATL' if row['teamId'] == 1 else 'BOS'
        with patch('generate_projections.schedule_index', return_value={}), \
             patch('generate_projections.projection_games', side_effect=[current, previous]), \
             patch('generate_projections.coverage', return_value={'teamGames': {'1': 3, '2': 3, '27': 3}}), \
             patch('generate_projections.remaining_schedule', return_value={1: 79, 2: 79, 27: 79}):
            data = self.build(cat)
            if legacy:
                # Explicit historical display-only fixture. The new identity
                # resolver no longer calls the old label helper, so mocking that
                # unused function would make the migration regression vacuous.
                for row in data['players']:
                    if row['role']['current']['gp'] == 0:
                        row['team'] = 'Unknown'
            return data

    def build(self, cat):
        return build({'2026-27': b'current', '2025-26': b'previous'}, {'2026-27': b'c', '2025-26': b'p'},
                     date(2026, 10, 22), '2026-10-22T12:00:00Z', cat,
                     ({'profiles': {}}, {'enabled': False, 'version': 'disabled'}))

    def test_zero_gp_verified_current_team(self):
        row = self.generate()['players'][0]
        self.assertEqual((row['team'], row['teamId']), ('WSH', 27))

    def test_old_team_is_not_used_when_current_team_differs(self):
        row = self.generate(previous=games(40, team=1, start='2025-10-01'))['players'][0]
        self.assertEqual(row['team'], 'WSH')
        self.assertEqual(row['role']['previous']['gp'], 40)
        self.assertEqual(row['role']['current']['gp'], 0)

    def test_no_team_zero_invalid_missing_and_wrong_types_have_no_history_fallback(self):
        for value in (-1, 31, 999, None, '27', 27.0, True):
            with self.subTest(team=value):
                row = self.generate(cat=catalog(value), previous=games(40, team=1, start='2025-10-01'))['players'][0]
                self.assertEqual(row['team'], 'Unknown')
        cat = catalog(); del cat['players'][0]['proTeamId']
        self.assertEqual(self.generate(cat=cat)['players'][0]['team'], 'Unknown')

    def test_newer_verified_catalog_supersedes_observed_old_game_team(self):
        row = self.generate(cat=catalog(27), current=games(6, team=2))['players'][0]
        self.assertEqual((row['team'], row['teamId']), ('WSH', 27))
        self.assertTrue(row['teamIdentity']['changedSinceLastGame'])

    def test_name_mismatch_rejects_catalog_team(self):
        cat = catalog(); cat['players'][0]['name'] = 'Wrong name'
        data = self.generate(cat=cat, previous=games(40, team=1, start='2025-10-01'))
        row = data['players'][0]
        self.assertEqual(row['team'], 'Unknown')
        self.assertIsNone(row['teamId'])
        self.assertEqual(len(data['positionReport']['mismatches']), 1)

    def test_wrong_id_is_not_joined_by_matching_name(self):
        cat = catalog(); cat['players'][0]['playerId'] = '2'
        data = self.generate(cat=cat, previous=games(40, team=1, start='2025-10-01'))
        row = next(r for r in data['players'] if r['id'] == '1')
        self.assertEqual(row['team'], 'Unknown')
        self.assertIsNone(row['teamId'])
        self.assertEqual(catalog_team_name('1', cat['players'][0]), 'Unknown')

    def test_unverified_or_non_espn_source_does_not_assign_team(self):
        for changes in ({'provider': 'Manual'}, {'source': 'https://example.test/'}, {'status': 'unresolved', 'positions': []}):
            cat = catalog(); cat['players'][0].update(changes)
            self.assertEqual(self.generate(cat=cat)['players'][0]['team'], 'Unknown')

    def test_all_values_other_than_team_match_old_behavior(self):
        for past, current in (([], []), (games(40, start='2025-10-01'), []), (games(40, start='2025-10-01'), games(6))):
            old = self.generate(previous=deepcopy(past), current=deepcopy(current), legacy=True)
            new = update_labels(deepcopy(old), catalog())
            if not current:
                self.assertNotEqual(old['players'][0]['team'], new['players'][0]['team'])
            for row in new['players']: row['team'] = next(p['team'] for p in old['players'] if p['id'] == row['id'])
            self.assertEqual(new, old)  # includes GP, statuses, eligibility, stats, ranks and pool

    def test_espn_mapping_namespace_and_non_alphabetical_anchors(self):
        self.assertEqual(set(ESPN_TEAM_ABBREVIATIONS), set(range(1, 31)))
        self.assertEqual({i: ESPN_TEAM_ABBREVIATIONS[i] for i in (3, 9, 17, 18, 24, 25, 26, 27, 30)},
                         {3: 'NO', 9: 'GS', 17: 'BKN', 18: 'NY', 24: 'SA', 25: 'OKC', 26: 'UTAH', 27: 'WSH', 30: 'CHA'})
        self.assertEqual(len(set(ESPN_TEAM_ABBREVIATIONS.values())), 30)

    def test_existing_snapshot_label_migration_is_idempotent_and_only_team_changes(self):
        old = self.generate(previous=games(40, start='2025-10-01'), legacy=True)
        new = update_labels(old, catalog())
        self.assertEqual(new['players'][0]['team'], 'WSH')
        self.assertEqual(without_teams(old), without_teams(new))
        self.assertEqual(update_labels(new, catalog()), new)
        mismatch = catalog(); mismatch['players'][0]['name'] = 'Wrong name'
        self.assertEqual(update_labels(old, mismatch)['players'][0]['team'], 'Unknown')
        wrong_id = catalog(); wrong_id['players'][0]['playerId'] = '2'
        self.assertEqual(update_labels(old, wrong_id)['players'][0]['team'], 'Unknown')

    def test_label_migration_never_overrides_current_game(self):
        old = self.generate(current=games(6, team=2))
        self.assertEqual(update_labels(old, catalog(27)), old)

    def test_audit_refuses_numeric_status_ranking_or_eligibility_changes(self):
        old = self.generate(previous=games(40, start='2025-10-01'), legacy=True)
        new = update_labels(old, catalog())
        for key, value in [('rosGP', 999), ('rank', 1), ('totalZ', 99), ('status', 'unavailable'), ('positions', ['C'])]:
            changed = deepcopy(new)
            changed['players'][0][key] = value
            with self.subTest(field=key), self.assertRaisesRegex(ValueError, 'Non-team'):
                audit(old, changed, catalog())


if __name__ == '__main__': unittest.main()
