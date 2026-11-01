"""Freshness and real local Git race tests; synthetic origins never leave temp repos."""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import rookie_shadow_recording as recording
import rookie_shadow as shadow


class FreshnessTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
        self.p = {'refreshedAt': '2026-10-23T10:24:00Z', 'asOf': '2026-10-23', 'season': '2026-27',
                  'rookieModel': {'enabled': False}, 'sources': [{'season': '2026-27', 'url': u} for u in recording.SOURCE_URLS]}
        self.s = {'refreshedAt': '2026-10-23T10:23:30Z', 'asOf': '2026-10-23'}
        self.status = {'attemptedAt': '2026-10-23T10:25:00Z', 'status': 'ok', 'errors': []}
        self.run = {'id': 10, 'head_branch': 'main', 'status': 'completed', 'conclusion': 'success',
                    'run_started_at': '2026-10-23T10:23:00Z', 'updated_at': '2026-10-23T10:30:00Z'}

    def validate(self, event=None):
        recording.validate_refresh(self.p, self.s, self.status, self.run, self.now, event)

    def test_successful_latest_refresh_and_manual_run(self):
        self.validate('10')
        self.validate()

    def test_failed_cancelled_or_in_progress_latest_refresh_blocks(self):
        for status, conclusion in [('completed', 'failure'), ('completed', 'cancelled'), ('in_progress', None)]:
            with self.subTest(status=status, conclusion=conclusion):
                self.run.update(status=status, conclusion=conclusion)
                with self.assertRaises(ValueError): self.validate()

    def test_superseded_event_never_uses_another_refresh(self):
        with self.assertRaisesRegex(ValueError, 'superseded'): self.validate('9')

    def test_degraded_refresh_and_stale_snapshots_block(self):
        self.status['status'] = 'degraded'
        with self.assertRaisesRegex(ValueError, 'degraded'): self.validate()
        self.status['status'] = 'ok'
        self.now += timedelta(days=2)
        with self.assertRaisesRegex(ValueError, 'Stale'): self.validate()

    def test_success_flag_does_not_allow_retained_old_snapshot(self):
        self.p['refreshedAt'] = '2026-10-22T10:24:00Z'
        with self.assertRaisesRegex(ValueError, 'belong'): self.validate()

    def test_future_and_inconsistent_cutoff_block(self):
        for cutoff in ('2026-10-24', '2026-10-20'):
            self.p['asOf'] = self.s['asOf'] = cutoff
            with self.assertRaisesRegex(ValueError, 'cutoff'): self.validate()

    def test_historical_or_unknown_source_and_production_activation_block(self):
        self.p['sources'][0]['url'] = 'https://example.test/player_box_2020.parquet'
        with self.assertRaisesRegex(ValueError, '2027'): self.validate()
        self.p['rookieModel']['enabled'] = True
        with self.assertRaisesRegex(ValueError, 'activation'): self.validate()

    def test_frozen_model_protocol_and_first_record_pins(self):
        manifest = recording.frozen_manifest()
        self.assertEqual(manifest['firstRecordSha256'], recording.FIRST_SHA)
        with patch.object(shadow, 'digest', return_value='changed'):
            with self.assertRaisesRegex(ValueError, 'Frozen'): recording.frozen_manifest()

    def test_blocked_preflight_never_downloads_or_captures_or_pushes(self):
        with patch.object(shadow, 'read', return_value={}), \
             patch.object(recording, 'validate_refresh', side_effect=ValueError('stale')), \
             patch.object(recording, 'urlopen') as network, \
             patch.object(recording, 'capture') as capture, \
             patch.object(recording, 'publish') as publish:
            with self.assertRaisesRegex(ValueError, 'stale'):
                recording.run({}, None, 'unused', Path('/unused'))
            network.assert_not_called()
            capture.assert_not_called()
            publish.assert_not_called()


