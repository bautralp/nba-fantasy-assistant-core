"""Nested rolling-origin returning veteran evaluation; research outputs only."""
import argparse
from collections import defaultdict,Counter
import gzip
import hashlib
import json
from pathlib import Path
import random
from statistics import mean
from returning_veteran import (anchor_summary,fit,predict,participation_fit,participation,values,observed_values,METRICS)
from ros_model import project,expected_gp,summary,projection_games
from datetime import date
from regular_season import schedule_index


def unpack(corpus):
    groups={};schedules={};certified={r['year'] for r in corpus['manifest'] if r.get('absenceCertified')};unknown={}
    for y,s in corpus['seasons'].items():
        y=int(y);groups[y]=defaultdict(list);schedules[y]=s['schedule'];unknown[y]=set(s['unknownPlayers'])
        for g in s['games']:groups[y][g['id']].append(g)
    return groups,schedules,certified,unknown


def make_records(corpus):
    groups,schedules,certified,unknown=unpack(corpus);episodes=[];rows=[];counts=Counter()
    for e in corpus['episodes']:
        year=e['year'];pid=e['id'];history={y:g.get(pid,[]) for y,g in groups.items() if y<year and y in certified and pid not in unknown[y]};safe=certified-{y for y in unknown if pid in unknown[y]}
        anchor=anchor_summary(history,year,safe)
        if anchor is None:raise ValueError('Corpus episode lacks certified anchor')
        current=groups[year][pid];episodes.append({'id':pid,'year':year,'anchor':anchor,'current':current})
        for n in (0,1,2,3,5,10,20):
            if not n:counts['zeroCheckpointUnscorableWithoutDatedRoster']+=1;continue
            if len(current)<n:counts['checkpointNotReached']+=1;continue
            observed=current[:n];cut=observed[-1]['date'];team=observed[-1]['teamId']
            calendar=sorted(v['date'] for v in schedules[year].values() if team in v['teams'] and v['date']>cut)[:30]
            if not calendar:counts['noFutureScheduledGames']+=1;continue
            future=[g for g in current[n:] if g['date']<=calendar[-1]]
            elapsed=sum(team in v['teams'] and v['date']<=cut for v in schedules[year].values())
            rows.append({'id':pid,'year':year,'history':history,'certified':safe,'anchor':anchor,'current':observed,'asOf':cut,'horizon':len(calendar),'elapsed':elapsed,'futureGP':len(future),'future':future,'checkpoint':n,'anchorSeasonOpportunities':sum(history[anchor['year']][-1]['teamId'] in v['teams'] for v in schedules[anchor['year']].values()),'truth':observed_values(future),'tradedFuture':any(g['teamId']!=team for g in future)})
    controls=[groups[e['year']][e['id']] for e in corpus['controls']]
    return episodes,rows,counts,groups,controls


def score(rows,params,policy,availability,scales=None):
    records=[]
    for r in rows:
        p=predict(r['history'],r['current'],r['year'],r['certified'],params,r['asOf'],policy)
        if p is None:continue
        v1=project([],r['current']);anchor=r['anchor']['summary'];ref=values(anchor['mpg'],{**{k:v/anchor['gp'] for k,v in anchor['totals'].items()},'PTS':(2*anchor['totals']['FGM']+anchor['totals']['3PM']+anchor['totals']['FTM'])/anchor['gp']})
        predictions={'new':values(p['minutes'],p['stats']),'anchor':ref}
        if v1['status']=='available':predictions['v1Common']=values(v1['minutes'],v1['stats']);predictions['newCommon']=predictions['new']
        gp=participation(availability,len(r['current']),r['elapsed'],r['horizon']);oldgp=expected_gp([],r['current'],r['horizon'],r['elapsed'])
        rec={k:r[k] for k in ('id','year','checkpoint','asOf','horizon','futureGP','tradedFuture')};rec.update(gap=r['anchor']['gap'],position=r['anchor']['position'],anchorYear=r['anchor']['year'],errors={},totalErrors={},gpErrors={},brier=None,rateErrors={})
        truth=r['truth']
        if truth:
            for name,v in predictions.items():
                rec['errors'][name]={k:abs(v[k]-truth[k]) for k in METRICS if v.get(k) is not None and truth.get(k) is not None}
                rec['rateErrors'][name]={k:abs(v[k]/v['MIN']-truth[k]/truth['MIN']) for k in ('PTS','3PM','REB','AST','STL','BLK','TO','FGA','FTA') if v['MIN'] and truth['MIN']}
        if gp:
            rec['gpErrors']={'new':abs(gp['expectedGP']-r['futureGP']),'v1':abs(oldgp-r['futureGP']),'anchor':abs(r['horizon']*r['anchor']['summary']['gp']/r['anchorSeasonOpportunities']-r['futureGP'])}
            rec['brier']=(gp['probabilityAnyAppearance']-(r['futureGP']>0))**2
            for name in predictions:
                expected=gp['expectedGP'] if name in ('new','newCommon') else oldgp if name=='v1Common' else r['horizon']*r['anchor']['summary']['gp']/r['anchorSeasonOpportunities']
                rec['totalErrors'][name]={k:abs(predictions[name][k]*expected-sum(g['stats'][k] for g in r['future'])) for k in ('PTS','3PM','REB','AST','STL','BLK','TO','FGM','FGA','FTM','FTA')}
        records.append(rec)
    return records


