"""Isolation, chronology and immutable-forward-origin tests; no network or fitting."""
from copy import deepcopy
from datetime import date
import json
import math
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import rookie_shadow as shadow
from calibrate_rookie_shadow import load_corpus
from evaluate_rookie_revision import predict
from rookie_model import infer, prior_for, RATE_KEYS
from ros_model import projection_games, summary
from regular_season import schedule_index
from test_refresh_stats import game as source_game, parquet, schedule_fixture
from check_rookie_shadow import check_ledger_history


def game(pid='1', day='2026-10-22'):
    return {'id': pid, 'gameId': '1', 'date': day, 'teamId': 1, 'minutes': 20, 'starter': True,
            'stats': {'FGM': 3, 'FGA': 8, '3PM': 1, '3PA': 3, 'FTM': 2, 'FTA': 3, 'PTS': 9,
                      'REB': 5, 'AST': 3, 'STL': 1, 'BLK': 0, 'TO': 2}}


class ShadowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.params = shadow.read(shadow.MODEL)
        cls.inputs = shadow.read(shadow.RESEARCH/'inputs.json')
        cls.preview = shadow.read(shadow.RESEARCH/'projections.json')

    def test_snapshot_is_reproducible_without_network_or_training(self):
        actual = shadow.snapshot(self.inputs, self.params, self.preview['generatedAt'])
        self.assertEqual(actual, self.preview)
        self.assertFalse(actual['productionEnabled'])
        self.assertEqual(len(actual['players']), 56)
        for p in actual['players']:
            self.assertEqual(set(p['perGame']), set(shadow.METRICS))
            self.assertIsNone(p['rosGP'])
            self.assertIsNone(p['availabilityProbability'])
            self.assertIsNone(p['totals'])
            self.assertAlmostEqual(sum(p['minuteComponents'].values()), 1)

    def test_missing_current_gp_is_not_synthesized_from_profile(self):
        p = next(p for p in self.preview['players'] if p['espnPlayerId'] == '5142718')
        self.assertEqual(p['observedNBAGP'], 0)
        self.assertTrue(all(w == 0 for w in p['observationWeights'].values()))
        self.assertGreater(p['perGame']['MIN'], 0)
        self.assertIsNone(p['rosGP'])

    def test_future_observations_and_metadata_rejected(self):
        inputs = deepcopy(self.inputs)
        inputs['games'][0]['date'] = '2026-10-23'
        with self.assertRaisesRegex(ValueError, 'Future'):
            shadow.snapshot(inputs, self.params, self.preview['generatedAt'])
        inputs = deepcopy(self.inputs)
        pid = '5142718'
        inputs['profiles'][pid]['verifiedIdentityAt'] = '2026-10-24T00:00:00+00:00'
        result = shadow.snapshot(inputs, self.params, self.preview['generatedAt'])
        self.assertNotIn(pid, {p['espnPlayerId'] for p in result['players']})

    def test_unverified_entry_is_never_inferred_from_draft_only(self):
        inputs = deepcopy(self.inputs)
        inputs['profiles']['5142718']['nbaEntryVerified'] = False
        result = shadow.snapshot(inputs, self.params, self.preview['generatedAt'])
        self.assertNotIn('5142718', {p['espnPlayerId'] for p in result['players']})

    def test_international_player_does_not_use_ncaa_even_if_present(self):
        inputs = deepcopy(self.inputs)
        pid = next(p['espnPlayerId'] for p in self.preview['players'] if p['experience'] == 'international-newcomer')
        inputs['profiles'][pid]['ncaa'] = inputs['profiles']['5142718']['ncaa']
        result = shadow.snapshot(inputs, self.params, self.preview['generatedAt'])
        self.assertEqual(next(p for p in result['players'] if p['espnPlayerId'] == pid)['basis'], 'draft prior')

    def test_ncaa_crosswalk_and_pre_entry_date_are_required(self):
        for field, value in [('id', 'wrong-id'), ('through', '2026-10-01')]:
            inputs = deepcopy(self.inputs)
            inputs['profiles']['5142718']['ncaa'][field] = value
            with self.assertRaises(ValueError):
                shadow.snapshot(inputs, self.params, self.preview['generatedAt'])

    def test_duplicate_invalid_shooting_and_missing_3pa_fail_closed(self):
        for change in ('duplicate', 'shots', 'missing', 'negative'):
            games = [game()]
            if change == 'duplicate': games.append(deepcopy(games[0]))
            elif change == 'shots': games[0]['stats']['FGM'] = 10
            elif change == 'missing': del games[0]['stats']['3PA']
            else: games[0]['stats']['TO'] = -1
            with self.assertRaises(ValueError): shadow.validate_games(games, '2026-10-22')

    def test_zero_minutes_source_appearance_survives_normalization(self):
        rows = [source_game(minutes=0.0), source_game(game_id=2, minutes=None),
                source_game(game_id=3, minutes=0.0, did_not_play=True)]
        for row in rows:
            row.update(starter=False, three_point_field_goals_attempted=0)
        raw = parquet(rows)
        index = schedule_index(schedule_fixture(raw), 2027, date(2026, 10, 22))
        games = projection_games(raw, '2026-27', date(2026, 10, 22), index)
        self.assertEqual([(g['id'], g['gameId'], g['minutes']) for g in games], [('7', '1', 0.0)])
        shadow.validate_games(games, '2026-10-22')
        self.assertEqual(summary(games)['gp'], 1)

    def test_missing_null_negative_nonfinite_and_boolean_minutes_fail_closed(self):
        for value in (None, -1, float('nan'), float('inf'), -float('inf'), True, False, '0'):
            with self.subTest(minutes=value):
                row = dict(game(), minutes=value)
                with self.assertRaisesRegex(ValueError, 'Invalid minutes'):
                    shadow.validate_games([row], '2026-10-22')
        row = game()
        del row['minutes']
        with self.assertRaisesRegex(ValueError, 'Invalid minutes'):
            shadow.validate_games([row], '2026-10-22')

    def test_zero_minute_appearance_counts_gp_without_rate_exposure(self):
        pid = '5142718'
        prior = prior_for(self.inputs['profiles'][pid], self.params)
        zero = dict(game(pid), minutes=0.0, starter=False)
        zero['stats'] = dict.fromkeys(zero['stats'], 0)
        inputs = deepcopy(self.inputs)
        inputs['games'] = [zero]
        original = deepcopy(inputs)
        result = shadow.snapshot(inputs, self.params, self.preview['generatedAt'])
        player = next(p for p in result['players'] if p['espnPlayerId'] == pid)
        self.assertEqual(inputs, original)
        self.assertEqual(player['observedNBAGP'], 1)
        self.assertEqual(player['observedNBAMinutes'], 0)
        self.assertEqual(player['role']['observedGames'], 1)
        self.assertEqual(player['role']['recentMinutes'], 0)
        weight = 1 / (1 + self.params['minutesK'])
        self.assertEqual(player['observationWeights']['minutes'], weight)
        self.assertAlmostEqual(player['perGame']['MIN'], (1-weight)*prior['minutes'])
        for key in (*RATE_KEYS, '2P%', '3P%', 'FT%'):
            self.assertEqual(player['observationWeights'][key], 0)
        self.assertTrue(all(math.isfinite(v) for v in player['perMinute'].values()))
        positive = game(pid, day='2026-10-21')
        positive['gameId'] = '2'
        mixed = infer(prior, [positive, zero], self.params)
        one = infer(prior, [positive], self.params)
        self.assertEqual(summary([positive, zero])['mpg'], 10)
        self.assertEqual(mixed['rookieWeights']['minutes'], 2/(2+self.params['minutesK']))
        for key in (*RATE_KEYS, '2P%', '3P%', 'FT%'):
            self.assertEqual(mixed['rookieWeights'][key], one['rookieWeights'][key])

    def test_future_results_cannot_change_checkpoint_prediction(self):
        profile = self.inputs['profiles']['5142718']
        before = {'profile': profile, 'games': [game(), game(day='2026-10-25')]}
        after = deepcopy(before)
        after['games'][1]['minutes'] = 40
        after['games'][1]['stats']['PTS'] = 100
        self.assertEqual(predict(before, 1, self.params, 'role'), predict(after, 1, self.params, 'role'))

    def test_starter_label_is_diagnostic_and_weights_have_correct_units(self):
        prior = prior_for(self.inputs['profiles']['5142718'], self.params)
        a = infer(prior, [game()], self.params)
        b = infer(prior, [dict(game(), starter=False)], self.params)
        self.assertEqual(a['stats'], b['stats'])
        self.assertEqual(a['rookieWeights']['minutes'], 1/4)
        self.assertAlmostEqual(a['rookieWeights']['AST'], 20/(20+50))
        self.assertAlmostEqual(a['rookieWeights']['3P%'], 3/(3+400))

    def test_current_shots_and_points_are_consistent_at_all_checkpoints(self):
        for p in self.preview['players']:
            s = p['perGame']
            self.assertAlmostEqual(s['PTS'], 2*s['FGM']+s['3PM']+s['FTM'])
            self.assertLessEqual(s['FGM'], s['FGA'])
            self.assertLessEqual(s['FTM'], s['FTA'])
            self.assertLessEqual(s['3PM'], s['FGM'])
        report = shadow.read(shadow.RESEARCH/'development.json')
        for r in report['rateDiagnostics']:
            self.assertLess(r['maximumPointsConsistencyResidual'], 1e-10)

    def test_unreviewed_corpus_is_rejected_before_fitting(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'corpus.json'
            path.write_text('{"cohorts":{"2020":[]}}')
            with self.assertRaisesRegex(ValueError, 'pinned individual-gp-v1'):
                load_corpus(path, shadow.read(shadow.PROTOCOL))

    def test_archived_corpus_matches_reviewed_blob_and_counts_without_cache(self):
        _, _, _, counts = load_corpus(shadow.RESEARCH/'cohorts.json.gz', shadow.read(shadow.PROTOCOL))
        self.assertEqual(counts, {'training': 336, 'validation': 75, 'ncaaTraining': 267})

    def test_model_and_protocol_cannot_drift(self):
        params = deepcopy(self.params)
        params['protocolSha256'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'Unreviewed'):
            shadow.snapshot(self.inputs, params, self.preview['generatedAt'])

    def test_shadow_writer_refuses_public_and_golden_paths(self):
        for path in (ROOT/'public/data/player-projections.json', ROOT/'tests/fixtures/anything.json'):
            with self.assertRaisesRegex(ValueError, 'Shadow output'):
                shadow.write(path, {})


class LedgerTests(unittest.TestCase):
    def test_prior_origin_cannot_be_renamed_even_when_added_in_same_draft_pr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
            git('init', '-q')
            git('config', 'user.name', 'Synthetic')
            git('config', 'user.email', 'synthetic@example.test')
            git('commit', '-q', '--allow-empty', '-m', 'base')
            base = git('rev-parse', 'HEAD')
            ledger = root/'research/rookie-shadow/records'
            ledger.mkdir(parents=True)
            (ledger/'origin.json').write_text('{}')
            git('add', '.')
            git('commit', '-q', '-m', 'first origin')
            check_ledger_history(base, root)
            git('mv', 'research/rookie-shadow/records/origin.json', 'research/rookie-shadow/records/rewritten.json')
            git('commit', '-q', '-m', 'renamed origin')
            with self.assertRaisesRegex(ValueError, 'history changed'):
                check_ledger_history(base, root)

    def saved(self, ledger):
        data = deepcopy(shadow.read(shadow.RESEARCH/'projections.json'))
        # Synthetic past origin permits testing a mature horizon without using
        # actual later NBA outcomes or fabricating a real forward prediction.
        data.update(kind='prospective-record', generatedAt='2026-09-01T00:00:00+00:00', asOf='2026-08-31',
                    horizon={'start': '2026-09-02', 'end': '2026-10-01'})
        data['players'] = [dict(data['players'][0], espnPlayerId='1', observedNBAGP=1)]
        raw = shadow.encode(data)
        path = ledger/('synthetic_'+shadow.digest(raw)+'.json')
        path.write_bytes(raw)
        return path, data

    def test_edited_record_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory)
            path, data = self.saved(ledger)
            self.assertEqual(len(shadow.verify_ledger(ledger)), 1)
            path.write_bytes(path.read_bytes()+b' ')
            with self.assertRaisesRegex(ValueError, 'Modified'):
                shadow.verify_ledger(ledger)

    def test_score_reads_saved_predictions_and_excludes_pre_creation_games(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory)
            _, saved = self.saved(ledger)
            future = game(day='2026-09-10')
            previous = dict(game(day='2026-09-01'), gameId='2')
            outcomes = {'asOf': '2026-10-02', 'games': [previous, future], 'scheduleIndex': {}}
            with patch.object(shadow, 'coverage'):
                report = shadow.score_records(ledger, outcomes)['checkpoints'][1]
            self.assertEqual(report['scoredPlayers'], 1)
            self.assertAlmostEqual(report['perGameMAE']['PTS'], abs(9-saved['players'][0]['perGame']['PTS']))
            self.assertEqual(shadow.verify_ledger(ledger)[0], saved)

    def test_incomplete_horizon_is_pending_and_missing_checkpoint_never_backfilled(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory)
            self.saved(ledger)
            with patch.object(shadow, 'coverage'):
                report = shadow.score_records(ledger, {'asOf': '2026-09-10', 'games': [], 'scheduleIndex': {}})
            self.assertEqual(report['checkpoints'][1]['pending'], 1)
            self.assertEqual(report['checkpoints'][0]['savedExactCheckpoint'], 0)
            self.assertEqual(report['checkpoints'][1]['scoredPlayers'], 0)

    def test_record_requires_frozen_committed_implementation(self):
        with patch.object(shadow.subprocess, 'run'), patch.object(shadow.subprocess, 'check_output', return_value=b' M parameters.json'):
            with self.assertRaisesRegex(ValueError, 'Commit the frozen'):
                shadow.record(shadow.RESEARCH/'inputs.json', ROOT/'research/rookie-shadow/records')


if __name__ == '__main__':
    unittest.main()
