"""Reproducible transfer-fix evidence; no publication or frozen research mutation."""
import argparse
from datetime import date
import json
from pathlib import Path
import subprocess
from migration_baselines import read_historical
from projection_replay_inputs import load_inputs
from generate_projections import build
from replay_reviewed_ros import reviewed_generator

BASELINE='542a01f0bc6f36d8c707d743e169c1fba7559bd0'
ROOT=Path(__file__).resolve().parents[1]


def at_baseline(path):
    return read_historical(BASELINE, path)


def report(input_dir):
    root=Path(input_dir)
    pinned=load_inputs()['files']
    std=json.loads(pinned['player-projections.json'])
    catalog=json.loads(pinned['fantasy-positions.json'])
    contents={f'{y-1}-{str(y)[2:]}':(root/f'player_box_{y}.parquet').read_bytes() for y in (2026,2027)}
    schedules={f'{y-1}-{str(y)[2:]}':(root/f'nba_schedule_{y}.parquet').read_bytes() for y in (2026,2027)}
    previous=reviewed_generator()
    args=(contents,schedules,date.fromisoformat(std['asOf']),std['generatedAt'],catalog)
    before=previous['build'](*args);after=build(*args)
    old={p['id']:p for p in before['players']}
    changes=[{'id':p['id'],'before':old[p['id']]['rosGP'],'after':p['rosGP']} for p in after['players'] if old[p['id']]['rosGP']!=p['rosGP']]
    performance_changes=[p['id'] for p in after['players'] if old[p['id']]['stats']!=p['stats']]
    assert not changes and not performance_changes, 'Pinned single-team fixture must retain reviewed generator values'
    old_report=json.loads(at_baseline('docs/season/final-projection-results.json'))
    new_report=json.loads((ROOT/'docs/season/final-projection-results.json').read_text())
    original={p['id']:p for p in old_report['players']}
    old_scenario=json.loads(at_baseline('public/data/projection-scenarios.json'));new_scenario=json.loads(pinned['projection-scenarios.json'])
    old_pool={p['id']:p for p in old_scenario['projection']['players']};pool=new_scenario['projection']['players']
    pool_changes={'players':len(pool),'gpChanged':sum(p['rosGP']!=old_pool[p['id']]['rosGP'] for p in pool),'conditionalStatsChanged':sum(p['stats']!=old_pool[p['id']]['stats'] for p in pool),'unknownGPBefore':sum(p['rosGP'] is None for p in old_pool.values()),'unknownGPAfter':sum(p['rosGP'] is None for p in pool),'detectedUndatedTransfers':sum(m['opportunityEvidence']['basis']=='missing-transfer-dates' for m in new_scenario['players'].values()),'newUnknownGPPlayers':[{'id':p['id'],'name':p['name'],'beforeGP':old_pool[p['id']]['rosGP'],'basis':new_scenario['players'][p['id']]['opportunityEvidence']['basis']} for p in pool if p['rosGP'] is None and old_pool[p['id']]['rosGP'] is not None]}
    cases=[{'id':p['id'],'name':p['name'],'beforeGP':original[p['id']]['expectedGames'],'afterGP':p['expectedGames'],'deltaGP':p['expectedGames']-original[p['id']]['expectedGames']} for p in new_report['players']]
    ranks=[]; category_changes={}
    for category,rs in new_report['rankings'].items():
        lookup={r['teamId']:r for r in old_report['rankings'][category]}
        category_changes[category]={'maximumAbsoluteValueChange':max(abs(r['projectedValue']-lookup[r['teamId']]['projectedValue']) for r in rs),'maximumAbsoluteZChange':max(abs(r['powerScore']-lookup[r['teamId']]['powerScore']) for r in rs)}
        for r in rs:
            if r['rank']!=lookup[r['teamId']]['rank']:ranks.append({'category':category,'teamId':r['teamId'],'before':lookup[r['teamId']]['rank'],'after':r['rank']})
    # Independent arithmetic oracle; these are synthetic calendars, not real trades.
    # Both use prior=.5, k=20, remaining=40, matching the isolated tests.
    examples=[]
    for name,n,true_opp,old_union,old_current in [('busy-new-team',8,8,20,16),('behind-new-team',4,10,5,2)]:
        corrected=40*(n+10)/(true_opp+20)
        a=40*(n+10)/(max(n,old_union)+20);b=40*(n+10)/(max(n,old_current)+20)
        examples.append({'kind':'synthetic-independent-oracle','case':name,'observedGP':n,'correctOpportunities':true_opp,'oldStandardOpportunities':max(n,old_union),'oldExtendedOpportunities':max(n,old_current),'correctedGP':corrected,'oldStandardGP':a,'oldExtendedGP':b,'standardRelativeErrorPercent':100*(a/corrected-1),'extendedRelativeErrorPercent':100*(b/corrected-1)})
    return {'baselineCommit':BASELINE,'asOf':std['asOf'],'sourceDataThrough':new_report['sourceDataThrough'],
            'reviewedGeneratorReplay':{'players':len(after['players']),'gpChanges':changes,'performanceChanges':performance_changes,'qualification':'Compares reviewed generator code on identical pinned input, not older main-published policy differences.'},
            'independentExamples':examples,'leagueBefore':old_report['extendedCoverage'],'leagueAfter':new_report['extendedCoverage'],
            'standardCoverage':new_report['standardCoverage'],'realPlayerGPComparison':cases,'extendedPoolComparison':pool_changes,'changedCategoryRanks':ranks,'categoryChanges':category_changes,
            'remainingLimitations':['No automatic dated transaction ledger; detected undated transfers leave GP unknown.', 'Unchanged single-team affiliation remains an explicit continuity proxy.', 'Historical multi-team rookie episodes excluded only from new product GP prior; frozen 14.2 unchanged.']}


if __name__=='__main__':
    from migration_baselines import private_root
    private_root()
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    r=report(a.input_dir);Path(a.output).write_text(json.dumps(r,indent=2)+'\n')
    print('Reviewed single-team generator replay:',r['reviewedGeneratorReplay'])
    print('Real league:',r['leagueAfter'],'rank changes:',len(r['changedCategoryRanks']))
