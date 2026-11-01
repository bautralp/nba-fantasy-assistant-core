"""Analytical contract fixtures are synthetic; real-league replay is separate CI."""
import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from generate_projection_scenarios import adjust_role,attendance,build
from preseason_projection_snapshot import initial_snapshot
from rookie_model import infer,prior_for
from returning_veteran import observed_anchor,conditional_performance
from test_returning_veteran import games

ROOT=Path(__file__).resolve().parents[2]
ART=json.loads((ROOT/'scripts/scenario-model-artifacts.json').read_text())
ASOF='2026-10-01'


def evidence():
    return {'espnId':'1','nbaTeamId':1,'status':'active','observedAt':'2026-10-01T12:00:00Z','validUntil':'2026-10-01','depthRanks':[{'position':'pg','rank':1}],'minuteRestriction':None,'injuryStatus':None,'sources':[{'url':'https://example.invalid/synthetic','observedAt':'2026-10-01T12:00:00Z','sha256':'a'*64}],'preseason':[]}


def profile():
    return {'id':'1','identityVerified':True,'retrievedAt':'2026-09-30T00:00:00Z','displayDraft':'2026: Rd 1, Pk 7','nbaEntryVerified':True,'draftIdentity':{'verified':True,'playerId':'1','year':2026,'retrievedAt':'2026-09-30T00:00:00Z'},'priorPosition':'G','historyCoverage':[2023,2024,2025,2026]}


