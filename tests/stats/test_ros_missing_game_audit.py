from copy import deepcopy
import gzip
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from audit_ros_missing_games import inspect,run
ROOT=Path(__file__).resolve().parents[2]

class MissingGameAuditTests(unittest.TestCase):
    def test_real_probe_objects_do_not_count_missing_minutes_as_zero_or_gp(self):
        rows=run(ROOT/'tests/fixtures/ros-model-audit/missing-game-probes.json.gz')
        self.assertEqual(len(rows),9)
        self.assertEqual(sum(r['numericStatRows']==0 for r in rows),8)
        self.assertTrue(all(not r['productionGatePassed'] for r in rows))
        self.assertTrue(all(not r['individualCareerGPReconciled'] for r in rows))
        self.assertEqual(sum(r['numericStatRows'] for r in rows),21)

    def test_wrong_game_identity_cannot_reconcile(self):
        item=json.loads(gzip.decompress((ROOT/'tests/fixtures/ros-model-audit/missing-game-probes.json.gz').read_bytes()))[0]
        with self.assertRaisesRegex(ValueError,'identity'):inspect(item['raw'],'999',item['year'])
