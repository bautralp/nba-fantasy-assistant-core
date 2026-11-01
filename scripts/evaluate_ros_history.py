"""Reproducible returning-veteran temporal experiment. Does not publish ROS."""
import argparse
from collections import defaultdict
from itertools import product
import json
from pathlib import Path
from statistics import mean
from ros_history_research import load_season, project_history, attendance_history
from ros_model import summary, expected_gp, project

METRICS=('MIN','PTS','3PM','REB','AST','STL','BLK','TO','FGM','FGA','FTM','FTA','FG%','FT%')

def values(minutes,stats):
    return {'MIN':minutes,**stats,'FG%':100*stats['FGM']/stats['FGA'] if stats['FGA'] else None,'FT%':100*stats['FTM']/stats['FTA'] if stats['FTA'] else None}

def evaluate(data,years,decay,retention):
    errors={name:{k:[] for k in METRICS} for name in ['candidate','lastObservedSeason','legacyV1Common','candidateCommon']}
    availability={name:[] for name in ['legacyGP','historyGP']}; totals={name:defaultdict(list) for name in ['candidate','lastObservedSeason']}
    ids=set();counts=defaultdict(int);examples=[];targets=defaultdict(list)
    schedules={y:d[1] for y,d in data.items()}
    for year in years:
        if year not in data or year-1 not in data:continue
        byyear={y:defaultdict(list) for y in range(year-3,year+1) if y in data}
        for y,groups in byyear.items():
            for g in data[y][0]:groups[g['id']].append(g)
        candidates={pid for y,groups in byyear.items() if y<year-1 for pid in groups if not byyear[year-1].get(pid)}
        for pid in sorted(candidates):
            history={y:groups.get(pid,[]) for y,groups in byyear.items() if y<year}
            current=byyear[year].get(pid,[])
            last=max((y for y,gs in history.items() if gs),default=None)
            if last is None:continue
            base=summary(history[last]);baseStats={k:v/len(history[last]) for k,v in base['totals'].items() if k in ('PTS','FGM','FGA','FTM','FTA','3PM','REB','AST','STL','BLK','TO')}
            baseStats['PTS']=2*baseStats['FGM']+baseStats['3PM']+baseStats['FTM']
            reference=values(base['mpg'],baseStats)
            for n in [0,1,2,3,5,10]:
                if not n:counts['zeroCheckpointWithoutVerifiedRoster']+=1;continue
                if len(current)<n:counts['notReachedCheckpoint']+=1;continue
                observed=current[:n];cut=observed[-1]['date'];team=observed[-1]['teamId']
                calendar=sorted(g['date'] for g in data[year][1].values() if g['excluded'] is None and team in g['teams'] and g['date']>cut)[:30]
                if len(calendar)<30:counts['insufficientFutureTeamSchedule']+=1;continue
                future=[g for g in current[n:] if g['date']<=calendar[-1]]
                pred=project_history(history,observed,year,decay,retention,cut)
                if pred is None:counts['insufficientHistorySample']+=1;continue
                legacy_performance=project([],observed)
                ids.add(pid);counts['playerCheckpoints']+=1
                if not future:counts['zeroFutureAppearances']+=1
                elapsed=sum(g['excluded'] is None and team in g['teams'] and g['date']<=cut for g in data[year][1].values())
                legacyGP=expected_gp([],observed,30,elapsed)
                prior=attendance_history(history,schedules,year,decay)
                gp=30*(n+20*prior)/(max(n,elapsed)+20) if prior is not None else None
                availability['legacyGP'].append(abs(legacyGP-len(future)))
                if gp is not None:availability['historyGP'].append(abs(gp-len(future)))
                truthTotals={k:sum(g['stats'][k] for g in future) for k in ('PTS','3PM','REB','AST','STL','BLK','TO','FGM','FGA','FTM','FTA')}
                for name,stats,expected in [('candidate',pred['stats'],gp),('lastObservedSeason',baseStats,legacyGP)]:
                    if expected is not None:
                        for k,v in truthTotals.items():totals[name][k].append(abs(stats[k]*expected-v))
                if future:
                    target=summary(future);truth=values(target['mpg'],{k:v/len(future) for k,v in target['totals'].items() if k in baseStats});truth['PTS']=mean(g['stats']['PTS'] for g in future)
                    for k in METRICS:
                        if truth[k] is not None: targets[k].append(truth[k])
                    for name,v in [('candidate',values(pred['minutes'],pred['stats'])),('lastObservedSeason',reference)]:
                        for k in METRICS:
                            if truth[k] is not None and v[k] is not None:errors[name][k].append(abs(v[k]-truth[k]))
                    if legacy_performance['status']=='available':
                        for name,v in [('legacyV1Common',values(legacy_performance['minutes'],legacy_performance['stats'])),('candidateCommon',values(pred['minutes'],pred['stats']))]:
                            for k in METRICS:
                                if truth[k] is not None and v[k] is not None: errors[name][k].append(abs(v[k]-truth[k]))
                        counts['legacyCommonCheckpoints']+=1
                examples.append({'id':pid,'year':year,'checkpoint':n,'asOf':cut,'lastFeatureDate':max(g['date'] for gs in [*history.values(),observed] for g in gs),'futureGP':len(future),'predictedGP':gp,'legacyGP':legacyGP,'tradedFuture':any(g['teamId']!=team for g in future)})
    return {'targetMAD':{k:mean(abs(x-mean(v)) for x in v) if v else None for k,v in targets.items()},'distinctPlayers':len(ids),'ids':sorted(ids),'counts':dict(counts),'mae':{name:{k:mean(v) if v else None for k,v in rows.items()} for name,rows in errors.items()},'gpMAE':{k:mean(v) if v else None for k,v in availability.items()},'totalsMAE':{name:{k:mean(v) for k,v in rows.items()} for name,rows in totals.items()},'examples':examples}

