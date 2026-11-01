"""Offline regressions against original provider records and independent ESPN totals."""
from collections import Counter
from copy import deepcopy
from datetime import date
import gzip
import hashlib
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
from refresh_stats import parse_games, aggregate, publish
from parquet_io import read_parquet
from regular_season import schedule_index, coverage
from correct_initial_snapshot import correct_initial_snapshot

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'tests/fixtures/stats'
AS_OF = date(2026, 10, 22)
EXCLUDED = {'401809839': 'cupFinal', '401838140': 'allStar', '401838141': 'allStar',
            '401838142': 'allStar', '401838143': 'allStar'}


def parquet(rows):
    buffer = io.BytesIO()
    pq.write_table(pa.Table.from_pylist(rows), buffer)
    return buffer.getvalue()


class RealSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schedule_bytes = (FIXTURES / 'nba_schedule_2026.parquet').read_bytes()
        cls.box_bytes = (FIXTURES / 'player_box_2026.parquet').read_bytes()
        cls.index = schedule_index(cls.schedule_bytes, 2026, AS_OF)
        cls.games = parse_games(cls.box_bytes, '2025-26', AS_OF, cls.index)
        cls.players = {p['name']: p for p in aggregate(cls.games)}

    def test_fixture_provenance_and_full_snapshot_agree(self):
        provenance = json.loads((FIXTURES / 'provenance.json').read_text())
        for name in ['player_box_2026', 'nba_schedule_2026']:
            self.assertEqual(hashlib.sha256((FIXTURES / f'{name}.parquet').read_bytes()).hexdigest(), provenance[name]['fixtureSha256'])
        published = json.loads((ROOT / 'public/data/player-stats.json').read_text())
        self.assertEqual(published['periods']['lastSeason']['players'], list(self.players.values()))
        self.assertEqual(published['coverage']['2025-26'], coverage(self.games, self.index, 2026, AS_OF))

    def test_exactly_1230_games_and_82_for_each_of_30_teams_in_actual_box_scores(self):
        report = coverage(self.games, self.index, 2026, AS_OF)
        self.assertEqual(report['games'], 1230)
        self.assertEqual(report['teamGames'], {str(i): 82 for i in range(1, 31)})
        pairs = {(g['gameId'], g['teamId']) for g in self.games}
        self.assertEqual(len(pairs), 2460)
        self.assertEqual(Counter(team for _, team in pairs), Counter(dict.fromkeys(range(1, 31), 82)))
        self.assertEqual(report['excludedGames'], EXCLUDED)
        self.assertFalse(set(EXCLUDED) & {g['gameId'] for g in self.games})

    def test_other_cup_games_stay_in_regular_season(self):
        records = read_parquet(self.schedule_bytes).to_pylist()
        cup = [r for r in records if r['notes_headline'] and r['notes_headline'].startswith('NBA Cup -')]
        self.assertEqual(len(cup), 66)  # 60 group + 4 quarterfinal + 2 semifinal.
        observed = {g['gameId'] for g in self.games}
        self.assertTrue({str(r['game_id']) for r in cup} <= observed)

    def test_jokic_and_cup_finalists_match_independent_espn_season_totals(self):
        ref = json.loads((FIXTURES / 'espn-season-totals-2026.json').read_text())
        for name in ['Nikola Jokic', 'Jalen Brunson', 'Karl-Anthony Towns', 'Victor Wembanyama']:
            stats = {r['stat_name']: r for r in ref['rows'] if r['athlete_display_name'] == name}
            p = self.players[name]
            with self.subTest(player=name):
                self.assertEqual(p['gp'], stats['gamesPlayed']['value'])
                self.assertEqual(p['totals']['FGA'], int(stats['fieldGoalsMade-fieldGoalsAttempted']['display_value'].split('-')[1]))
                self.assertEqual(p['totals']['REB'], stats['totalRebounds']['value'])
                self.assertEqual(p['totals']['PTS'], stats['points']['value'])
        jokic = self.players['Nikola Jokic']
        self.assertEqual((jokic['gp'], jokic['totals']['FGA'], jokic['totals']['REB']), (65, 1132, 836))

    def test_incomplete_box_coverage_missing_team_side_and_missing_completed_games_fail(self):
        for changed in [[g for g in self.games if g['gameId'] != self.games[0]['gameId']],
                        [g for g in self.games if not (g['gameId'] == self.games[0]['gameId'] and g['teamId'] == self.games[0]['teamId'])]]:
            with self.assertRaises(ValueError):
                coverage(changed, self.index, 2026, AS_OF)
        reduced = {k: v for k, v in self.index.items() if k != self.games[0]['gameId']}
        with self.assertRaisesRegex(ValueError, '1230 games'):
            coverage([g for g in self.games if g['gameId'] in reduced], reduced, 2026, AS_OF)

    def test_unmatched_game_and_metadata_schema_change_fail(self):
        with self.assertRaisesRegex(ValueError, 'missing from schedule'):
            parse_games(self.box_bytes, '2025-26', AS_OF, {})
        with self.assertRaisesRegex(ValueError, 'Schedule schema'):
            schedule_index(parquet([{'game_id': 1}]), 2026, AS_OF)

    def test_future_season_new_ids_use_metadata_and_unknown_types_fail(self):
        base = dict(game_id=900000001, season=2028, season_type=2, game_date=date(2027, 12, 15),
                    type_id=39, type_abbreviation='CC', notes_headline='NBA Cup Championship',
                    home_id=1, away_id=2, status_type_completed=True)
        rows = [base, {**base, 'game_id': 900000002, 'type_id': 4, 'type_abbreviation': 'ALLSTAR', 'notes_headline': 'NBA All-Star - Championship'},
                {**base, 'game_id': 900000003, 'type_id': 1, 'type_abbreviation': 'STD', 'notes_headline': 'NBA Cup - Semifinals'}]
        index = schedule_index(parquet(rows), 2028, date(2028, 3, 1))
        self.assertEqual(index['900000001']['excluded'], 'cupFinal')
        self.assertEqual(index['900000002']['excluded'], 'allStar')
        self.assertIsNone(index['900000003']['excluded'])
        for changes in [dict(type_id=99, type_abbreviation='UNKNOWN', notes_headline=''), dict(type_id=1, type_abbreviation='STD', notes_headline='', home_id=999)]:
            with self.assertRaises(ValueError):
                schedule_index(parquet([{**base, **changes}]), 2028, date(2028, 3, 1))


