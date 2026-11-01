"""Semantic fixes and independent tiny-history arithmetic, not target-player exceptions."""
from copy import deepcopy
from datetime import date
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from espn_teams import resolve_team_assignment
from fantasy_positions import URL
from ros_availability import availability_component
from ros_history_research import weighted_summary, project_history, attendance_history
from test_ros_model import games


def cat(team=1, stamp='2026-10-25T08:00:00Z'):
    return {'playerId':'1','status':'verified','provider':'ESPN Fantasy FBA','season':'2026-27','source':URL+'kona_player_info','retrievedAt':stamp,'proTeamId':team}

class ModelAuditTests(unittest.TestCase):
    def test_zero_unassigned_is_distinct_from_unknown_and_old_team(self):
        old=games(1,team=15,start='2026-10-23')
        result=resolve_team_assignment('1',cat(0),old,date(2026,10,25))
        self.assertEqual((result['status'],result['teamId'],result['lastGameTeamId']),('unassigned',0,15))
        for value in (None,-1,31,True,'0'):
            self.assertEqual(resolve_team_assignment('1',cat(value),[],date(2026,10,25))['status'],'unknown')

    def test_newer_trade_catalog_and_newer_game_observation(self):
        old=games(1,team=1,start='2026-10-23')
        self.assertEqual(resolve_team_assignment('1',cat(2),old,date(2026,10,25))['teamId'],2)
        self.assertEqual(resolve_team_assignment('1',cat(2,'2026-10-22T00:00:00Z'),old,date(2026,10,25))['teamId'],1)

    def test_same_day_conflicting_assignment_order_is_unknown(self):
        old=games(1,team=1,start='2026-10-25')
        self.assertEqual(resolve_team_assignment('1',cat(2),old,date(2026,10,25))['status'],'unknown')

    def test_utc_midnight_does_not_make_same_nba_day_catalog_newer(self):
        old=games(1,team=1,start='2026-10-24')
        candidate=cat(2,'2026-10-25T00:10:00Z')
        self.assertEqual(resolve_team_assignment('1',candidate,old,date(2026,10,25))['status'],'unknown')

    def test_newer_unknown_catalog_does_not_resurrect_old_team(self):
        old=games(1,team=1,start='2026-10-23')
        self.assertEqual(resolve_team_assignment('1',cat(None),old,date(2026,10,25))['status'],'unknown')

    def test_future_metadata_does_not_leak_into_past(self):
        self.assertEqual(resolve_team_assignment('1',cat(2),[],date(2026,10,24))['status'],'unknown')
        wrong=cat();wrong['playerId']='2'
        self.assertEqual(resolve_team_assignment('1',wrong,[],date(2026,10,25))['status'],'unknown')

    def test_unassigned_zero_scope_preserves_conditional_ability(self):
        assignment=resolve_team_assignment('1',cat(0),[],date(2026,10,25))
        a=availability_component(games(50),[],assignment,0,0,True,'2026-10-23')
        self.assertEqual(a['expectedGames'],0);self.assertIsNone(a['appearanceProbability'])
        self.assertEqual(a['status'],'zero-current-assignment')

    def test_unknown_team_is_not_zero(self):
        a=availability_component(games(50),[],{'status':'unknown'},None,0,True,'2026-10-23')
        self.assertIsNone(a['expectedGames']);self.assertFalse(a['usableForTotals'])

    def test_zero_one_two_game_rookie_performance_missing_is_not_numeric_total(self):
        for n in (0,1,2):
            a=availability_component([],games(n),{'status':'assigned'},77,max(n,2),False,'2026-10-23')
            self.assertIsNone(a['expectedGames']);self.assertIsNotNone(a['diagnosticEstimate'])
            self.assertFalse(a['usableForTotals']);self.assertEqual(a['confidence'],'uncalibrated')

    def test_low_attendance_and_lag_are_explicit_not_injury_prediction(self):
        a=availability_component(games(5),games(1),{'status':'assigned'},77,10,True,'2026-10-23')
        self.assertLess(a['expectedGames'],10);self.assertFalse(a['injuryReturnModelled'])
        self.assertEqual(a['sourceDataThrough'],'2026-10-23');self.assertIsNone(a['appearanceProbability'])

    def test_independent_weighted_history_arithmetic(self):
        old=games(10,minutes=10,start='2023-10-01');recent=games(10,minutes=30,start='2024-10-01')
        p=weighted_summary({2024:old,2025:recent,2026:[]},2027,.5)
        self.assertEqual(p['effectiveGP'],7.5);self.assertEqual(p['minutes'],175)
        self.assertAlmostEqual(p['mpg'],175/7.5)
        r=project_history({2024:old,2025:recent,2026:[]},[],2027,.5,.5,'2026-10-25')
        self.assertAlmostEqual(r['minutes'],175/7.5/2)
        self.assertAlmostEqual(r['stats']['PTS'],6.5)
        self.assertAlmostEqual(r['stats']['PTS'],2*r['stats']['FGM']+r['stats']['3PM']+r['stats']['FTM'])

    def test_thresholds_are_not_lowered_and_no_rookie_prior_in_history_candidate(self):
        self.assertIsNone(project_history({},games(2),2027,.5,.5,'2026-10-25'))
        self.assertIsNone(project_history({2025:games(4,start='2024-10-01'),2026:[]},[],2027,1,1,'2026-10-25'))

    def test_future_leakage_and_mixed_identity_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'Future'):project_history({2028:games(6)},[],2027,1,1,'2026-10-25')
        with self.assertRaisesRegex(ValueError,'Future'):project_history({2025:games(6,start='2024-10-01')},games(2,start='2026-10-26'),2027,1,1,'2026-10-25')
        bad=games(1);bad[0]['id']='2'
        with self.assertRaisesRegex(ValueError,'Mixed'):project_history({2025:games(6,start='2024-10-01')},bad,2027,1,1,'2026-10-25')

    def test_missing_source_season_is_not_inferred_as_zero_attendance(self):
        self.assertIsNone(attendance_history({2024:games(6,start='2023-10-01'),2026:[]},{2024:{}},2027,.5))