def run(directory):
    protocol=json.loads(Path('docs/season/ros-model-audit/protocol.json').read_text());data={};rejected=[]
    for y in range(2019,2027):
        try:data[y]=load_season(directory,y)
        except (ValueError,KeyError,FileNotFoundError) as e:rejected.append({'year':y,'reason':str(e)})
    train=evaluate(data,protocol['trainingEndingYears'],1,1)
    scales={k:train.get('targetMAD',{}).get(k) or 1 for k in METRICS}
    # Frozen training-only target mean absolute deviation scales; all selection is 2024 only.
    choices=[]
    for decay,retention in product(protocol['candidates']['seasonDecay'],protocol['candidates']['gapMinutesRetention']):
        r=evaluate(data,protocol['selectionEndingYears'],decay,retention)
        score=mean(v/scales[k] for k,v in r['mae']['candidate'].items() if v is not None) if r['counts'].get('playerCheckpoints') else None
        choices.append({'decay':decay,'gapRetention':retention,'score':score})
    valid=[r for r in choices if r['score'] is not None]
    if not valid:raise ValueError('No development samples; cannot select model')
    best=min(valid,key=lambda r:r['score']);evaluation=evaluate(data,protocol['temporalEvaluationEndingYears'],best['decay'],best['gapRetention'])
    ratios={k:evaluation['mae']['candidate'][k]/v-1 for k,v in evaluation['mae']['lastObservedSeason'].items() if v is not None and v>0 and evaluation['mae']['candidate'][k] is not None}
    common_ratios={k:evaluation['mae']['candidateCommon'][k]/v-1 for k,v in evaluation['mae']['legacyV1Common'].items() if v is not None and v>0 and evaluation['mae']['candidateCommon'][k] is not None}
    failed=['untouched-holdout-unavailable','historical-age-injury-roster-evidence-unavailable']
    if evaluation['distinctPlayers']<protocol['acceptance']['minimumDistinctReturningPlayersInEvaluation']:failed.append('insufficient-distinct-returning-players')
    if any(v>0.15 for v in common_ratios.values()): failed.append('regression-on-production-common-cohort')
    if mean(ratios.values())>0.02:failed.append('composite-regression')
    if any(v>0.15 for v in ratios.values()):failed.append('individual-metric-regression')
    if evaluation['gpMAE']['historyGP'] is None or evaluation['gpMAE']['historyGP']>evaluation['gpMAE']['legacyGP']*1.02:failed.append('GP-regression-or-missing')
    return {'protocol':protocol,'sourceManifest':[v[2] for v in data.values()],'rejectedSources':rejected,'trainingScales':scales,'trainingSample':{'distinctPlayers':train['distinctPlayers'],'counts':train['counts']},'selection':choices,'selected':best,'development':evaluate(data,protocol['selectionEndingYears'],best['decay'],best['gapRetention']),'evaluation':evaluation,'relativeMAEChanges':ratios,'productionCommonRelativeMAEChanges':common_ratios,'productionEnabled':False,'failedCriteria':failed,'limitations':['Checkpoint zero cannot be evaluated without verified historical roster assignment.','No historical injury or birth-date snapshot coverage for independent age/injury calibration.','2025/26 are temporally later but already seen in previous project diagnostics, not pristine untouched holdouts.','No external projections; no current target-player-specific parameters; missing sources are never zero seasons.']}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);args=p.parse_args()
    result=run(args.input_dir);Path(args.output).write_text(json.dumps(result,indent=2,allow_nan=False)+'\n');print({k:result[k] for k in ['selected','failedCriteria','relativeMAEChanges']});print('Evaluation GP MAE',result['evaluation']['gpMAE'],'distinct',result['evaluation']['distinctPlayers'])
