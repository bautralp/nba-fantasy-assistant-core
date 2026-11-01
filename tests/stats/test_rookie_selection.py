"""Individual-source regression contracts; all inputs are local and synthetic."""
from copy import deepcopy
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
from rookie_selection import select_season, season_gp
from test_rookie_revision import game


def profile(pid='3134907', year=2018, gp=77):
    return {'id':pid, 'uid':'s:40~l:46~a:'+pid, 'identityVerified':True,
            'careerSchemaVerified':True, 'careerSha256':'a'*64,
            'seasons':[{'year':year,'gp':gp}], 'displayDraft':f'{year-1}: Rd 1, Pk 27'}


def games(n=77, pid='3134907'):
    # Selection validates individual rows; schedule/date membership is validated
    # by nba_games before selection, so synthetic dates need not form a season.
    return [dict(game(1), id=pid, gameId=str(i+1), teamId=13) for i in range(n)]


class IndividualSelectionTests(unittest.TestCase):
    def test_kyle_kuzma_lakers_complete_gp_not_censored_by_brooklyn_draft(self):
        draft={'teamId':17,'verified':True,'draftYear':2017}
        result=select_season('3134907',2018,profile(),games(),draft)
        self.assertTrue(result['accepted'])
        self.assertEqual(result['verifiedGP'],77)
        draft['teamId']=2
        self.assertEqual(result,select_season('3134907',2018,profile(),games(),draft))
    def test_missing_individual_game_is_rejected(self):
        self.assertEqual(select_season('3134907',2018,profile(),games(76))['reason'],'individual-gp-mismatch')
    def test_duplicate_can_not_hide_a_missing_game_with_equal_count(self):
        rows=games();rows[-1]=deepcopy(rows[0])
        self.assertEqual(select_season('3134907',2018,profile(),rows)['reason'],'duplicate-player-game')
    def test_shooting_inconsistency_rejected_even_when_gp_matches(self):
        rows=games();rows[-1]['stats']={**rows[-1]['stats'],'PTS':99}
        self.assertEqual(select_season('3134907',2018,profile(),rows)['reason'],'inconsistent-individual-statistics')
    def test_filtered_bad_row_still_disqualifies_the_player_season(self):
        self.assertFalse(select_season('3134907',2018,profile(),games(),unusable=True)['accepted'])
    def test_wrong_native_nba_identity_rejected(self):
        p=profile();p['uid']='s:40~l:41~a:3134907'
        self.assertEqual(select_season('3134907',2018,p,games())['reason'],'unverified-nba-identity')
    def test_veteran_career_start_rejected(self):
        p=profile();p['seasons'].append({'year':2016,'gp':4})
        self.assertEqual(select_season('3134907',2018,p,games())['reason'],'unverified-career-start')
    def test_prior_box_appearance_overrides_debut_metadata(self):
        p=profile();p['nbaHistory']={'2016':1}
        self.assertEqual(select_season('3134907',2018,p,games())['reason'],'earlier-nba-appearance')
    def test_missing_gp_is_not_zero(self):
        p=profile(gp=0);p['seasons']=[]
        self.assertEqual(select_season('3134907',2018,p,[])['reason'],'missing-season-gp')
    def test_missing_schema_is_not_accepted_from_draft(self):
        p=profile();p['careerSchemaVerified']=False
        self.assertFalse(select_season('3134907',2018,p,games(),{'verified':True})['accepted'])
    def test_explicit_zero_requires_independent_verified_draft(self):
        p=profile(gp=0)
        self.assertFalse(select_season('3134907',2018,p,[])['accepted'])
        self.assertTrue(select_season('3134907',2018,p,[],{'verified':True,'draftYear':2017})['accepted'])
    def test_explicit_total_and_team_splits_reconciled_without_max_only_rule(self):
        p=profile(gp=26);p['seasons']=[{'year':2018,'gp':n} for n in (18,8,26)]
        rows=games(26)
        for g in rows[18:]:g['teamId']=20
        self.assertEqual(season_gp(p,2018,rows),(26,'explicit-total-reconciled-with-team-splits'))
        p['seasons'][0]['gp']=17
        self.assertIsNone(season_gp(p,2018,rows)[0])
    def test_source_total_is_not_synthesized_from_only_team_rows(self):
        p=profile();p['seasons']=[{'year':2018,'gp':n} for n in (18,8)]
        rows=games(26)
        for g in rows[18:]:g['teamId']=20
        self.assertIsNone(season_gp(p,2018,rows)[0])
    def test_correct_sum_without_matching_observed_team_counts_is_not_proof(self):
        p=profile();p['seasons']=[{'year':2018,'gp':n} for n in (18,8,26)]
        self.assertIsNone(season_gp(p,2018,games(26))[0])
    def test_player_gp_is_not_capped_by_one_franchises_82_game_schedule(self):
        # Trades can make a player's verified season GP exceed a single team's
        # fixture count. The independent source and actual records must agree.
        self.assertTrue(select_season('3134907',2018,profile(gp=83),games(83))['accepted'])
    def test_noninteger_and_nonfinite_gp_rejected(self):
        for gp in (float('nan'),float('inf'),2.5,-1,True):
            self.assertIsNone(season_gp(profile(gp=gp),2018,[])[0])


class MethodologyBoundaryTests(unittest.TestCase):
    def test_changed_selection_never_refits_or_consumes_legacy_holdout(self):
        import json
        import tempfile
        from unittest.mock import patch
        from evaluate_rookie_revision import run
        from rookie_selection import POLICY
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source';output=root/'result';source.mkdir()
            (source/'cohorts.json').write_text(json.dumps({'selectionPolicy':POLICY}))
            # No collection summary or holdout is present: the guard must return
            # before reading them, validating outcomes, fitting or tuning.
            with patch('evaluate_rookie_revision.fit',side_effect=AssertionError('fit forbidden')), \
                 patch('evaluate_rookie_revision.tune',side_effect=AssertionError('tune forbidden')), \
                 patch('evaluate_rookie_revision.conditional_evaluate',side_effect=AssertionError('holdout forbidden')):
                run(source,output)
            result=json.loads((output/'rookie-selection-evaluation-status.json').read_text())
            self.assertEqual(result['status'],'requires-new-evaluation-protocol')
            self.assertFalse(result['productionEnabled'])
            self.assertFalse(result['parametersChanged'])
            self.assertFalse(result['newIndependentAccuracyEvidence'])
            self.assertFalse((output/'rookie-revision-backtest.json').exists())
    def test_publication_never_pairs_new_corpus_with_stale_legacy_results(self):
        import json
        import tempfile
        from publish_rookie_research import artifact_names
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'cohorts.json').write_text(json.dumps({'selectionPolicy':{'version':'individual-gp-v1'}}))
            names=artifact_names(root)
            self.assertNotIn('rookie-revision-backtest.json',names)
            self.assertNotIn('rookie-revision-parameters.json',names)
            self.assertIn('rookie-selection-evaluation-status.json',names)
            (root/'cohorts.json').write_text('{}')
            self.assertIn('rookie-revision-backtest.json',artifact_names(root))

if __name__=='__main__':unittest.main()
