"""Independent analytical checks for the isolated research model."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from returning_veteran import anchor_summary,fit,predict,participation_fit,participation,summary
from returning_veteran_data import expected_calendar,verified_scores
from evaluate_returning_veteran import player_means,ci,make_records,temporal_split
from ros_model import project


def games(pid='1',year=2020,n=25,minutes=30):
    return [{'id':pid,'name':'Synthetic analytical fixture','date':f'{year}-01-{i+1:02d}','gameId':str(i),'teamId':1,'position':'PG','starter':True,'teamShotShare':None,'minutes':minutes,'stats':{'FGM':5,'FGA':10,'3PM':2,'3PA':5,'FTM':3,'FTA':4,'PTS':15,'REB':6,'AST':4,'STL':1,'BLK':0,'TO':2}} for i in range(n)]


def parameters():
    h={2020:games()};a=anchor_summary(h,2022,{2020,2021})
    return fit([{'id':'1','year':2022,'anchor':a,'current':games(year=2022,minutes=24)}])


class ReturningTests(unittest.TestCase):
    def test_anchor_is_last_significant_actual_season(self):
        h={2018:games(year=2018),2020:games(year=2020),2021:[]}
        a=anchor_summary(h,2022,{2018,2019,2020,2021})
        self.assertEqual(a['year'],2020);self.assertEqual(a['gap'],1)
        self.assertEqual(a['years'],[2018,2020]);self.assertNotIn(2021,a['years'])

    def test_unknown_source_is_not_zero(self):
        self.assertIsNone(anchor_summary({2020:games()},2022,{2020}))

    def test_multiseason_absence(self):
        self.assertEqual(anchor_summary({2020:games()},2023,{2020,2021,2022})['gap'],2)

    def test_continuous_veteran_is_ineligible(self):
        self.assertIsNone(anchor_summary({2020:games(),2021:games(year=2021)},2022,{2020,2021}))

    def test_rookie_without_anchor_stays_unavailable(self):
        for n in (0,1,2):self.assertIsNone(predict({},games(year=2022,n=n),2022,{2021},parameters(),'2022-06-01'))

    def test_minute_posterior_is_games_based_and_bounded(self):
        p=parameters();p['minuteK']=8;p['minuteShift']=-6
        r=predict({2020:games()},games(year=2022,n=2,minutes=10),2022,{2020,2021},p,'2022-06-01')
        self.assertAlmostEqual(r['currentMinutesWeight'],.2)
        self.assertAlmostEqual(r['minutes'],21.2) # .8*(30-6)+.2*10
        self.assertIsNone(r['publishedROSgp']);self.assertIsNone(r['publishedTotals'])

    def test_minutes_and_rate_have_distinct_exposures(self):
        p=parameters();r=predict({2020:games()},[],2022,{2020,2021},p,'2022-06-01')
        # All true historical rates identical: shifting minutes cannot change rates.
        self.assertAlmostEqual(r['stats']['STL']/r['minutes'],1/30)
        self.assertAlmostEqual(r['stats']['FGM']/r['stats']['FGA'],.5)
        self.assertAlmostEqual(r['stats']['FTM']/r['stats']['FTA'],.75)
        self.assertAlmostEqual(r['stats']['PTS'],2*r['stats']['FGM']+r['stats']['3PM']+r['stats']['FTM'])

    def test_v1_policy_is_exact_on_common_samples(self):
        c=games(year=2022,n=5);old=project([],c)
        new=predict({2020:games()},c,2022,{2020,2021},parameters(),'2022-06-01','preserveAvailableV1')
        self.assertEqual(new['stats'],old['stats']);self.assertEqual(new['minutes'],old['minutes'])

    def test_mixed_ids_rejected(self):
        with self.assertRaisesRegex(ValueError,'identit'):predict({2020:games()},games(pid='2',year=2022,n=1),2022,{2020,2021},parameters(),'2022-06-01')

    def test_future_history_and_future_observation_rejected(self):
        with self.assertRaisesRegex(ValueError,'Future'):anchor_summary({2022:games(year=2022)},2022,{2022})
        with self.assertRaisesRegex(ValueError,'Future'):predict({2020:games()},games(year=2022,n=2),2022,{2020,2021},parameters(),'2022-01-01')

    def test_separate_participation_and_real_zero_outcome(self):
        p=participation_fit([{'id':'a','futureGP':0,'horizon':30},{'id':'b','futureGP':15,'horizon':30}])
        self.assertEqual(p['priorRate'],.25);self.assertEqual(p['anyAppearance'],.5)
        self.assertEqual(p['zeroFutureCases'],1)
        self.assertIsNone(participation(p,2,10,31));self.assertIsNone(participation(p,0,0,30));self.assertIsNone(participation(p,2,None,30))
        self.assertIsNone(participation(p,2,10,30)['publishableGP'])
        self.assertEqual(participation(p,2,10,0)['expectedGP'],0)

    def test_player_not_checkpoint_is_uncertainty_unit(self):
        r=[{'id':'a','brier':1}]*20+[{'id':'b','brier':0}]
        self.assertEqual(player_means(r,'brier'),{'a':1,'b':0})
        self.assertEqual(ci([1,2,4]),ci([1,2,4]))

    def test_actual_season_lengths(self):
        self.assertEqual(expected_calendar(2012),(990,30,66))
        self.assertEqual(expected_calendar(2021),(1080,30,72))
        self.assertEqual(expected_calendar(2020),(1059,30,None))
        self.assertEqual(expected_calendar(2004),(1189,29,82))

    def test_raw_probe_identity_validation(self):
        event={'teams':[1,2],'date':'2020-01-01'}
        d={'header':{'id':'12','season':{'year':2020,'type':2},'competitions':[{'date':'2020-01-02T00:30Z','status':{'type':{'completed':True}},'competitors':[{'id':'1','score':'100'},{'id':'2','score':'90'}]}]}}
        self.assertEqual(verified_scores(json.dumps(d),2020,'12',event),{1:100,2:90})
        with self.assertRaises(ValueError):verified_scores(json.dumps(d),2020,'13',event)
        with self.assertRaises(ValueError):verified_scores(json.dumps(d),2021,'12',event)

    def test_temporal_fit_ignores_future_targets(self):
        train=games(year=2022,minutes=24)
        anchor=anchor_summary({2020:games()},2022,{2020,2021})
        episodes=[{'id':'1','year':2022,'anchor':anchor,'current':train},{'id':'2','year':2025,'anchor':anchor,'current':games(pid='2',year=2025,minutes=40)}]
        rows=[{'year':y} for y in (2022,2023,2024,2025,2026)]
        tr,val,ev=temporal_split(episodes,rows,2025)
        p=fit(tr);episodes[1]['current']=games(pid='2',year=2025,minutes=1)
        self.assertEqual(fit(temporal_split(episodes,rows,2025)[0]),p)
        self.assertEqual([r['year'] for r in val],[2023,2024]);self.assertEqual([r['year'] for r in ev],[2025])

    def test_episode_and_checkpoint_balancing(self):
        rows=[{'id':'a','year':2020,'brier':1}]*20+[{'id':'a','year':2021,'brier':0}]
        self.assertEqual(player_means(rows,'brier'),{'a':.5})

    def test_conditional_scenario_retains_identity_and_date_guards(self):
        from returning_veteran import observed_anchor,conditional_performance
        a=observed_anchor({2020:games()},2022)
        with self.assertRaisesRegex(ValueError,'Future'):conditional_performance(a,games(year=2022,n=2),parameters(),'2022-01-01')
        with self.assertRaisesRegex(ValueError,'identit'):conditional_performance(a,games(pid='2',year=2022,n=2),parameters(),'2022-06-01')

    def test_tiny_history_is_not_a_significant_anchor(self):
        self.assertIsNone(anchor_summary({2020:games(n=19)},2022,{2020,2021}))
        self.assertIsNone(anchor_summary({2020:games(minutes=10)},2022,{2020,2021}))

    def test_production_never_imports_research(self):
        for name in ('generate_projections.py','ros_model.py','rookie_model.py'):
            self.assertNotIn('import returning_veteran',(Path(__file__).resolve().parents[2]/'scripts'/name).read_text())

if __name__=='__main__':unittest.main()
