"""Evaluation contracts: no future features, no survivor filter, distinct availability."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from evaluate_rookie_revision import observation, conditional_evaluate, availability_evaluate, fit, predict, validate_corpus
from rookie_model import RATE_KEYS, KINDS
from finalize_rookie_revision import migrate
from projection_replay_inputs import load_inputs
from copy import deepcopy
from collect_rookie_revision import nba_games, CoverageGap, is_nba_appearance
from refresh_stats import FIELDS
from datetime import date

def game(n,minutes=20):
    return {'id':'1','gameId':str(n),'date':f'2020-01-{n:02d}','teamId':1,'minutes':minutes,'starter':False,
            'stats':{'2PA':5,'2PM':3,'3PA':2,'3PM':1,'FGM':4,'FGA':7,'FTM':2,'FTA':2,'PTS':11,'REB':4,'AST':2,'STL':1,'BLK':0,'TO':1}}
def schedule():
    return {str(n):{'date':f'2020-01-{n:02d}','teams':[1,2],'excluded':None} for n in range(1,31)}
def row(games):
    return {'id':'1','year':2020,'draft':{'teamId':1},'games':games,
            'profile':{'id':'1','identityVerified':True,'displayDraft':'2019: Rd 1, Pk 1','priorPosition':'unknown'}}
def parameters():
    prior={'minutes':20,'rates':{k:.1 for k in RATE_KEYS},'percentages':{k:.5 for k in KINDS},'players':40}
    return {'priors':{'all':prior},'ncaaEnabled':False,'ncaaFits':{},'minutesK':10,
            'rateK':{k:600 for k in RATE_KEYS},'shootingK':{k:100 for k in KINDS},'roleWeight':0}

class RevisionEvaluationTests(unittest.TestCase):
    def test_rising_stars_or_gleague_minutes_do_not_prove_nba_experience(self):
        row={'athlete_id':'1','season_type':2,'did_not_play':False,'minutes':20,
             'team_id':111387,'opponent_team_id':111386}
        self.assertFalse(is_nba_appearance(row))
        row.update(team_id=1,opponent_team_id=2)
        self.assertTrue(is_nba_appearance(row))
    def test_partial_league_source_reports_missing_teams_without_inventing_games(self):
        events={'1':{'date':'2020-01-01','teams':[1,2],'excluded':None},
                '2':{'date':'2020-01-02','teams':[3,4],'excluded':None}}
        rows=[]
        for team in (1,2):
            r={field:game(1)['stats'][key] for key,field in FIELDS.items()}
            r.update(season=2020,season_type=2,game_id=1,game_date=date(2020,1,1),
                     team_id=team,opponent_team_id=3-team,athlete_id=str(team),
                     minutes=20,did_not_play=False,three_point_field_goals_attempted=2)
            rows.append(r)
        with self.assertRaises(CoverageGap) as error:nba_games(rows,events,2020)
        self.assertEqual(error.exception.detail['affectedTeams'],[3,4])
        self.assertEqual(error.exception.detail['missingGames'],['2'])
        self.assertEqual(set(error.exception.games),{'1','2'})
        self.assertTrue(all(g['gameId']=='1' for games in error.exception.games.values() for g in games))
    def test_corpus_rejects_future_ncaa_and_wrong_player_identity(self):
        r=row([game(1)])
        r['profile']['collegeAthlete']={'id':'99'}
        r['profile']['ncaa']={'id':'99','through':'2020-01-01'}
        raw={'cohorts':{'2020':[r]},'schedules':{'2020':schedule()}}
        with self.assertRaisesRegex(ValueError,'future leakage'):validate_corpus(raw)
        r['profile']['ncaa']['through']='2019-03-01'
        validate_corpus(raw)
        r['games'][0]['id']='2'
        with self.assertRaisesRegex(ValueError,'player/season'):validate_corpus(raw)
    def assert_metadata_migration(self, snapshot):
        root=Path(__file__).resolve().parents[2]
        profiles=json.loads((root/'scripts/rookie-profiles.json').read_text())
        params=json.loads((root/'scripts/rookie-parameters.json').read_text())
        before=deepcopy(snapshot)
        annotated,coverage=migrate(snapshot,profiles,params)
        expected_ids=[p['id'] for p in before['players']]
        actual_ids=[p['id'] for p in annotated['players']]
        self.assertTrue(expected_ids)
        self.assertTrue(all(isinstance(pid,str) and pid.isdigit() for pid in expected_ids))
        self.assertEqual(len(set(expected_ids)),len(expected_ids))
        self.assertEqual(len(set(actual_ids)),len(actual_ids))
        self.assertEqual(len(actual_ids),len(expected_ids))
        self.assertEqual(actual_ids,expected_ids)
        # Independent oracle: do not reuse the migration's protected() implementation.
        metadata={'experience','projectionBasis','verifiedSourceDate','experienceReason',
                  'draftIdentityVerified','nbaEntryVerified','uncertainty'}
        for original,result in zip(before['players'],annotated['players']):
            self.assertEqual({k:v for k,v in original.items() if k not in metadata},
                             {k:v for k,v in result.items() if k not in metadata},original['id'])
        self.assertEqual({k:v for k,v in before.items() if k not in ('players','rookieModel')},
                         {k:v for k,v in annotated.items() if k not in ('players','rookieModel')})
        self.assertEqual(snapshot,before)
        self.assertEqual(coverage['poolSize'],len(expected_ids))
        self.assertEqual(coverage['newProductionProjections'],0)
        params['enabled']=True
        with self.assertRaisesRegex(ValueError,'cannot enable'):migrate(snapshot,profiles,params)

    def test_metadata_migration_preserves_current_pool_and_rejects_activation(self):
        root=Path(__file__).resolve().parents[2]
        self.assert_metadata_migration(json.loads((root/'public/data/player-projections.json').read_text()))

    def test_metadata_migration_preserves_the_archived_1126_player_pool(self):
        snapshot=json.loads(load_inputs()['files']['player-projections.json'])
        self.assertEqual(len(snapshot['players']),1126)  # Historical fact, not a live-pool constraint.
        self.assert_metadata_migration(snapshot)
    def test_one_future_appearance_is_conditional_target(self):
        reports=conditional_evaluate([row([game(1),game(3)])],{'2020':schedule()},parameters())
        checkpoint=next(r for r in reports if r['nbaGames']==1)
        self.assertEqual(checkpoint['players'],1)
        self.assertEqual(checkpoint['mae']['earlyNBA']['PTS'],0)
    def test_zero_future_and_never_appeared_stay_in_availability(self):
        rows=[row([]),row([game(1)])]
        cells={str(n)+':all':{'rate':.4,'any':.5} for n in (0,1,3,5,10,20)}
        reports=availability_evaluate(rows,{'2020':schedule()},parameters(),cells,20)
        self.assertEqual(reports[0]['players'],2);self.assertEqual(reports[0]['neverNBA'],1)
        self.assertEqual(reports[1]['zeroFutureAppearances'],1)
        self.assertIsNotNone(reports[1]['mae']['rookie']['Brier'])
    def test_prediction_uses_only_reached_checkpoint(self):
        original=row([game(n) for n in range(1,25)])
        before=predict(original,3,parameters(),'role')
        original['games'][3:]=[game(n,40) for n in range(4,25)]
        self.assertEqual(before,predict(original,3,parameters(),'role'))
        view=observation(original,3,schedule())
        self.assertEqual(len(view['observed']),3);self.assertEqual(view['elapsed'],3)
    def test_fixed_prior_is_distinct_from_observed_sample_shrinkage(self):
        r=row([game(n,40) for n in range(1,22)])
        self.assertEqual(predict(r,0,parameters(),'fixedPrior'),predict(r,20,parameters(),'fixedPrior'))
        self.assertNotEqual(predict(r,0,parameters(),'draftPrior'),predict(r,20,parameters(),'draftPrior'))
    def test_missing_draft_team_not_reconstructed_from_future(self):
        r=row([game(10)]);r['draft']['teamId']=None
        self.assertIsNone(observation(r,0,schedule()))
        self.assertIsNotNone(observation(r,1,schedule()))
    def test_sparse_ncaa_and_position_groups_do_not_create_submodels(self):
        r=row([game(1)]);r['profile']['ncaa']={'rates':{k:.1 for k in RATE_KEYS}}
        priors,fits,pairs=fit([r],30,75)
        self.assertEqual(set(priors),{'all'});self.assertEqual(fits,{});self.assertEqual(pairs,1)
        r['profile']['priorPosition']=None
        self.assertEqual(set(fit([r],30,75)[0]),{'all'})
        self.assertIsNotNone(predict(r,0,parameters(),'draftPrior'))
    def test_shooting_prior_pools_attempts_without_zero_attempt_percentage_bias(self):
        first=row([game(1)]);second=row([game(2)])
        second['games'][0]['stats'].update(FTM=0,FTA=0,PTS=9)
        priors,_,_=fit([first,second],30,75)
        self.assertEqual(priors['all']['percentages']['FT'],1)
    def test_trade_outcome_does_not_change_checkpoint_team(self):
        r=row([game(1),dict(game(3),teamId=3)])
        view=observation(r,1,schedule())
        self.assertEqual(view['remaining'],29);self.assertTrue(view['tradeOutcome'])

if __name__=='__main__':unittest.main()
