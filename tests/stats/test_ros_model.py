import copy
from datetime import date, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from ros_model import project, role_model, expected_gp, projection_games, remaining_schedule
from regular_season import schedule_index
from fantasy_positions import validate_catalog, parse_api, refresh, DEFAULT_MAPPING, fetch_api
from generate_projections import publish
from backtest_projections import evaluate


def games(n, minutes=20, starter=False, team=1, start='2026-10-01'):
    beginning = date.fromisoformat(start)
    return [{'id': '1', 'name': 'Player', 'date': (beginning + timedelta(days=i)).isoformat(), 'gameId': str(i),
             'teamId': team, 'minutes': minutes, 'starter': starter,
             'stats': {'FGM': 5, 'FGA': 10, '3PM': 1, '3PA': 3, 'FTM': 2, 'FTA': 3, 'PTS': 13, 'REB': 4, 'AST': 3, 'STL': 1, 'BLK': 1, 'TO': 2}} for i in range(n)]


def catalog(positions=None):
    return {'schemaVersion': 1, 'season': '2026-27', 'players': [{'playerId': '1', 'name': 'Player', 'season': '2026-27',
            'positions': positions or ['PG', 'SG'], 'provider': 'Test manual', 'source': 'https://example.test/verified',
            'retrievedAt': '2026-10-22T00:00:00Z', 'status': 'verified'}]}


