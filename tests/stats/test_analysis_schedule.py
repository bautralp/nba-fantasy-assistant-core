"""Real provider bytes remain untouched; fixtures are replayed with their pinned ROS date."""
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from export_analysis_schedule import build

ROOT = Path(__file__).resolve().parents[2]

class AnalysisScheduleTests(unittest.TestCase):
    def test_real_schedule_export_matches_ros_counts_and_omits_placeholder_cup_games(self):
        content = (ROOT / 'tests/fixtures/freshness/nba_schedule_2027.parquet').read_bytes()
        snapshot = json.loads((ROOT / 'public/data/player-projections.json').read_text())
        # Pinned fixture provenance, independent of future production JSON updates.
        snapshot = dict(snapshot, asOf='2026-10-25', sources=[dict(url='https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_2027.parquet', sha256=hashlib.sha256(content).hexdigest())], scheduleRemaining={'1':77,'2':78,'3':77,'4':77,'5':78,'6':77,'7':78,'8':77,'9':77,'10':77,'11':77,'12':77,'13':77,'14':77,'15':77,'16':77,'17':77,'18':77,'19':77,'20':76,'21':78,'22':78,'23':77,'24':77,'25':77,'26':77,'27':77,'28':77,'29':77,'30':77})
        result = build(content, snapshot, datetime.now(timezone.utc).isoformat())
        self.assertEqual(len(result['games']), 1157)
        self.assertEqual(result['through'], '2027-04-11')
        self.assertTrue(all(1 <= t <= 30 for g in result['games'] for t in g['teamIds']))
        self.assertEqual(len({g['id'] for g in result['games']}), 1157)
        altered = copy.deepcopy(snapshot); altered['sources'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'SHA'): build(content, altered, '2026-10-25T00:00:00Z')
        altered = copy.deepcopy(snapshot); altered['scheduleRemaining']['1'] = 78
        with self.assertRaisesRegex(ValueError, 'counts'): build(content, altered, '2026-10-25T00:00:00Z')
