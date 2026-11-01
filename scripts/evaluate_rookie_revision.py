"""Offline preregistered chronological evaluation; never used by daily refresh.

Conditional statistics require one appearance, not survival for 20 games.
Availability includes every verified drafted player at checkpoint zero and zeros
after every reached checkpoint. Source reconciliation is required before fitting.
"""
import argparse
from collections import defaultdict, Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from statistics import mean

from calibrate_rookies import target, sample_prior, METRICS, CHECKPOINTS
from rookie_model import RATE_KEYS, KINDS, draft_group, prior_for, infer
from refresh_stats import atomic_write
from ros_model import expected_gp, summary

MODES = ('earlyNBA', 'fixedPrior', 'draftPrior', 'ncaa', 'role')
TOTALS = ('MIN', 'PTS', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FGA', 'FGM', 'FTA', 'FTM')


def validate_corpus(raw):
    seen=set()
    for ending,rows in raw['cohorts'].items():
        year=int(ending);schedule=raw['schedules'][ending]
        for row in rows:
            pid=row['id'];key=(year,pid)
            if key in seen:raise ValueError('Duplicate historical player/season')
            seen.add(key)
            games=row['games'];keys=[(g['date'],g['gameId']) for g in games]
            if keys!=sorted(keys) or len({g['gameId'] for g in games})!=len(games):raise ValueError('Historical checkpoint ordering/duplicates')
            for g in games:
                event=schedule.get(g['gameId'])
                if g['id']!=pid or not f'{year-1}-07-01'<=g['date']<=f'{year}-12-31':raise ValueError('Historical player/season mismatch')
                if not event or event['date']!=g['date'] or event['excluded'] is not None or g['teamId'] not in event['teams']:raise ValueError('Historical schedule mismatch')
            profile=row['profile'];ncaa=profile.get('ncaa')
            if str(profile['id'])!=pid:raise ValueError('Historical profile ID mismatch')
            if ncaa and (ncaa['through']>=f'{year-1}-07-01' or str(ncaa['id'])!=str((profile.get('collegeAthlete') or {}).get('id'))):raise ValueError('NCAA future leakage or crosswalk mismatch')


def team_fixtures(schedule, team):
    return sorted((dict(v, gameId=k) for k,v in schedule.items()
                   if v['excluded'] is None and team in v['teams']), key=lambda g:(g['date'],g['gameId']))


def observation(row, n, schedule):
    games=row['games']
    if len(games)<n: return None
    observed=games[:n]
    team=observed[-1]['teamId'] if observed else (row.get('draft') or {}).get('teamId') or row.get('entryTeamId')
    if team is None: return None  # Unknown roster at zero is reported, never guessed.
    fixtures=team_fixtures(schedule,team)
    cutoff=(observed[-1]['date'], observed[-1]['gameId']) if observed else ('0000-00-00','')
    future_fixtures=[g for g in fixtures if (g['date'],g['gameId'])>cutoff]
    if not future_fixtures:return None
    # Later trade destinations are never input features. Outcome includes all
    # actual appearances after cutoff; denominator remains checkpoint team schedule.
    future=[g for g in games[n:] if (g['date'],g['gameId'])>cutoff]
    end=future_fixtures[min(30,len(future_fixtures))-1]
    conditional=[g for g in future if (g['date'],g['gameId'])<=(end['date'],end['gameId'])]
    return {'observed':observed, 'conditional':conditional, 'future':future,
            'remaining':len(future_fixtures), 'elapsed':len(fixtures)-len(future_fixtures),
            'tradeOutcome':any(g['teamId']!=team for g in future)}


def fit(cohort, minimum_group, minimum_ncaa):
    groups=defaultdict(list)
    for row in cohort:
        if not row['games']:continue
        p=sample_prior(row['games'][:30]); observed=summary(row['games'][:30])
        p['_minutes']=observed['minutes'];p['_totals']=observed['totals'];group=draft_group(row['profile'])
        groups['all'].append(p); groups[group].append(p)
        # NBA position from future games is forbidden. Only pre-NBA college position.
        pos=row['profile'].get('priorPosition') or 'unknown'
        if pos!='unknown':groups[group+':'+pos].append(p)
    if not groups['all']:raise ValueError('No reconciled training appearances')
    priors={k:{'minutes':mean(p['minutes'] for p in ps),
               'rates':{r:sum(p['_totals'][r] for p in ps)/sum(p['_minutes'] for p in ps) for r in RATE_KEYS},
               'percentages':{r:sum(p['_totals'][made] for p in ps)/sum(p['_totals'][attempted] for p in ps) if sum(p['_totals'][attempted] for p in ps) else 0
                              for r,made,attempted in [('2P','2PM','2PA'),('3P','3PM','3PA'),('FT','FTM','FTA')]},
               'players':len(ps)} for k,ps in groups.items() if k=='all' or len(ps)>=minimum_group}
    paired=[r for r in cohort if r['games'] and r['profile'].get('ncaa')]
    fits={}
    if len(paired)>=minimum_ncaa:
        for key in RATE_KEYS:
            x=[r['profile']['ncaa']['rates'][key] for r in paired]
            y=[sample_prior(r['games'][:30])['rates'][key] for r in paired]
            mx,my=mean(x),mean(y);variance=sum((v-mx)**2 for v in x)
            slope=max(0,sum((a-mx)*(b-my) for a,b in zip(x,y))/variance) if variance else 0
            fits[key]={'slope':slope,'intercept':my-slope*mx,'players':len(paired)}
    return priors,fits,len(paired)


def predict(row, n, params, mode):
    observed=row['games'][:n]
    if mode=='earlyNBA':return target(observed) if observed else None
    if mode=='ncaa' and (not params['ncaaEnabled'] or not row['profile'].get('ncaa')):return None
    p={**params,'ncaaEnabled':mode in ('ncaa','role') and params['ncaaEnabled']}
    if mode=='fixedPrior':prior={**params['priors']['all'],'basis':'Rookie prior'}
    else:prior=prior_for(row['profile'],p)
    if prior is None:return None
    result=infer(prior,[] if mode=='fixedPrior' else observed,p,use_role=mode=='role');s=result['stats']
    return {'MIN':result['minutes'],**s,
            'FG%':s['FGM']/s['FGA'] if s['FGA'] else None,
            'FT%':s['FTM']/s['FTA'] if s['FTA'] else None}


def conditional_evaluate(cohort, schedules, params):
    reports=[]
    for n in CHECKPOINTS:
        errors={m:{k:[] for k in METRICS} for m in MODES};paired_ncaa={m:{k:[] for k in METRICS} for m in MODES};ids=[];zero=0;missing=0;ncaa_ids=[]
        for row in cohort:
            view=observation(row,n,schedules[str(row['year'])])
            if view is None:missing+=1;continue
            if not view['conditional']:zero+=1;continue
            truth=target(view['conditional']);preds={m:predict(row,n,params,m) for m in MODES}
            # Paired early/current baseline and general prior use identical players.
            if preds['role'] is None:missing+=1;continue
            ids.append(row['id'])
            if preds['ncaa'] is not None:ncaa_ids.append(row['id'])
            for mode,pred in preds.items():
                if pred is None:continue
                for key in METRICS:
                    if n and preds['earlyNBA'][key] is None:continue
                    if truth[key] is not None and pred[key] is not None:
                        error=abs(pred[key]-truth[key]);errors[mode][key].append(error)
                        if preds['ncaa'] is not None:paired_ncaa[mode][key].append(error)
        reports.append({'nbaGames':n,'players':len(ids),'ids':ids,'noFutureAppearance':zero,
                        'unscored':missing,'ncaaAssistedPlayers':len(ncaa_ids),
                        'mae':{m:{k:mean(v) if v else None for k,v in es.items()} for m,es in errors.items()},
                        'ncaaPairedMAE':{m:{k:mean(v) if v else None for k,v in es.items()} for m,es in paired_ncaa.items()},
                        'metricCounts':{m:{k:len(v) for k,v in es.items()} for m,es in errors.items()}})
    return reports


def training_scales(cohort,schedules):
    values=defaultdict(list)
    for row in cohort:
        view=observation(row,0,schedules[str(row['year'])])
        if view and view['conditional']:
            for k,v in target(view['conditional']).items():
                if k in METRICS and v is not None:values[k].append(v)
    scales={k:mean(abs(v-mean(vs)) for v in vs) for k,vs in values.items()}
    if any(not scales.get(k) for k in METRICS):raise ValueError('Insufficient training metric scale')
    return scales


def score(reports,scales,mode,checkpoints=(1,3,5,10,20),keys=METRICS):
    xs=[r['mae'][mode][k]/scales[k] for r in reports if r['nbaGames'] in checkpoints
        for k in keys if r['mae'][mode][k] is not None]
    return mean(xs) if xs else None


def tune(cohort,schedules,params,scales):
    # Only validation cohort is passed. Neither holdout outcomes nor its counts
    # are inspected by parameter selection. Equal checkpoint/category weighting.
    fields=[('minutesK',['MIN'],[1,3,5,10,20,40]),
            *[('rateK.'+k,[k] if k in METRICS else ['FGA'] if k in ('2PA','3PA') else ['FTA'],[50,100,300,600,1200,2400]) for k in RATE_KEYS],
            ('shootingK.2P',['FG%'],[20,50,100,200,400]),
            ('shootingK.3P',['FG%'],[20,50,100,200,400]),
            ('shootingK.FT',['FT%'],[20,50,100,200,400]),
            ('roleWeight',['MIN'],[0,.25,.5])]
    def setvalue(p,field,v):
        if '.' in field:a,b=field.split('.');p[a][b]=v
        else:p[field]=v
    choices=[]
    for field,keys,candidates in fields:
        scores=[]
        for v in candidates:
            candidate=deepcopy(params);setvalue(candidate,field,v)
            value=score(conditional_evaluate(cohort,schedules,candidate),scales,'role' if field=='roleWeight' else 'draftPrior',keys=keys)
            if value is not None:scores.append((value,v))
        if not scores:raise ValueError('No validation observations for '+field)
        selected=min(scores)[1];setvalue(params,field,selected);choices.append({'field':field,'selected':selected,'validationScores':scores})
    # NCAA rates are either validation selected or entirely disabled.
    if params['ncaaFits']:
        params['ncaaEnabled']=True
        assisted=score(conditional_evaluate(cohort,schedules,params),scales,'role')
        params['ncaaEnabled']=False
        plain=score(conditional_evaluate(cohort,schedules,params),scales,'role')
        params['ncaaEnabled']=assisted is not None and plain is not None and assisted<plain
    return params,choices


def fit_availability(cohort,schedules,minimum):
    groups=defaultdict(list)
    for row in cohort:
        for n in CHECKPOINTS:
            view=observation(row,n,schedules[str(row['year'])])
            if view is None:continue
            value={'rate':min(1,len(view['future'])/view['remaining']), 'any':int(bool(view['future']))}
            groups[str(n)+':all'].append(value);groups[str(n)+':'+draft_group(row['profile'])].append(value)
    return {k:{'rate':mean(x['rate'] for x in xs),'any':mean(x['any'] for x in xs),'players':len(xs)}
            for k,xs in groups.items() if k.endswith(':all') or len(xs)>=minimum}


def availability_evaluate(cohort,schedules,params,cells,k):
    reports=[]
    for n in CHECKPOINTS:
        errors={mode:{'GP':[],'Brier':[],**{key:[] for key in TOTALS}} for mode in ('baseline','rookie')}
        zero=never=trades=unscored=0;ids=[]
        for row in cohort:
            view=observation(row,n,schedules[str(row['year'])])
            if view is None:unscored+=1;continue
            prior=cells.get(str(n)+':'+draft_group(row['profile']),cells.get(str(n)+':all'))
            if not prior:unscored+=1;continue
            observed=view['observed'];remaining=view['remaining'];elapsed=view['elapsed']
            attendance=min(1,n/elapsed) if elapsed else 0
            # Existing fallback with no NBA history: one half when no attendance
            # signal exists, otherwise current attendance. Probability benchmark
            # explicitly assumes independent attendance, not an injury model.
            base_rate=expected_gp([],observed,remaining,elapsed)/remaining
            w=elapsed/(elapsed+k) if n else 0
            rate=(1-w)*prior['rate']+w*attendance
            gp={'baseline':remaining*base_rate,'rookie':remaining*rate}
            prob={'baseline':1-(1-base_rate)**remaining,'rookie':prior['any']}
            actual=len(view['future']);ids.append(row['id']);zero+=int(actual==0);never+=int(not row['games']);trades+=int(view['tradeOutcome'])
            truth={'MIN':sum(g['minutes'] for g in view['future']),**{key:sum(g['stats'][key] for g in view['future']) for key in TOTALS if key!='MIN'}}
            # Same per-game component isolates availability differences; zero-GP
            # drafted players remain in GP/Brier even if no numeric prior exists.
            pred=predict(row,n,params,'role')
            for mode in errors:
                errors[mode]['GP'].append(abs(gp[mode]-actual));errors[mode]['Brier'].append((prob[mode]-int(actual>0))**2)
                if pred:
                    for key in TOTALS:errors[mode][key].append(abs(gp[mode]*pred[key]-truth[key]))
        reports.append({'nbaGames':n,'players':len(ids),'ids':ids,'zeroFutureAppearances':zero,'neverNBA':never,
                        'tradedOutcomes':trades,'unscored':unscored,
                        'mae':{m:{key:mean(xs) if xs else None for key,xs in es.items()} for m,es in errors.items()}})
    return reports


def relative(candidate,baseline):
    return (candidate-baseline)/baseline if candidate is not None and baseline else None


def gates(criteria,train,counts,tests,availability,scales,summary):
    sample=criteria['sample'];accuracy=criteria['accuracy'];reasons=[]
    if len({r['id'] for r in train if r['games']})<sample['minimumTrainingRookies']:reasons.append('training-player-count')
    if len({r['year'] for r in train if r['games']})<sample['minimumTrainingSeasons']:reasons.append('training-season-count')
    for n,minimum in [('14',14),('30',30)]:
        if summary.get('draftCoverage',{}).get(n,{}).get('verified',0)<minimum:reasons.append('current-draft-identity-'+n)
    split=criteria['split'];required=set(split['trainingEndingYears']+split['validationEndingYears']+split['untouchedHoldoutEndingYears'])
    if any(f['year'] in required for f in summary.get('sourceFailures',[])):reasons.append('historical-source-reconciliation')
    pooled=[r for reports in tests.values() for r in reports]
    early=relative(score(pooled,scales,'role',accuracy['earlyCheckpoints']),score(pooled,scales,'earlyNBA',accuracy['earlyCheckpoints']))
    late=relative(score(pooled,scales,'role',accuracy['lateCheckpoints']),score(pooled,scales,'earlyNBA',accuracy['lateCheckpoints']))
    positive=sum(score(rs,scales,'role') is not None and score(rs,scales,'role')<score(rs,scales,'earlyNBA') for rs in tests.values())
    if early is None or early>-accuracy['minimumEarlyCompositeImprovement']:reasons.append('early-accuracy')
    if late is None or late>accuracy['maximumLateCompositeRegression']:reasons.append('late-accuracy')
    if positive<accuracy['minimumHoldoutSeasonsWithPositiveComposite']:reasons.append('repeatability')
    metric_regressions={k:relative(score(pooled,scales,'role',keys=[k]),score(pooled,scales,'earlyNBA',keys=[k])) for k in METRICS}
    if sum(v is not None and v>accuracy['maximumIndividualMetricRelativeRegression'] for v in metric_regressions.values())>accuracy['maximumMetricsOverRegressionLimit']:reasons.append('category-regressions')
    for n in CHECKPOINTS:
        if sum(r['players'] for r in pooled if r['nbaGames']==n)<sample['minimumConditionalHoldoutPlayersPerCheckpoint']:reasons.append('holdout-count-'+str(n))
    avrows=[r for rs in availability.values() for r in rs]
    for key,limit in [('GP','maximumGPMAERelativeRegression'),('Brier','maximumBrierRelativeRegression')]:
        xs={m:[r['mae'][m][key] for r in avrows if r['mae'][m][key] is not None] for m in ('baseline','rookie')}
        regression=relative(mean(xs['rookie']) if xs['rookie'] else None,mean(xs['baseline']) if xs['baseline'] else None)
        if regression is None or regression>criteria['availability'][limit]:reasons.append('availability-'+key)
    # CI and production inference are reviewed independently; never auto-enable.
    return {'researchPassed':not reasons,'failedCriteria':reasons,'productionEnabled':False,
            'earlyCompositeRelativeChange':early,'lateCompositeRelativeChange':late,
            'positiveHoldoutSeasons':positive,'metricRelativeChanges':metric_regressions,
            'pending':['full-regression-CI','production-model-review']}


def run(input_dir,output):
    criteria=json.loads(Path('scripts/rookie-acceptance-criteria.json').read_text())
    raw=json.loads((input_dir/'cohorts.json').read_text())
    if raw.get('selectionPolicy'):
        # The old protocol and already inspected holdout belong to the old
        # population. Do not silently refit, retune, or relabel that evidence.
        output.mkdir(parents=True,exist_ok=True)
        atomic_write({'schemaVersion':1,'status':'requires-new-evaluation-protocol',
                      'selectionPolicy':raw['selectionPolicy'],'productionEnabled':False,
                      'parametersChanged':False,'newIndependentAccuracyEvidence':False,
                      'legacyCriteriaSha256':hashlib.sha256(Path('scripts/rookie-acceptance-criteria.json').read_bytes()).hexdigest()},
                     output/'rookie-selection-evaluation-status.json')
        return
    summary=json.loads((input_dir/'collection-summary.json').read_text())
    validate_corpus(raw)
    schedules=raw['schedules'];cohorts={int(y):[dict(r,year=int(y)) for r in rows] for y,rows in raw['cohorts'].items()}
    split=criteria['split'];train=[r for y in split['trainingEndingYears'] for r in cohorts.get(y,[])];validation=[r for y in split['validationEndingYears'] for r in cohorts.get(y,[])]
    output.mkdir(parents=True,exist_ok=True)
    if not train or not validation:
        atomic_write({'productionEnabled':False,'status':'insufficient-reconciled-data','cohortCounts':{str(y):len(rs) for y,rs in cohorts.items()},'sourceFailures':summary['sourceFailures']},output/'rookie-revision-backtest.json');return
    priors,fits,pairs=fit(train,criteria['sample']['minimumGroupPlayers'],criteria['sample']['minimumNCAAPairs'])
    scales=training_scales(train,schedules)
    params={'schemaVersion':1,'version':'14.1.1-research','enabled':False,'calibrationStatus':'research-only',
            'releaseGate':'Research only; preregistered holdout and full CI must pass; no automatic activation.',
            'priors':priors,'ncaaFits':fits,'ncaaEnabled':False,'minutesK':10,'rateK':{k:600 for k in RATE_KEYS},
            'shootingK':{k:100 for k in KINDS},'roleWeight':0,
            'trainingSeasons':split['trainingEndingYears'],'validationSeasons':split['validationEndingYears'],'testSeasons':split['untouchedHoldoutEndingYears']}
    params,choices=tune(validation,schedules,params,scales)
    cells=fit_availability(train,schedules,criteria['sample']['minimumGroupPlayers'])
    ks=[]
    for k in (1,5,10,20,40,80):
        rs=availability_evaluate(validation,schedules,params,cells,k)
        errors=[r['mae']['rookie']['GP'] for r in rs if r['mae']['rookie']['GP'] is not None]
        if errors:ks.append((mean(errors),k))
    if not ks:raise ValueError('No validation availability outcomes')
    availability_k=min(ks)[1]
    params['availabilityResearch']={'cells':cells,'elapsedK':availability_k,'productionEnabled':False}
    # Persist frozen parameters before opening holdout outcomes. No subsequent
    # tuning is allowed by this command or the preregistered criteria.
    frozen=json.dumps(params,sort_keys=True,separators=(',',':')).encode();freeze_hash=hashlib.sha256(frozen).hexdigest()
    atomic_write(params,output/'rookie-revision-parameters.json')
    tests={str(y):conditional_evaluate(cohorts.get(y,[]),schedules,params) for y in split['untouchedHoldoutEndingYears']}
    availability={str(y):availability_evaluate(cohorts.get(y,[]),schedules,params,cells,availability_k) for y in split['untouchedHoldoutEndingYears']}
    counts={str(y):len(cohorts.get(y,[])) for y in split['trainingEndingYears']}
    acceptance=gates(criteria,train,counts,tests,availability,scales,summary)
    report={'schemaVersion':1,'status':'evaluated-frozen-holdout','parameterSha256':freeze_hash,
            'criteriaSha256':hashlib.sha256(Path('scripts/rookie-acceptance-criteria.json').read_bytes()).hexdigest(),
            'inputSha256':hashlib.sha256((input_dir/'cohorts.json').read_bytes()).hexdigest(),
            'split':split,'cohortCounts':{str(y):len(rs) for y,rs in cohorts.items()},'trainingRookies':len({r['id'] for r in train if r['games']}),'trainingAvailabilityCohort':len(train),
            'ncaaTrainingPairs':pairs,'ncaaEnabled':params['ncaaEnabled'],'trainingScales':scales,
            'trainingGroups':{'draft':dict(Counter(draft_group(r['profile']) for r in train if r['games'])),
                              'preNBALeague':dict(Counter(r['profile'].get('preNBALeague','unknown') for r in train if r['games']))},
            'selection':choices,'validation':conditional_evaluate(validation,schedules,params),
            'holdout':tests,'availabilityHoldout':availability,'acceptance':acceptance,
            'limitations':['Conditional statistics predict production when playing; zero future appearances have no conditional target but remain in availability.',
                'Drafted players who never joined the NBA remain at checkpoint zero in availability. Undrafted players with no debut cannot be reconstructed from boxscores.',
                'Availability denominator uses the checkpoint team schedule; later trades affect outcomes and are counted, never used as input.',
                'No verified historical injury/contract roster snapshots; availability is empirical attendance, not an injury-return forecast.',
                'NCAA branch uses explicit collegeAthlete crosswalk only. No calibrated international league conversion.',
                'Minutes and rates are separate; pooled priors describe groups, not precise individual player forecasts.',
                'No holdout-driven retuning. Previously seen 2023-26 results are not independent holdout evidence.']}
    atomic_write(report,output/'rookie-revision-backtest.json')
    print('REVISION_BACKTEST_SUMMARY '+json.dumps({k:report[k] for k in ('trainingRookies','cohortCounts','ncaaTrainingPairs','ncaaEnabled','acceptance')}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--input-dir',type=Path,default=Path('artifacts/rookie-revision'));parser.add_argument('--output-dir',type=Path,default=Path('artifacts/rookie-revision'));args=parser.parse_args();run(args.input_dir,args.output_dir)
