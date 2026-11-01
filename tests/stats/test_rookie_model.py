"""Synthetic edge cases are not evidence of real player or calibration coverage."""
from copy import deepcopy
from datetime import date
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from test_ros_model import games
from rookie_model import classify, prior_for, infer, load_artifacts
from ros_model import project, role_model
from calibrate_rookies import ncaa_profile, predictions, evaluate


def profile():
    return {'id':'1','identityVerified':True,'careerSchemaVerified':True,'displayDraft':'2026: Rd 1, Pk 4 (CHI)',
        'displayExperience':'Rookie','seasons':[], 'nbaHistory':{}, 'historyCoverage':[2023,2024,2025,2026],
        'retrievedAt':'2026-10-22T00:00:00Z','priorPosition':'unknown'}


def parameters():
    # Actual versioned calibration; only the release gate is opened in isolated tests.
    _, p = load_artifacts()
    return {**deepcopy(p), 'enabled':True}


class RookieTests(unittest.TestCase):
    def test_existing_problem_at_five_games_eighty_minutes(self):
        current=games(5,16)
        result=project([],current)
        self.assertEqual(result['status'],'available')
        self.assertEqual(result['minutes'],16)
        for k in ('PTS','REB','AST','STL','BLK','TO','FGA'):
            self.assertAlmostEqual(result['stats'][k],current[0]['stats'][k])

    def test_gap_veteran_and_stale_rookie_label(self):
        p=profile();p['seasons']=[{'year':2024,'gp':60}]
        self.assertEqual(classify(p,[],games(1)),'returning-veteran')
        self.assertEqual(classify(profile(),[],[]),'rookie')
        p=profile();p['displayExperience']=None
        self.assertEqual(classify(p,[],[]),'unknown')
        self.assertEqual(classify(None,[],[]),'unknown')
        p=profile();p['seasons']=[{'year':2026,'gp':20}]
        self.assertEqual(classify(p,games(20),[]),'limited-experience')
        p['seasons']=[{'year':2018,'gp':75},{'year':2026,'gp':70}]
        self.assertEqual(classify(p,games(70),[]),'veteran')

    def test_first_game_not_required_with_validated_prior(self):
        p=parameters();r=project([],[],profile=profile(),rookie_parameters=p)
        self.assertEqual(r['status'],'available');self.assertEqual(r['confidence'],'low')
        self.assertTrue(all(w==0 for w in r['rookieWeights'].values()))
        self.assertGreater(r['minutes'],0);self.assertEqual(r['projectionBasis'],'Rookie prior')

    def test_category_shrinkage_at_each_checkpoint(self):
        params=parameters();prior=prior_for(profile(),params);previous_weights={}
        for n in (1,3,5,10,20):
            result=infer(prior,games(n),params)
            for k,w in result['rookieWeights'].items():
                self.assertGreater(w,previous_weights.get(k,-1));self.assertLess(w,1)
            self.assertGreater(len(set(result['rookieWeights'].values())),2)
            previous_weights=result['rookieWeights']
            s=result['stats'];self.assertLessEqual(s['FGM'],s['FGA']);self.assertLessEqual(s['FTM'],s['FTA']);self.assertLessEqual(s['3PM'],s['FGM'])
            self.assertAlmostEqual(s['PTS'],2*s['FGM']+s['3PM']+s['FTM'])

    def test_ncaa_crosswalk_is_explicit_and_wrong_id_rejected(self):
        p=profile();rows=games(30,start='2025-10-01')
        for g in rows:g['position']='G'
        self.assertIsNone(ncaa_profile(p,{'1':rows},'2026-07-01'))
        p['collegeAthlete']={'id':'2'}
        self.assertIsNone(ncaa_profile(p,{'1':rows},'2026-07-01'))
        for g in rows:g['id']='2'
        c=ncaa_profile(p,{'2':rows},'2026-07-01');self.assertEqual(c['id'],'2')
        p['ncaa']=c;params=parameters();params['ncaaEnabled']=True
        # Synthetic fit exercises integration only; real training had insufficient pairs.
        params['ncaaFits']={'AST':{'slope':0.5,'intercept':0.01}}
        self.assertEqual(prior_for(p,params)['basis'],'NCAA-assisted')
        p['ncaa']['id']='3'
        with self.assertRaisesRegex(ValueError,'crosswalk'):prior_for(p,params)
        with self.assertRaisesRegex(ValueError,'ID mismatch'):classify({'id':'2'},[],games(1))

    def test_international_professional_requires_evidence(self):
        p=profile();p['preNBALeague']='international-pro'
        self.assertEqual(classify(p,[],[]),'rookie')
        p['preNBALeagueSource']='https://example.test/verified-club'
        self.assertEqual(classify(p,[],[]),'international-newcomer')
        self.assertEqual(project([],[],profile=p,rookie_parameters=parameters())['status'],'available')
        # No NCAA history is not proof of playing professionally overseas.
        self.assertEqual(classify(profile(),[],[]),'rookie')

    def test_disabled_prior_does_not_silently_activate(self):
        _,params=load_artifacts();self.assertFalse(params['enabled'])
        self.assertEqual(project([],games(5),profile=profile(),rookie_parameters=params)['status'],'unavailable')
        p=profile();p['displayDraft']=None
        self.assertIsNone(prior_for(p,parameters()))

    def test_experienced_and_injured_returnee_formula_unchanged(self):
        past,current=games(70),games(3)
        p=profile();p['seasons']=[{'year':2019,'gp':60},{'year':2026,'gp':70}]
        self.assertEqual(project(past,current),project(past,current,profile=p,rookie_parameters=parameters()))
        p['seasons']=[{'year':2024,'gp':60}]
        self.assertEqual(project([],games(5)),project([],games(5),profile=p,rookie_parameters=parameters()))

    def test_first_game_role_observed_but_temporary_change_bounded(self):
        p=parameters();prior=prior_for(profile(),p)
        result=infer(prior,games(1,40,True),p)
        self.assertEqual(result['rookieRole']['starterRate'],1)
        self.assertLess(result['minutes'],40)
        self.assertLess(result['rookieRole']['appliedWeight'],1)
        self.assertEqual(role_model(games(50),games(1,40,True))['score'],0)

    def test_future_ncaa_and_nba_not_passed_to_prediction(self):
        p=profile();p['collegeAthlete']={'id':'1'};rows=games(30,start='2026-08-01')
        self.assertIsNone(ncaa_profile(p,{'1':rows},'2026-07-01'))
        row={'profile':profile(),'games':games(50),'id':'1'}
        from rookie_model import infer as original
        for n in (0,1,3,5,10,20):
            def checked(prior, observed, params, **kw):
                self.assertEqual(observed,row['games'][:n]);return original(prior,observed,params,**kw)
            with patch('calibrate_rookies.infer',side_effect=checked):predictions(row,n,parameters(),'role')
        self.assertEqual(evaluate([row],parameters())[0]['mae']['earlyNBA']['MIN'],None)

    def test_release_gate_and_corrupt_parameters_reject_before_publish(self):
        from rookie_model import validate_parameters
        _,real=load_artifacts()
        bad=deepcopy(real);bad['enabled']=True
        with self.assertRaisesRegex(ValueError,'release gate'):validate_parameters(bad)
        for field in ('minutesK','roleWeight'):
            bad=deepcopy(real);bad[field]=float('nan')
            with self.assertRaises(ValueError):validate_parameters(bad)
        # Same publication boundary as daily generation: validator failure retains old bytes.
        from generate_projections import publish
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'last-valid.json';path.write_text('{"asOf":"2026-10-22","players":[]}')
            before=path.read_bytes()
            with patch('generate_projections.subprocess.run',side_effect=ValueError('rookie metadata rejected')):
                with self.assertRaises(ValueError):publish({'asOf':'2026-10-22','players':[]},path)
            self.assertEqual(path.read_bytes(),before)

    def test_backtest_uses_paired_player_and_percentage_denominators(self):
        params=parameters()
        valid={'id':'1','profile':profile(),'games':games(50)}
        invalid={'id':'2','profile':{**profile(),'displayDraft':None},'games':games(50)}
        r=evaluate([valid,invalid],params)
        for row in r:
            self.assertEqual(row['players'],1)
            self.assertEqual(row['excludedNoVerifiedPrior'],['2'])
            if row['nbaGames']:
                self.assertEqual(row['metricCounts']['earlyNBA'],row['metricCounts']['role'])
        p=profile();p['seasons']=[{'year':2026,'gp':20},{'year':2026,'gp':20},{'year':2026,'gp':40}]
        self.assertEqual(classify(p,[],[]),'limited-experience')

    def test_bounded_boxscore_history_cannot_prove_second_year_status(self):
        # 2023-26 boxscores cannot rule out NBA appearances before 2023.
        p=profile();p['careerSchemaVerified']=False;p['nbaHistory']={'2025':5,'2026':5}
        self.assertEqual(classify(p,[],[]),'veteran')
        p['careerSchemaVerified']=True;p['seasons']=[{'year':2025,'gp':5},{'year':2026,'gp':5}]
        self.assertEqual(classify(p,[],[]),'limited-experience')