def player_means(records,field,model=None,metric=None):
    by=defaultdict(lambda:defaultdict(list))
    for r in records:
        v=r.get(field)
        if model is not None:v=v.get(model) if v else None
        if metric is not None:v=v.get(metric) if v else None
        if v is not None:by[r['id']][r.get('year',0)].append(v)
    return {pid:mean(mean(v) for v in episodes.values()) for pid,episodes in by.items()}


def ci(vals):
    if not vals:return None
    rng=random.Random(173102);v=list(vals);samples=sorted(mean(rng.choices(v,k=len(v))) for _ in range(500))
    return [samples[12],samples[487]]


def aggregate(records,intervals=True):
    result={'distinctPlayers':len({r['id'] for r in records}),'episodes':len({(r['id'],r['year']) for r in records}),'checkpoints':len(records),'conditionalCheckpoints':sum(bool(r['errors']) for r in records),'zeroFutureCases':sum(r['futureGP']==0 for r in records),'mae':{},'perMinuteMAE':{},'totalsMAE':{},'gpMAE':{},'perPlayer':{}}
    for field,out,metrics in [('errors','mae',METRICS),('rateErrors','perMinuteMAE',('PTS','3PM','REB','AST','STL','BLK','TO','FGA','FTA')),('totalErrors','totalsMAE',('PTS','3PM','REB','AST','STL','BLK','TO','FGM','FGA','FTM','FTA'))]:
        names=sorted({name for r in records for name in r[field]})
        for name in names:
            result[out][name]={}
            for k in metrics:
                by=player_means(records,field,name,k)
                result[out][name][k]={'mae':mean(by.values()) if by else None,'players':len(by)}
                if intervals:result[out][name][k]['playerBootstrap95']=ci(by.values())
                if field=='errors':
                    for pid,v in by.items():result['perPlayer'].setdefault(pid,{}).setdefault(name,{})[k]=v
    for name in ('new','v1','anchor'):
        by=player_means(records,'gpErrors',name);result['gpMAE'][name]={'mae':mean(by.values()) if by else None,'players':len(by),'playerBootstrap95':ci(by.values()) if intervals else None}
    by=player_means(records,'brier');result['anyAppearanceBrier']=mean(by.values()) if by else None
    result['pairedPlayerMAEDifference95']={}
    for new,reference in [('new','anchor'),('newCommon','v1Common')]:
        for k in METRICS:
            a=player_means(records,'errors',new,k);b=player_means(records,'errors',reference,k)
            differences=[a[pid]-b[pid] for pid in sorted(a.keys()&b.keys())]
            result['pairedPlayerMAEDifference95'].setdefault(new+'Minus'+reference,{})[k]={'meanDifference':mean(differences) if differences else None,'playerBootstrap95':ci(differences) if intervals else None,'players':len(differences)}
    return result


def composite(result,name,scales):
    vals=[v['mae']/scales[k] for k,v in result['mae'].get(name,{}).items() if v['mae'] is not None]
    return mean(vals) if vals else None


def choose(validation,params,availability,scales):
    choices=[]
    for policy in ('anchorEB','preserveAvailableV1'):
        r=aggregate(score(validation,params,policy,availability),False);c=composite(r,'newCommon',scales);v=composite(r,'v1Common',scales)
        choices.append({'policy':policy,'score':composite(r,'new',scales),'commonRelativeChange':c/v-1 if v else None,'eligible':v is not None and c<=v*1.02})
    eligible=[x for x in choices if x['score'] is not None and x['eligible']]
    return (min(eligible,key=lambda x:x['score'])['policy'] if eligible else None),choices


def temporal_split(episodes,rows,year):
    return ([e for e in episodes if e['year']<=year-3],
            [r for r in rows if r['year'] in (year-2,year-1)],
            [r for r in rows if r['year']==year])