class ROSModelTests(unittest.TestCase):
    def test_structural_role_and_small_sample(self):
        past = games(40)
        self.assertGreater(role_model(past, games(10, 30, True))['score'], 0)
        self.assertEqual(role_model(past, games(1, 48, True))['score'], 0)
        self.assertIn('İlk beşe yükselme', role_model(past, games(10, 20, True))['labels'])
        self.assertLess(role_model(games(40, 30, True), games(10, 12))['score'], 0)

    def test_one_outlier_is_not_persistent(self):
        current = games(10)
        current[-1]['minutes'] = 48
        current[-1]['stats']['FGA'] = 100
        current[-1]['stats']['3PA'] = 50
        self.assertEqual(role_model(games(40), current)['score'], 0)

    def test_trade_and_missing_starters(self):
        role = role_model(games(30), games(3, team=2))
        self.assertTrue(role['teamChange'])
        self.assertEqual(role['newTeamGames'], 3)
        self.assertEqual(project(games(30), games(3, team=2))['confidence'], 'low')
        rows = games(10)
        for r in rows: r['starter'] = None
        self.assertIsNone(role_model([], rows)['current']['starterRate'])

    def test_rookie_low_gp_no_current_and_shooting(self):
        self.assertEqual(project([], games(1))['status'], 'unavailable')
        self.assertEqual(project([], [])['status'], 'unavailable')
        self.assertEqual(project([], games(8))['confidence'], 'low')
        for previous, current in [(games(40), games(10, 30)), (games(40), []), ([], games(8))]:
            result = project(previous, current)
            stats = result['stats']
            self.assertLessEqual(stats['FGM'], stats['FGA'])
            self.assertLessEqual(stats['3PM'], stats['FGM'])
            self.assertLessEqual(stats['3PM'], result['shooting']['3P']['attempts'])
            self.assertLessEqual(stats['FTM'], stats['FTA'])
            self.assertAlmostEqual(stats['PTS'], 2 * stats['FGM'] + stats['3PM'] + stats['FTM'])
            self.assertTrue(all(v >= 0 for v in stats.values()))
        rows = games(10)
        for row in rows: del row['stats']['3PA']
        self.assertEqual(project([], rows)['reason'], 'Kaynakta 3PA yok')

    def test_rates_not_single_multiplier(self):
        past, current = games(40), games(10, 30, True)
        current[0]['stats']['STL'] = 3
        role, plain = project(past, current), project(past, current, use_role=False)
        self.assertAlmostEqual(role['stats']['STL'] / role['minutes'], plain['stats']['STL'] / plain['minutes'])

    def test_chronology(self):
        self.assertEqual(project(games(40), games(10)), project(list(reversed(games(40))), list(reversed(games(10)))))

    def test_gp_and_no_injury_return_invention(self):
        self.assertEqual(expected_gp(games(82), games(10), 0, 10), 0)
        self.assertLess(expected_gp(games(20), [], 70, 10), expected_gp(games(82), games(10), 70, 10))
        self.assertLessEqual(expected_gp([], games(10), 70, 10), 70)

    def test_positions_forbid_general_slots_and_duplicate_ids(self):
        validate_catalog(catalog())
        for positions in [['G'], ['F'], ['UTIL'], ['BENCH'], ['IR'], ['PG', 'PG']]:
            with self.assertRaises(ValueError): validate_catalog(catalog(positions))
        duplicate = catalog(); duplicate['players'] *= 2
        with self.assertRaises(ValueError): validate_catalog(duplicate)
        with self.assertRaises(ValueError): parse_api([], {'sport': 'football'}, '2026-10-22T00:00:00Z')

    def test_api_fixture_requires_basketball_evidence_and_real_id_anchors(self):
        # Synthetic schema fixture, not evidence of live API access or slot mapping.
        payload = [{'id': key, 'fullName': name, 'defaultPositionId': 1, 'eligibleSlots': [90, 91, 92], 'proTeamId': 1}
                   for key, name in [(3112335, 'Nikola Jokic'), (4432166, 'Cade Cunningham'), (4871145, 'Josh Giddey')]]
        mapping = {'sport': 'fba', 'season': 2027, 'evidence': 'synthetic test only', 'slots': {'90': 'PG', '91': 'SG', '92': 'UTIL'}}
        parsed = parse_api(payload, mapping, '2026-10-22T00:00:00Z')
        self.assertEqual(parsed['players'][0]['positions'], ['PG', 'SG'])
        payload[0]['id'] = 111
        with self.assertRaises(ValueError): parse_api(payload, mapping, '2026-10-22T00:00:00Z')

    def test_failed_refresh_preserves_catalog_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'catalog.json'
            output.write_text(json.dumps(catalog()))
            old = output.read_bytes()
            with self.assertRaises(ValueError): refresh(output, mapping=None)
            self.assertEqual(output.read_bytes(), old)

    def test_live_fba_fixture_specific_slots_and_inactive_records(self):
        root = Path(__file__).resolve().parents[1] / 'fixtures/fantasy'
        payload = json.loads((root / 'players-2027.json').read_text())
        mapping = json.loads(DEFAULT_MAPPING.read_text())
        result = parse_api(payload, mapping, '2026-10-22T19:16:00Z')
        rows = {r['playerId']: r for r in result['players']}
        self.assertEqual(rows['3112335']['positions'], ['C'])
        self.assertEqual(rows['4432166']['positions'], ['PG'])
        self.assertEqual(rows['4871145']['positions'], ['PG', 'SG'])
        self.assertEqual(len(rows), 4)
        payload[0]['eligibleSlots'].append(999)
        with self.assertRaisesRegex(ValueError, 'Unmapped FBA slot'):
            parse_api(payload, mapping, '2026-10-22T19:16:00Z')

    def test_default_refresh_fetches_full_pool_and_retains_bytes_on_failure(self):
        root = Path(__file__).resolve().parents[1] / 'fixtures/fantasy'
        payload = json.loads((root / 'players-2027.json').read_text())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'catalog.json'
            with patch('fantasy_positions.fetch_api', return_value=(payload, 'a' * 64)):
                refresh(output)
            old = output.read_bytes()
            self.assertEqual(json.loads(old)['sourceSha256'], 'a' * 64)
            with patch('fantasy_positions.fetch_api', side_effect=ValueError('incomplete')):
                with self.assertRaises(ValueError): refresh(output)
            self.assertEqual(output.read_bytes(), old)

    def test_small_default_api_page_is_rejected(self):
        with patch('fantasy_positions.urlopen') as opened:
            opened.return_value.__enter__.return_value.read.return_value = b'[]'
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                fetch_api()
            request = opened.call_args.args[0]
            self.assertEqual(json.loads(request.get_header('X-fantasy-filter'))['players']['limit'], 5000)

    def test_failed_projection_validation_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'projections.json'
            path.write_text('{"asOf":"2026-10-22","players":[]}')
            old = path.read_bytes()
            with patch('generate_projections.subprocess.run', side_effect=RuntimeError('validator failed')):
                with self.assertRaises(RuntimeError): publish({'asOf': '2026-10-22', 'players': []}, path)
            self.assertEqual(path.read_bytes(), old)

    def test_walk_forward_never_passes_future_to_model(self):
        rows = games(70, start='2025-10-01')
        from ros_model import project as original
        def checked(previous, current, **kwargs):
            self.assertTrue(all(g['date'] <= '2025-11-15' for g in previous + current))
            return original(previous, current, **kwargs)
        with patch('backtest_projections.project', side_effect=checked):
            result = evaluate(rows, ['2025-11-15'])
        self.assertEqual(result['results'][0]['players'], 1)

    def test_partial_catalog_keeps_previous_verified_eligibility(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'catalog.json'
            manual = Path(directory) / 'manual.json'
            output.write_text(json.dumps(catalog()))
            incomplete = catalog()
            incomplete['players'][0].update(status='unresolved', positions=[])
            manual.write_text(json.dumps(incomplete))
            refresh(output, manual=manual)
            self.assertEqual(json.loads(output.read_text())['players'][0]['positions'], ['PG', 'SG'])

    def test_real_projection_fields_dnp_filter_and_schedule(self):
        root = Path(__file__).resolve().parents[1] / 'fixtures'
        index = schedule_index((root / 'stats/nba_schedule_2026.parquet').read_bytes(), 2026, date(2026, 10, 22))
        rows = projection_games((root / 'projections/player_box_2026.parquet').read_bytes(), '2025-26', date(2026, 10, 22), index)
        jokic = [r for r in rows if r['id'] == '3112335']
        self.assertEqual(len(jokic), 65)
        self.assertTrue(all(r['starter'] is not None for r in jokic))
        self.assertTrue(all('3PA' in r['stats'] for r in rows))
        self.assertTrue(all(0 <= r['teamShotShare'] <= 1 for r in rows if r['teamShotShare'] is not None))
        counts = remaining_schedule((root / 'stats/nba_schedule_2027.parquet').read_bytes(), 2027, date(2026, 10, 22))
        self.assertEqual(len(counts), 30)
        self.assertTrue(all(0 <= n <= 82 for n in counts.values()))
        self.assertEqual(sum(remaining_schedule((root / 'stats/nba_schedule_2026.parquet').read_bytes(), 2026, date(2026, 10, 22)).values()), 0)

    def test_missing_shooting_schema_rejects_whole_candidate(self):
        root = Path(__file__).resolve().parents[1] / 'fixtures'
        content = (root / 'stats/player_box_2026.parquet').read_bytes()
        with self.assertRaisesRegex(ValueError, '3PA column missing'):
            projection_games(content, '2025-26', date(2026, 10, 22), {})
