"""Pure attribution checks: no source access, holdout evaluation or imputation."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from analyze_rookie_source_impact import classify_effect, eligible_identity, identity_drafts, group, verify_unique_games

class SourceImpactTests(unittest.TestCase):
    def effect(self,**changes):
        data=dict(team_hit=True,unusable=False,identity_error=None,gp_gap=0,
                  missing_capacity=1,career_verified=True,partial=True,drafted=True)
        data.update(changes)
        return classify_effect(**data)
    def test_duplicate_rows_cannot_masquerade_as_complete_career_gp(self):
        verify_unique_games([{'gameId':'1'},{'gameId':'2'}])
        with self.assertRaisesRegex(ValueError,'Duplicate player-game'):
            verify_unique_games([{'gameId':'1'},{'gameId':'1'}])
    def test_reconciled_individual_is_lost_only_to_team_rule(self):
        self.assertEqual(self.effect(),'confirmed-team-exclusion-only')
    def test_invalid_stats_are_not_counted_as_missing_game_effect(self):
        self.assertEqual(self.effect(unusable=True),'independent-invalid-statistics')
    def test_other_identity_failures_take_precedence(self):
        self.assertEqual(self.effect(identity_error='earlier-career'),'independent-earlier-career')
    def test_gap_consistent_with_missing_game_is_not_proven_causation(self):
        self.assertEqual(self.effect(gp_gap=1),'coverage-consistent-gp-gap-not-exclusive-proof')
    def test_gap_exceeding_missing_fixtures_is_independent(self):
        self.assertEqual(self.effect(gp_gap=2),'independent-individual-gp-gap')
    def test_unaffected_team_gp_gap_is_independent(self):
        self.assertEqual(self.effect(team_hit=False,gp_gap=1),'independent-individual-gp-gap')
    def test_original_draft_team_does_not_explain_missing_observed_gp(self):
        self.assertEqual(self.effect(gp_gap=1,missing_capacity=0),'independent-individual-gp-gap')
        self.assertEqual(self.effect(gp_gap=0,missing_capacity=0),'confirmed-team-exclusion-only')
    def test_contradictory_verified_gp_is_not_waived(self):
        self.assertEqual(self.effect(gp_gap=-1),'independent-individual-gp-gap')
    def test_partial_year_additional_proof_rule_is_separate(self):
        self.assertEqual(self.effect(team_hit=False,career_verified=False),'partial-season-extra-proof-rule-only')
        self.assertEqual(self.effect(team_hit=False,career_verified=False,partial=False),'retained')
    def test_missing_career_gp_is_not_zero_proof(self):
        self.assertEqual(self.effect(career_verified=False,gp_gap=-10),'team-exclusion-otherwise-eligible-career-gp-unverified')
    def test_non_draft_debut_requires_independent_career_evidence(self):
        self.assertEqual(eligible_identity('1',2013,{},None),'unverified-career-debut')
        self.assertIsNone(eligible_identity('1',2013,{},dict(round=1,pick=1)))
    def test_earlier_career_overrides_current_draft(self):
        self.assertEqual(eligible_identity('1',2013,{'seasons':[{'year':2012,'gp':1}]},dict(round=1,pick=1)),'earlier-career')
    def test_draft_name_only_never_resolves_an_id(self):
        self.assertEqual(identity_drafts({}, {'picks':[]},[{'overall_pick':1,'player_name':'Example'}],2013),{})
    def test_group_boundaries_and_unknown_are_explicit(self):
        self.assertEqual(group({},dict(round=1,pick=14)),'lottery')
        self.assertEqual(group({},dict(round=1,pick=15)),'first-round')
        self.assertEqual(group({},dict(round=2,pick=31)),'second-round')
        self.assertEqual(group({},None),'undrafted-or-unknown')
if __name__=='__main__':unittest.main()