def run(corpus):
    episodes,rows,excluded,groups,controls=make_records(corpus);folds=[];allrecords=[];scales_by_fold={}
    for year in range(2010,2028):
        train,validation,evaluation=temporal_split(episodes,rows,year)
        ctr=[gs for e,gs in zip(corpus['controls'],controls) if e['year']<=year-3]
        params=fit(train,ctr);availability=participation_fit([r for r in rows if r['year']<=year-3])
        if not params:folds.append({'year':year,'status':'no-training'});continue
        scales={}
        for k in METRICS:
            v=[observed_values(e['current'])[k] for e in train if observed_values(e['current'])[k] is not None]
            scales[k]=mean(abs(x-mean(v)) for x in v) if len(v)>1 else 1
            scales[k]=scales[k] or 1
        policy,choices=choose(validation,params,availability,scales)
        fold={'year':year,'trainingYears':sorted({e['year'] for e in train}),'validationYears':sorted({r['year'] for r in validation}),'trainingDistinctPlayers':len({e['id'] for e in train}),'selected':policy,'choices':choices,'parameters':params,'availability':availability,'scales':scales}
        if policy:
            records=score(evaluation,params,policy,availability,scales);allrecords+=records;fold['evaluation']=aggregate(records,False);fold['trainingEvaluationPlayerOverlap']=len({e['id'] for e in train}&{r['id'] for r in evaluation});fold['status']='evaluated' if evaluation else 'forecast-fit-only'
        else:fold['status']='no-eligible-validation-selection'
        folds.append(fold);scales_by_fold[year]=scales
    result=aggregate(allrecords)
    # Player-balanced normalized errors use each fold's training scales.
    normalized=[]
    for r in allrecords:
        n={**r,'errors':{name:{k:v/scales_by_fold[r['year']][k] for k,v in m.items()} for name,m in r['errors'].items()}}
        normalized.append(n)
    norm=aggregate(normalized,False);composites={name:mean(v['mae'] for v in metrics.values() if v['mae'] is not None) for name,metrics in norm['mae'].items()}
    failed=['no-pristine-independent-holdout','historical-roster-injury-age-evidence-unavailable']
    if result['distinctPlayers']<30:failed.append('fewer-than-30-distinct-evaluated-returners')
    if result['zeroFutureCases']<10:failed.append('insufficient-zero-future-probability-calibration')
    for new,ref in [('new','anchor'),('newCommon','v1Common')]:
        if ref not in composites or composites[new]>composites[ref]*1.02:failed.append(new+'-composite-regression-or-missing')
        if any(v['mae'] is not None and result['mae'][ref][k]['mae'] and v['mae']>result['mae'][ref][k]['mae']*1.15 for k,v in result['mae'].get(new,{}).items()):failed.append(new+'-single-metric-regression')
    if result['gpMAE']['new']['mae'] is None or result['gpMAE']['new']['mae']>result['gpMAE']['v1']['mae']*1.02:failed.append('GP-regression-or-missing')
    subgroups={}
    for label,fn in [('gap1',lambda r:r['gap']==1),('gap2plus',lambda r:r['gap']>=2),('horizon1to9',lambda r:r['horizon']<10),('horizon10to29',lambda r:10<=r['horizon']<30),('horizon30',lambda r:r['horizon']==30)]:subgroups[label]=aggregate([r for r in allrecords if fn(r)],False)
    supplemental=[];development_folds=[]
    for y in sorted({e['year'] for e in episodes}):
        training=[e for e in episodes if e['year']<y]
        p=fit(training,[gs for e,gs in zip(corpus['controls'],controls) if e['year']<y])
        a=participation_fit([r for r in rows if r['year']<y])
        if p:
            evaluated=score([r for r in rows if r['year']==y],p,'anchorEB',a)
            supplemental+=evaluated;development_folds.append({'year':y,'trainingYears':sorted({e['year'] for e in training}),'trainingDistinctPlayers':len({e['id'] for e in training}),'policy':'anchorEB-fixed-no-selection','parameters':p,'availability':a})
    return {'supplementalDevelopment':{'kind':'consecutive-year-development-only-not-acceptance','folds':development_folds,'evaluation':aggregate(supplemental),'subgroups':{label:aggregate([r for r in supplemental if fn(r)],False) for label,fn in [('gap1',lambda r:r['gap']==1),('gap2plus',lambda r:r['gap']>=2),('horizon1to9',lambda r:r['horizon']<10),('horizon10to29',lambda r:10<=r['horizon']<30),('horizon30',lambda r:r['horizon']==30)]},'records':supplemental},'version':'returning-anchor-eb-v2','productionEnabled':False,'sourceManifest':corpus['manifest'],'cohort':{'distinctReturningPlayers':len({e['id'] for e in episodes}),'episodes':len(episodes),'controlPlayers':len({e['id'] for e in corpus['controls']}),'excludedCheckpoints':dict(excluded),'players':sorted({e['id'] for e in episodes})},'folds':folds,'evaluation':result,'normalizedComposite':composites,'subgroups':subgroups,'failedCriteria':failed,'records':allrecords}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--corpus',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    raw=Path(a.corpus).read_bytes();r=run(json.loads(gzip.decompress(raw)));r['corpusSHA256']=hashlib.sha256(raw).hexdigest();r['protocolSHA256']=hashlib.sha256(Path('docs/season/ros-model-audit/returning-v2/protocol.json').read_bytes()).hexdigest();r['supplementalProtocolSHA256']=hashlib.sha256(Path('docs/season/ros-model-audit/returning-v2/supplemental-protocol.json').read_bytes()).hexdigest();Path(a.output).write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');print(r['cohort']);print(r['normalizedComposite']);print(r['failedCriteria'])