class ScenarioTests(unittest.TestCase):
    def unified_fixture(self):
        template=json.loads((ROOT/'public/data/player-projections.json').read_text())
        catalog={'players':[{'playerId':'1','name':'Synthetic veteran','positions':['PG'],'status':'verified','season':'2026-27','provider':'ESPN Fantasy FBA','source':'https://example.invalid/synthetic','retrievedAt':'2026-09-30T00:00:00Z','proTeamId':1}]}
        history={'1':{2026:games(year=2025)}}
        schedule={'asOf':ASOF,'through':'2027-04-11','games':[{'id':str(i),'date':'2026-10-20','teamIds':[1,2]} for i in range(40)]}
        standard=initial_snapshot(template,catalog,history,schedule,ASOF,ASOF+'T14:00:00Z')
        def run(base=standard, roles=None, histories=history, profiles=None):
            return build(base,histories,{},schedule,roles or {'players':{'1':evidence()}},profiles or {},ART['rookie'],ART['returning'],ART['rookieAttendancePriors'],ASOF,ASOF+'T15:00:00Z')
        return standard,run

    def test_complete_standard_never_calls_extended_performance_or_role(self):
        from unittest.mock import patch
        base,run=self.unified_fixture()
        for name in ('infer','project','conditional_performance','adjust_role','attendance'):
            with patch('generate_projection_scenarios.'+name,side_effect=AssertionError('complete standard rerouted')):
                result=run()
                self.assertEqual(result['projection']['players'],base['players'])
                self.assertEqual(result['players']['1']['tier'],'standard')

    def test_only_gp_missing_preserves_every_performance_field(self):
        from unittest.mock import patch
        base,run=self.unified_fixture();base['players'][0]['rosGP']=None
        original=copy.deepcopy(base['players'][0])
        with patch('generate_projection_scenarios.adjust_role',side_effect=AssertionError('GP must not alter rates')):
            result=run()['projection']['players'][0]
        self.assertGreater(result['rosGP'],0)
        for key in ('stats','shooting','minutes','role','projectionBasis'):
            self.assertEqual(result.get(key),original.get(key))

    def test_known_zero_never_receives_positive_gp(self):
        base,run=self.unified_fixture();base['players'][0]['rosGP']=0
        self.assertEqual(run()['projection']['players'][0],base['players'][0])
        e=evidence();e['seasonOut']=True
        self.assertEqual(run(roles={'players':{'1':e}})['projection']['players'][0]['rosGP'],0)
        base['players'][0]['eligibility']['proTeamId']=0
        self.assertEqual(run(roles={'players':{}})['projection']['players'][0]['rosGP'],0)

    def test_known_zero_survives_unknown_attendance_scope(self):
        from unittest.mock import patch
        from attendance_opportunities import observed_opportunities
        base,run=self.unified_fixture();base['players'][0]['rosGP']=0
        scope=observed_opportunities('1',[],[],None,ASOF)
        with patch('generate_projection_scenarios.observed_opportunities',return_value=scope):
            result=run()['projection']['players'][0]
        self.assertEqual(result,base['players'][0])

    def test_missing_returner_uses_existing_model_and_keeps_known_gp(self):
        base,run=self.unified_fixture();row=base['players'][0]
        row.update(status='unavailable',stats=None,minutes=None,rosGP=3,reason='Insufficient standard history')
        result=run(histories={'1':{2025:games(year=2025),2026:[]}})
        p=result['projection']['players'][0]
        self.assertEqual(p['status'],'available');self.assertEqual(p['rosGP'],3)
        self.assertEqual(result['players']['1']['modelVersion'],ART['returning']['version'])
        self.assertAlmostEqual(p['stats']['PTS'],2*p['stats']['FGM']+p['stats']['3PM']+p['stats']['FTM'])

    def test_identity_and_team_conflicts_never_create_usable_projection(self):
        base,run=self.unified_fixture();e=evidence();e['nbaTeamId']=2
        result=run(roles={'observedAt':ASOF+'T12:00:00Z','players':{'1':e}})
        self.assertEqual(result['projection']['players'][0]['status'],'unavailable')
        self.assertIsNone(result['projection']['players'][0]['rosGP'])
        e['seasonOut']=True
        conflict=run(roles={'observedAt':ASOF+'T12:00:00Z','players':{'1':e}})['projection']['players'][0]
        self.assertIsNone(conflict['rosGP']);self.assertIsNone(conflict['teamRemaining'])
        e=evidence();e['espnId']='2'
        with self.assertRaisesRegex(ValueError,'identity'):run(roles={'players':{'1':e}})

    def test_zero_game_rookie_and_gradual_1_to_20(self):
        prior=prior_for(profile(),ART['rookie']);last=0
        for n in (0,1,2,3,4,5,10,20):
            r=infer(prior,games(year=2026,n=n),ART['rookie'],False)
            self.assertGreater(r['stats']['PTS'],0);self.assertGreaterEqual(r['rookieWeights']['minutes'],last)
            self.assertAlmostEqual(r['rookieWeights']['minutes'],n/(n+ART['rookie']['minutesK']))
            last=r['rookieWeights']['minutes']

    def test_zero_game_returner_has_conditional_performance(self):
        anchor=observed_anchor({2025:games(year=2025)},2027)
        r=conditional_performance(anchor,[],ART['returning'],ASOF)
        self.assertGreater(r['minutes'],0);self.assertGreater(r['stats']['PTS'],0)
        self.assertEqual(r['currentMinutesWeight'],0);self.assertEqual(r['historyYears'],[2025])

    def test_preseason_changes_only_minutes_not_rates_or_regular_gp(self):
        prior=prior_for(profile(),ART['rookie']);base=infer(prior,[],ART['rookie'],False);e=evidence()
        e['preseason']=[{'gameId':'10','date':'2026-09-30','seasonType':1,'teamId':1,'minutes':30,'starter':True}]
        r,use=adjust_role(base,e,[],ASOF)
        self.assertIn('observed-preseason-minutes',use['used']);self.assertEqual(use['regularGamesAlreadyInPerformance'],0)
        self.assertAlmostEqual(r['stats']['STL']/r['minutes'],base['stats']['STL']/base['minutes'])
        self.assertAlmostEqual(r['stats']['FGM']/r['stats']['FGA'],base['stats']['FGM']/base['stats']['FGA'])
        self.assertAlmostEqual(r['stats']['PTS'],2*r['stats']['FGM']+r['stats']['3PM']+r['stats']['FTM'])

    def test_future_depth_and_preseason_are_not_used(self):
        base=infer(prior_for(profile(),ART['rookie']),[],ART['rookie'],False);e=evidence();e['observedAt']='2026-10-02T00:00:00Z'
        r,use=adjust_role(base,e,[],ASOF);self.assertEqual(r,base);self.assertEqual(use['used'],[])
        e=evidence();e['depthRanks']=[];e['preseason']=[{'gameId':'10','date':'2026-10-02','seasonType':1,'teamId':1,'minutes':38}]
        r,use=adjust_role(base,e,[],ASOF);self.assertEqual(use['weight'],0)

    def test_role_and_trade_scope_and_minutes_restriction(self):
        base=infer(prior_for(profile(),ART['rookie']),[],ART['rookie'],False);e=evidence();e['depthRanks']=[]
        e['preseason']=[{'gameId':'10','date':'2026-09-30','seasonType':1,'teamId':2,'minutes':40}]
        r,use=adjust_role(base,e,[],ASOF);self.assertEqual(use['weight'],0)
        e['minuteRestriction']=12;r,_=adjust_role(base,e,[],ASOF);self.assertLessEqual(r['minutes'],12)

    def test_unassigned_zero_unknown_null_and_injury_uncertainty(self):
        prior=ART['rookieAttendancePriors']['all'];e=evidence()
        self.assertEqual(attendance('rookie',{},[],0,0,0,e,ASOF,prior)['expectedGames'],0)
        self.assertIsNone(attendance('rookie',{},[],None,None,0,e,ASOF,prior))
        r=attendance('rookie',{},[],1,80,0,e,ASOF,prior);self.assertGreater(r['expectedGames'],0);self.assertLessEqual(max(r['range']),80)
        e['injuryStatus']='Out';injured=attendance('rookie',{},[],1,80,0,e,ASOF,prior)
        self.assertLess(injured['expectedGames'],r['expectedGames']);self.assertGreater(injured['expectedGames'],0)
        self.assertTrue(any('unknown injury' in a for a in injured['assumptions']))

    def test_unknown_historical_year_is_not_an_observed_zero_season(self):
        prior=ART['rookieAttendancePriors']['all'];h={2025:games(year=2025)}
        unknown=attendance('returning-veteran',h,[],1,80,0,None,ASOF,prior,season_ending_year=2027)
        zero=attendance('returning-veteran',{**h,2026:[]},[],1,80,0,None,ASOF,prior,season_ending_year=2027)
        self.assertAlmostEqual(unknown['priorRate'],zero['priorRate']*2)

    def test_season_ending_year_not_calendar_year_controls_return_gap(self):
        history={2025:games(year=2025)};prior=ART['rookieAttendancePriors']['all']
        a=attendance('returning-veteran',history,[],1,70,0,None,'2026-12-01',prior,season_ending_year=2027)
        b=attendance('returning-veteran',history,[],1,70,0,None,'2027-01-01',prior,season_ending_year=2027)
        self.assertEqual(a['priorRate'],b['priorRate'])

    def test_preseason_factory_never_reads_future_template_player_stats(self):
        template=json.loads((ROOT/'public/data/player-projections.json').read_text())
        catalog={'players':[{'playerId':'1','name':'Synthetic veteran','positions':['PG'],'status':'verified','season':'2026-27','provider':'ESPN Fantasy FBA','source':'https://example.invalid/synthetic','retrievedAt':'2026-09-30T00:00:00Z','proTeamId':1}]}
        history={'1':{2026:games(year=2026)}};schedule={'asOf':ASOF,'through':'2027-04-11','games':[{'id':'2','date':'2026-10-20','teamIds':[1,2]}]}
        before=copy.deepcopy(template)
        r=initial_snapshot(template,catalog,history,schedule,ASOF,'2026-10-01T14:00:00Z')
        self.assertEqual(template,before);self.assertEqual(len(r['players']),1);self.assertGreater(r['players'][0]['minutes'],0)
        self.assertLessEqual(r['players'][0]['rosGP'],1)
        catalog['players'][0]['retrievedAt']='2026-10-02T00:00:00Z'
        with self.assertRaisesRegex(ValueError,'Future'):initial_snapshot(template,catalog,history,schedule,ASOF,'2026-10-01T14:00:00Z')

    def test_same_product_router_runs_before_preseason_and_after_each_early_game(self):
        template=json.loads((ROOT/'public/data/player-projections.json').read_text())
        catalog={'players':[{'playerId':'1','name':'Synthetic rookie contract','positions':['PG'],'status':'verified','season':'2026-27','provider':'ESPN Fantasy FBA','source':'https://example.invalid/synthetic','retrievedAt':'2026-09-30T00:00:00Z','proTeamId':1}]}
        schedule={'asOf':ASOF,'through':'2027-04-11','games':[{'id':'2','date':'2026-10-20','teamIds':[1,2]}]}
        roles={'players':{'1':evidence()},'regularOpportunities':{'1':0}}
        roles['players']['1']['validUntil']='2026-10-31'
        for n in (0,1,2,3,4,5,10):
            observations=games(year=2026,n=n)
            for i,g in enumerate(observations):g['date']=f'2026-10-{20+i:02d}'
            cut=ASOF if n==0 else observations[-1]['date']
            current_schedule={**schedule,'asOf':cut,'games':[{'id':'next','date':'2026-11-10','teamIds':[1,2]}]}
            standard=initial_snapshot(template,catalog,{},current_schedule,cut,cut+'T14:00:00Z')
            roles['regularOpportunities']['1']=n
            result=build(standard,{}, {'1':observations},current_schedule,roles,{'1':profile()},ART['rookie'],ART['returning'],ART['rookieAttendancePriors'],cut,cut+'T14:00:00Z')
            p=result['projection']['players'][0]
            self.assertEqual(p['status'],'available');self.assertGreater(p['minutes'],0)
            self.assertEqual(result['players']['1']['modelVersion'],'14.2-shadow-v1')
            self.assertEqual(result['players']['1']['regularGP'],n)
        standard=initial_snapshot(template,catalog,{},schedule,ASOF,ASOF+'T14:00:00Z')
        future=profile();future['retrievedAt']='2026-10-02T00:00:00Z'
        result=build(standard,{}, {},schedule,roles,{'1':future},ART['rookie'],ART['returning'],ART['rookieAttendancePriors'],ASOF,'2026-10-01T14:00:00Z')
        self.assertIsNone(result['projection']['players'][0]['stats'])

    def test_preseason_is_verified_schedule_phase_not_missing_source(self):
        from projection_phase import before_regular_season
        from datetime import date
        raw=(ROOT/'tests/fixtures/ros-history/nba_schedule_2027.parquet').read_bytes()
        self.assertTrue(before_regular_season(raw,2027,date(2026,10,1)))
        self.assertFalse(before_regular_season(raw,2027,date(2026,10,25)))
        from projection_phase import empty_regular_games
        box=(ROOT/'tests/fixtures/ros-history/player_box_2027.parquet').read_bytes()
        self.assertEqual(empty_regular_games(box,2027,date(2026,10,1)),[])
        with self.assertRaises(ValueError):empty_regular_games(box,2027,date(2026,10,25))

    def test_verified_preseason_daily_path_preserves_actual_bytes_and_caches_only_verified_inputs(self):
        from daily_refresh_stats import run
        from datetime import datetime,timezone
        from types import SimpleNamespace
        import tempfile,shutil,gzip,base64
        fixture=json.loads(gzip.decompress((ROOT/'tests/fixtures/final-projections/observations.json.gz').read_bytes()))
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);inputs=root/'inputs';inputs.mkdir();boards=root/'boards';boards.mkdir()
            for stem in ('player_box','nba_schedule'):
                shutil.copyfile(ROOT/f'tests/fixtures/ros-history/{stem}_2026.parquet',inputs/f'{stem}_2026.parquet')
                (inputs/f'{stem}_2027.parquet').write_bytes(base64.b64decode(fixture['files'][f'{stem}_2027.parquet']))
            for day in range(10,17):(boards/f'espn-202610{day:02}.json').write_text(fixture['files'][f'preseason-board-{day}.json'])
            # Synthetic prior status sentinel: no player performance data fabricated.
            old={'periods':{'season':{'dataThrough':None}},'coverage':{'2026-27':{'games':0}},'refreshedAt':'2026-10-01T00:00:00Z'}
            output=root/'actual.json';output.write_text(json.dumps(old));before=output.read_bytes()
            args=SimpleNamespace(input_dir=inputs,output=output,scoreboard_dir=boards,report=root/'report.json',cache_dir=root/'cache')
            self.assertEqual(run(args,datetime(2026,10,17,12,tzinfo=timezone.utc)),0)
            report=json.loads(args.report.read_text());self.assertEqual(report['status'],'preseason-verified');self.assertFalse(report['published'])
            self.assertEqual(report['freshness']['expectedCompletedGames'],0);self.assertEqual(output.read_bytes(),before)
            self.assertTrue((args.cache_dir/'nba_schedule_2027.parquet').exists())
            (inputs/'player_box_2027.parquet').unlink();(args.cache_dir/'player_box_2027.parquet').unlink()
            self.assertEqual(run(args,datetime(2026,10,17,12,tzinfo=timezone.utc)),0)
            absent=json.loads(args.report.read_text())
            self.assertIsNone(absent['sources']['2026-27']['sha256'])
            self.assertEqual(absent['sources']['2026-27']['observationSource'],'not-published-no-expected-games')
            self.assertFalse((args.cache_dir/'player_box_2027.parquet').exists());self.assertEqual(output.read_bytes(),before)

    def test_standard_preseason_can_publish_without_an_unreleased_current_boxscore(self):
        from generate_projections import build as standard_build
        from ros_history_research import load_season
        from datetime import date
        games_,_,_=load_season(ROOT/'tests/fixtures/ros-history',2026)
        observed=next(g for g in reversed(games_) if g['id']=='3112335')
        catalog={'schemaVersion':1,'season':'2026-27','players':[{'playerId':'3112335','name':observed['name'],'positions':['C'],'status':'verified','season':'2026-27','provider':'ESPN Fantasy FBA','source':'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/players?view=kona_player_info','retrievedAt':'2026-10-16T00:00:00Z','proTeamId':observed['teamId']}]}
        contents={'2026-27':None,'2025-26':(ROOT/'tests/fixtures/ros-history/player_box_2026.parquet').read_bytes()}
        schedules={'2026-27':(ROOT/'tests/fixtures/ros-history/nba_schedule_2027.parquet').read_bytes(),'2025-26':(ROOT/'tests/fixtures/ros-history/nba_schedule_2026.parquet').read_bytes()}
        r=standard_build(contents,schedules,date(2026,10,17),'2026-10-17T12:00:00Z',catalog,({'profiles':{}},{'enabled':False,'version':'disabled'}))
        p=next(p for p in r['players'] if p['id']=='3112335')
        self.assertEqual(p['status'],'available');self.assertGreater(p['minutes'],0);self.assertGreater(p['rosGP'],0)
        self.assertEqual(r['coverage']['2026-27']['games'],0);self.assertEqual(len(r['sources']),4)
        self.assertFalse(any('player_box_2027' in s['url'] for s in r['sources']))
        self.assertTrue(any(s.get('encoding')=='canonical-normalized-identity-catalog' for s in r['sources']))
        with self.assertRaisesRegex(ValueError,'unavailable'):standard_build(contents,schedules,date(2026,10,25),'2026-10-25T12:00:00Z',catalog,({'profiles':{}},{'enabled':False,'version':'disabled'}))

    def test_rookie_scientific_gate_stays_closed(self):
        self.assertFalse(ART['rookie']['enabled']);self.assertFalse(ART['productionScientificGatesEnabled'])
        self.assertFalse(json.loads((ROOT/'scripts/rookie-parameters.json').read_text())['enabled'])

if __name__=='__main__':unittest.main()