class BoundedRepairTests(unittest.TestCase):
    def setUp(self):
        self.original = gzip.decompress((FIXTURES / 'initial-snapshot.json.gz').read_bytes())
        self.corrected = json.loads(gzip.decompress((FIXTURES / 'corrected-initial-snapshot.json.gz').read_bytes()))
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / 'stats.json'; self.output.write_bytes(self.original)

    def test_normal_publish_still_rejects_lower_gp_then_exact_repair_succeeds(self):
        with self.assertRaisesRegex(ValueError, 'lost previously published'):
            publish(self.corrected, self.output)
        self.assertEqual(self.output.read_bytes(), self.original)
        correct_initial_snapshot(self.corrected, self.output)
        self.assertEqual(json.loads(self.output.read_bytes()), self.corrected)
        with self.assertRaisesRegex(ValueError, 'exact initial'):
            correct_initial_snapshot(self.corrected, self.output)
        # A future daily regression is still rejected after successful repair.
        bad = deepcopy(self.corrected); bad['periods']['lastSeason']['players'][0]['gp'] -= 1
        with self.assertRaisesRegex(ValueError, 'lost previously published'):
            publish(bad, self.output)

    def test_unrelated_baseline_or_candidate_changes_are_rejected_without_writing(self):
        for mutate in [lambda s: s['periods']['season']['players'].pop(),
                       lambda s: s['periods']['lastSeason']['players'][0]['stats'].update(PTS=0),
                       lambda s: s['coverage']['2025-26'].update(games=1229)]:
            candidate = deepcopy(self.corrected); mutate(candidate)
            with self.assertRaisesRegex(ValueError, 'reviewed correction'):
                correct_initial_snapshot(candidate, self.output)
            self.assertEqual(self.output.read_bytes(), self.original)
        self.output.write_bytes(self.original+b' ')
        with self.assertRaisesRegex(ValueError, 'exact initial'):
            correct_initial_snapshot(self.corrected, self.output)
        self.assertEqual(self.output.read_bytes(), self.original+b' ')

    def test_failed_repair_write_preserves_original(self):
        with patch('refresh_stats.os.replace', side_effect=OSError('disk error')), self.assertRaises(OSError):
            correct_initial_snapshot(self.corrected, self.output)
        self.assertEqual(self.output.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