def candidate(name='one', gp=3):
    # Explicitly synthetic, isolated local Git transport test.
    data = deepcopy(shadow.read(recording.FIRST))
    data.update(inputSha256='synthetic-'+name, generatedAt='2026-10-23T07:40:00+00:00')
    data['recordingContext'] = {'productionSnapshotSha256': 'synthetic-'+name, 'refreshRunId': name}
    for p in data['players']: p['observedNBAGP'] = gp
    return data


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.remote = self.root/'remote.git'
        self.work = self.root/'writer'
        self.git(self.root, 'init', '-q', '--bare', str(self.remote))
        self.git(self.root, 'clone', '-q', str(self.remote), str(self.work))
        self.git(self.work, 'config', 'user.name', 'Synthetic')
        self.git(self.work, 'config', 'user.email', 'synthetic@example.test')
        (self.work/'production.json').write_text('synthetic main')
        self.git(self.work, 'add', '.')
        self.git(self.work, 'commit', '-q', '-m', 'synthetic main')
        self.git(self.work, 'push', '-q', 'origin', 'HEAD:main')
        self.main = self.git(self.remote, 'rev-parse', 'refs/heads/main')

    def tearDown(self): self.temp.cleanup()

    def git(self, root, *args): return recording.git(root, *args)

    def checkout_archive(self):
        path = self.root/'archive-inspect'
        self.git(self.root, 'clone', '-q', '-b', recording.ARCHIVE_BRANCH, str(self.remote), str(path))
        return path

    def test_seed_and_append_preserve_first_origin_main_and_independent_history(self):
        recording.publish(str(self.remote))
        recording.publish(str(self.remote), candidate())
        root = self.checkout_archive()
        records = recording.verify_archive(root)
        self.assertEqual(len(records), 2)
        self.assertEqual((root/'records'/recording.FIRST_NAME).read_bytes(), recording.FIRST.read_bytes())
        self.assertEqual(self.git(self.remote, 'rev-parse', 'refs/heads/main'), self.main)
        result = subprocess.run(['git', 'merge-base', self.main, 'refs/heads/'+recording.ARCHIVE_BRANCH], cwd=self.remote, capture_output=True)
        self.assertEqual(result.returncode, 1)  # no shared history with main

    def test_same_snapshot_is_idempotent_including_original_snapshot(self):
        recording.publish(str(self.remote))
        c = candidate()
        c['recordingContext']['productionSnapshotSha256'] = shadow.read(shadow.RESEARCH/'inputs.json')['productionSnapshotSha256']
        before = self.git(self.remote, 'rev-parse', 'refs/heads/'+recording.ARCHIVE_BRANCH)
        result = recording.publish(str(self.remote), c)
        self.assertEqual(result['status'], 'already-recorded')
        self.assertEqual(result['archiveCommit'], before)
        recording.publish(str(self.remote), candidate())
        self.assertEqual(recording.publish(str(self.remote), candidate())['status'], 'already-recorded')

    def test_main_advance_and_concurrent_archive_writer_retry_without_force(self):
        def race(attempt):
            if attempt == 0:
                (self.work/'production.json').write_text('new synthetic main')
                self.git(self.work, 'commit', '-qam', 'daily main changes')
                self.git(self.work, 'push', '-q', 'origin', 'HEAD:main')
                recording.publish(str(self.remote), candidate('two', 5))
        result = recording.publish(str(self.remote), candidate('one', 3), before_push=race)
        self.assertEqual(result['status'], 'recorded')
        root = self.checkout_archive()
        records = recording.verify_archive(root)
        self.assertEqual(len(records), 3)
        expected = shadow.encode(candidate('one', 3))
        path = next(p for p in (root/'records').glob('*.json') if p.name.endswith('_'+shadow.digest(expected)+'.json'))
        self.assertEqual(path.read_bytes(), expected)  # capture was not recomputed on retry
        self.assertNotEqual(self.git(self.remote, 'rev-parse', 'refs/heads/main'), self.main)

    def test_mutated_existing_origin_blocks_all_further_publishing(self):
        recording.publish(str(self.remote))
        root = self.checkout_archive()
        self.git(root, 'config', 'user.name', 'Synthetic')
        self.git(root, 'config', 'user.email', 'synthetic@example.test')
        path = root/'records'/recording.FIRST_NAME
        path.write_bytes(path.read_bytes()+b' ')
        self.git(root, 'commit', '-qam', 'synthetic forbidden mutation')
        self.git(root, 'push', '-q')
        with self.assertRaisesRegex(ValueError, 'First prospective record'):
            recording.publish(str(self.remote), candidate())

    def test_renamed_hash_record_still_fails_history_guard(self):
        recording.publish(str(self.remote), candidate())
        root = self.checkout_archive()
        self.git(root, 'config', 'user.name', 'Synthetic')
        self.git(root, 'config', 'user.email', 'synthetic@example.test')
        old = next(p for p in (root/'records').glob('*.json') if p.name != recording.FIRST_NAME)
        self.git(root, 'mv', str(old.relative_to(root)), str(old.relative_to(root)).replace('07-40', '07-41'))
        self.git(root, 'commit', '-qm', 'synthetic forbidden rename')
        self.git(root, 'push', '-q')
        with self.assertRaisesRegex(ValueError, 'non-append-only'):
            recording.publish(str(self.remote), candidate('three'))


class CheckpointTests(unittest.TestCase):
    def test_daily_jump_reports_missed_exact_checkpoint_without_backfill(self):
        a, b = candidate('one', 2), candidate('two', 4)
        b['generatedAt'] = '2026-10-24T07:40:00+00:00'
        report = recording.checkpoint_report([a], b)
        rows = [r for r in report['players'] if r['espnPlayerId'] == a['players'][0]['espnPlayerId']]
        self.assertEqual(next(r for r in rows if r['checkpoint'] == 0)['state'], 'missed-before-first-record')
        self.assertEqual(next(r for r in rows if r['checkpoint'] == 3)['state'], 'missed-between-records')
        self.assertEqual(next(r for r in rows if r['checkpoint'] == 5)['state'], 'not-yet-reached')
        self.assertEqual(a['players'][0]['observedNBAGP'], 2)

    def test_gp_correction_is_flagged_without_altering_old_record(self):
        a, b = candidate('one', 5), candidate('two', 3)
        b['generatedAt'] = '2026-10-24T07:40:00+00:00'
        report = recording.checkpoint_report([a], b)
        self.assertTrue(report['gpRegressionPlayers'])
        self.assertEqual(a['players'][0]['observedNBAGP'], 5)


if __name__ == '__main__': unittest.main()
