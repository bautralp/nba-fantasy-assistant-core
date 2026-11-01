"""Independent calendar/GP oracle. All transfer calendars here are synthetic."""
import copy
from datetime import date
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from attendance_opportunities import observed_opportunities, observed_team_games, validate_period_map
from ros_availability import availability_component
from generate_projection_scenarios import attendance, build


def event(key, day, team):
    return {'id': str(key), 'date': f'2027-01-{day:02d}', 'teamIds': [team, 30], 'seasonType': 2}


def appearance(e, team):
    return {'id': '1', 'gameId': e['id'], 'date': e['date'], 'teamId': team}


def period(team, start=1, end=None, known=1):
    return {'playerId': '1', 'teamId': team, 'start': f'2027-01-{start:02d}',
            'end': f'2027-01-{end:02d}' if end else None, 'knownAt': f'2027-01-{known:02d}T00:00:00Z',
            'source': 'https://example.invalid/synthetic-official-transaction'}


class AttendanceOpportunityTests(unittest.TestCase):
    def both(self, events, played, team, periods, count, remaining=40, asof='2027-01-31'):
        scope = observed_opportunities('1', played, events, team, asof, periods)
        self.assertEqual(scope['count'], count)
        past = [{}] * 41  # independent veteran attendance prior = 41/82 = .5
        standard = availability_component(past, played, {'status': 'unassigned' if team == 0 else 'unknown' if team is None else 'assigned'}, remaining, scope, True, scope['sourceDataThrough'])
        extended = attendance('veteran', {2026: past}, played, team, remaining, scope, None, asof, {'rate': .8}, season_ending_year=2027)
        if team == 0:
            self.assertEqual(standard['expectedGames'], 0); self.assertEqual(extended['expectedGames'], 0)
        elif count is None or team is None:
            self.assertIsNone(standard['expectedGames']); self.assertIsNone(extended)
        else:
            # Oracle does not call either model or read their parameters.
            expected = remaining * (len(played) + 20 * .5) / (count + 20)
            self.assertAlmostEqual(standard['expectedGames'], expected)
            self.assertAlmostEqual(extended['expectedGames'], expected)
            self.assertLessEqual(expected, remaining)
        return scope

    def test_same_team_matches_previous_estimator(self):
        es = [event(i, i, 1) for i in range(1,7)]
        self.both(es, [appearance(es[i],1) for i in (0,2,4)], 1, None, 6)

    def test_a_to_b_with_different_team_progress(self):
        es = [event('a1',1,1), event('a3',3,1), event('a8',8,1), event('b1',1,2), event('b2',2,2), event('b4',4,2), event('b7',7,2), event('b9',9,2)]
        ps = [appearance(es[0],1), appearance(es[1],1), appearance(es[-2],2)]
        scope = self.both(es,ps,2,[period(1,end=5),period(2,start=5,known=5)],4)
        self.assertEqual(scope['gameIds'], ['a1','a3','b7','b9'])

    def test_a_to_b_to_c(self):
        es = [event('a1',1,1),event('a7',7,1),event('b2',2,2),event('b6',6,2),event('b8',8,2),event('b12',12,2),event('c4',4,3),event('c11',11,3),event('c13',13,3)]
        ps = [appearance(es[0],1),appearance(es[3],2),appearance(es[7],3)]
        self.both(es,ps,3,[period(1,end=5),period(2,5,10,5),period(3,10,known=10)],5)

    def test_new_team_without_appearance_and_with_dnp(self):
        es = [event('a',1,1),event('bp',2,2),event('bpost',8,2),event('blater',9,2)]
        ps = [appearance(es[0],1)]; periods = [period(1,end=5),period(2,5,known=5)]
        self.both(es,ps,2,periods,3)
        # Same transfer before either post-transfer game: no imaginary DNP.
        self.both(es,ps,2,periods,1,asof='2027-01-06')

    def test_free_agent_to_team_and_source_observed_dnp(self):
        es = [event('free1',1,2),event('free3',3,2),event('signed',8,2),event('dnp',9,2)]
        self.both(es,[appearance(es[2],2)],2,[period(0,end=7),period(2,7,known=7)],2)

    def test_team_to_free_agent_preserves_performance_contract(self):
        es = [event('a1',1,1),event('a8',8,1)]
        scope = self.both(es,[appearance(es[0],1)],0,[period(1,end=5),period(0,5,known=5)],1,remaining=0)
        self.assertEqual(scope['gameIds'],['a1'])
        # Availability never edits the caller's conditional performance.
        stats = {'PTS': 25, 'FGM': 8}; before = copy.deepcopy(stats)
        availability_component([{}]*41,[appearance(es[0],1)],{'status':'unassigned'},0,scope,True,'2027-01-08')
        self.assertEqual(stats,before)

    def test_unknown_team_not_zero_or_previous_team(self):
        es=[event('a',1,1)]
        scope=self.both(es,[appearance(es[0],1)],None,None,None)
        self.assertEqual(scope['basis'],'unknown-team')

    def test_transfer_dates_missing_and_new_team_no_appearance_fail_closed(self):
        es=[event('a',1,1),event('b',8,2)]
        for ps in ([appearance(es[0],1)],[appearance(es[0],1),appearance(es[1],2)]):
            scope=self.both(es,ps,2,None,None)
            self.assertTrue(scope['uncertainIntervals'])

    def test_source_delay_duplicate_events_and_preseason(self):
        es=[event('a',1,1),event('b',8,2)]
        # Only published games enter. An unobserved Jan 9 fixture is absent.
        self.both(es+es,[appearance(es[0],1),appearance(es[1],2)],2,[period(1,end=5),period(2,5,known=5)],2)
        preseason={**event('pre',2,2),'seasonType':1}
        self.both(es+[preseason],[appearance(es[0],1),appearance(es[1],2)],2,[period(1,end=5),period(2,5,known=5)],2)
        rows=[{'gameId':'1','date':'2027-01-01','teamId':1,'opponentTeamId':2}]*3
        self.assertEqual(len(observed_team_games(rows)),1)
        # A duplicated player row must not inflate either model's numerator.
        played=[appearance(es[0],1),appearance(es[1],2)]
        scope=observed_opportunities('1',played+played,es,2,'2027-01-31',[period(1,end=5),period(2,5,known=5)])
        a=availability_component([{}]*41,played+played,{'status':'assigned'},40,scope,True,'2027-01-08')
        b=attendance('veteran',{2026:[{}]*41},played+played,2,40,scope,None,'2027-01-31',{'rate':.8})
        self.assertAlmostEqual(a['expectedGames'],40*12/22);self.assertAlmostEqual(b['expectedGames'],40*12/22)

    def test_future_transfer_never_closes_historical_stint(self):
        es=[event('a1',1,1),event('a4',4,1),event('b',8,2)]
        future=[period(1,end=5,known=10),period(2,5,known=10)]
        self.both(es,[appearance(es[0],1)],1,future,2,asof='2027-01-04')
        self.both([],[],1,future,0,asof='2026-09-01')

    def test_period_gaps_overlap_identity_and_source_fail_closed(self):
        for bad in ({'2':[period(1)]},{'unknown':[]},{'1':[{**period(1),'playerId':'2'}]}):
            with self.assertRaises(ValueError): validate_period_map(bad, {'1'})
        es=[event('a',1,1),event('gap',6,2),event('b',8,2)]
        self.both(es,[appearance(es[0],1),appearance(es[2],2)],2,[period(1,end=5),period(2,7,known=7)],None)
        for bad in ([period(1),period(2,5,known=5)], [{**period(1),'playerId':'2'}], [{**period(1),'source':''}]):
            with self.assertRaises(ValueError): observed_opportunities('1',[appearance(es[0],1)],es,1,'2027-01-31',bad)

    def test_independent_thirty_percent_standard_underestimate_oracle(self):
        a=[event('a'+str(d),d,1) for d in (1,3,5,7)]
        b=[event('b'+str(d),d,2) for d in list(range(1,13))+[15,17,19,21]]
        ps=[appearance(e,1) for e in a]+[appearance(e,2) for e in b[-4:]]
        s=observed_opportunities('1',ps,a+b,2,'2027-01-31',[period(1,end=14),period(2,14,known=14)])
        self.assertEqual(s['count'],8)
        # Prior=.5, n=8, k=20, remaining=40. Old STD union=20, EXT latest-team=16.
        fixed=40*(8+10)/(8+20); old_std=40*18/40; old_ext=40*18/36
        self.assertAlmostEqual(1-old_std/fixed,.30)
        self.assertAlmostEqual(1-old_ext/fixed,2/9)
        self.both(a+b,ps,2,[period(1,end=14),period(2,14,known=14)],8)

    def test_extended_can_overestimate_when_new_team_has_fewer_elapsed_games(self):
        # n=4 across teams, actual opportunities=10, latest team elapsed=2.
        # The old max(n,elapsed)=4 discards six genuine DNP opportunities.
        fixed=40*(4+10)/(10+20); old_ext=40*(4+10)/(4+20)
        self.assertAlmostEqual(old_ext/fixed-1,.25)
        a=[event('a'+str(d),d,1) for d in range(1,9)]
        b=[event('b'+str(d),d,2) for d in (10,12)]
        ps=[appearance(a[i],1) for i in (0,2,4)]+[appearance(b[0],2)]
        self.both(a+b,ps,2,[period(1,end=9),period(2,9,known=9)],10)
        old_std=40*14/(5+20)
        self.assertAlmostEqual(old_std/fixed-1,.20)

    def product_fixture(self):
        from test_ros_model import games
        from fantasy_positions import URL
        from generate_projections import build as standard_build
        a=[event('a'+str(d),d,1) for d in (1,3,5,7)]
        b=[event('b'+str(d),d,2) for d in list(range(1,13))+[15,17,19,21]]
        es=a+b; rows=[]; past=games(41,start='2025-11-01')
        for e in es:
            # Teammates establish actual published team opportunities, including DNP.
            g=games(1)[0];g.update(id='99',gameId=e['id'],date=e['date'],teamId=e['teamIds'][0],opponentTeamId=30);rows.append(g)
        now=[]
        for e in a+b[-4:]:
            g=games(1)[0];g.update(gameId=e['id'],date=e['date'],teamId=e['teamIds'][0],opponentTeamId=30);now.append(g)
        cat={'players':[{'playerId':'1','name':'Player','status':'verified','season':'2026-27','positions':['PG'],'provider':'ESPN Fantasy FBA','source':URL+'kona_player_info','retrievedAt':'2027-01-31T12:00:00Z','proTeamId':2}]}
        periods={'1':[period(1,end=14),period(2,14,known=14)]}
        # Schedule/normalization are separate tested boundaries. This fixture proves
        # the generators actually wire the common opportunity report into the model.
        with patch('generate_projections.validate_catalog'), patch('generate_projections.before_regular_season',return_value=False), patch('generate_projections.schedule_index',return_value={}), patch('generate_projections.projection_games',side_effect=lambda raw,*_:past if raw==b'past' else now+rows), patch('generate_projections.coverage',return_value={'teamGames':{'2':999}}), patch('generate_projections.remaining_schedule',return_value={2:40}):
            standard=standard_build({'2025-26':b'past','2026-27':b'now'},{'2025-26':b'schedule','2026-27':b'schedule'},date(2027,1,31),'2027-01-31T18:00:00Z',cat,rookie_artifacts=({'profiles':{}},{'enabled':False,'version':'synthetic-disabled'}),team_periods=periods)
        return standard,past,now,rows,periods

    def test_standard_and_extended_generators_use_same_scope_not_latest_team_count(self):
        standard,past,now,others,periods=self.product_fixture()
        row=next(r for r in standard['players'] if r['id']=='1')
        self.assertEqual(row['availability']['observedOpportunities'],8)
        self.assertAlmostEqual(row['rosGP'],40*18/(8+20))  # 41/82=.5, 8 observed GP
        root=Path(__file__).resolve().parents[2]
        artifacts=json.loads((root/'scripts/scenario-model-artifacts.json').read_text())
        schedule={'asOf':'2027-01-31','through':'2027-04-11','games':[{'id':'f'+str(i),'date':'2027-02-01','teamIds':[2,30]} for i in range(40)]}
        # Unified routing preserves known standard GP. Scope correction belongs to standard generation.
        row['rosGP']=18
        for evidence in (periods,None):
            result=build(standard,{'1':{2026:past}},{'1':now,'99':others},schedule,{'players':{}}, {},artifacts['rookie'],artifacts['returning'],artifacts['rookieAttendancePriors'],'2027-01-31','2027-01-31T19:00:00Z',team_periods=evidence)
            p=next(r for r in result['projection']['players'] if r['id']=='1')
            self.assertEqual(p['stats'],row['stats'])
            if evidence:self.assertEqual(p['rosGP'],18)
            else:self.assertIsNone(p['rosGP']);self.assertEqual(result['players']['1']['tier'],'extended')

    def test_rookie_product_prior_does_not_use_transferred_last_team_full_season(self):
        from generate_projection_scenarios import rookie_attendance
        corpus={'cohorts':{str(y):[] for y in range(2013,2019)},'schedules':{str(y):{} for y in range(2013,2019)}}
        corpus['schedules']['2013']={'a':{'date':'2013-01-01','teams':[1,2],'excluded':None},'b':{'date':'2013-01-02','teams':[1,2],'excluded':None}}
        def g(pid,key,day,team):return {'id':pid,'gameId':key,'date':f'2013-01-0{day}','teamId':team}
        corpus['cohorts']['2013']=[{'id':'1','profile':{},'games':[g('1','a',1,1)]},{'id':'2','profile':{},'games':[g('2','a',1,1),g('2','b',2,2)]}]
        r=rookie_attendance(corpus)
        self.assertEqual(r['all']['episodes'],1);self.assertEqual(r['all']['rate'],.5)

    def test_unknown_transfer_gp_does_not_discard_known_rookie_conditional_performance(self):
        from test_projection_scenarios import profile
        standard,_,now,others,_=self.product_fixture()
        row=next(r for r in standard['players'] if r['id']=='1')
        row.update(status='unavailable',reason='NBA sample below standard threshold',stats=None,minutes=None,rosGP=None)
        a=json.loads((Path(__file__).resolve().parents[2]/'scripts/scenario-model-artifacts.json').read_text())
        future={'asOf':'2027-01-31','through':'2027-04-11','games':[{'id':'future','date':'2027-02-01','teamIds':[2,30]}]}
        result=build(standard,{}, {'1':[now[0],now[-1]],'99':others},future,{'players':{}},{'1':profile()},a['rookie'],a['returning'],a['rookieAttendancePriors'],'2027-01-31','2027-01-31T19:00:00Z')
        p=next(r for r in result['projection']['players'] if r['id']=='1')
        self.assertEqual(p['status'],'available');self.assertGreater(p['stats']['PTS'],0)
        self.assertIsNone(p['rosGP']);self.assertIsNone(result['players']['1']['opportunityEvidence']['count'])
        self.assertEqual(result['players']['1']['modelVersion'],'14.2-shadow-v1')


if __name__=='__main__': unittest.main()
