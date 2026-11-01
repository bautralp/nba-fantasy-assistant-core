"""Offline chronological rookie calibration. Never called by the daily workflow.

Train 2022-23, select reliability on 2023-24, evaluate frozen parameters on
2024-25 and 2025-26 once. Requires downloaded source bytes and ESPN profiles.
"""
import argparse
from collections import defaultdict, Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from statistics import mean
from parquet_io import read_parquet
from refresh_stats import FIELDS, atomic_write
from rookie_model import RATE_KEYS, KINDS, draft_group, prior_for, infer
from ros_model import summary

CHECKPOINTS = (0, 1, 3, 5, 10, 20)
METRICS = ('MIN', 'PTS', '3PM', 'REB', 'AST', 'STL', 'BLK', 'TO', 'FGA', 'FG%', 'FTA', 'FT%')


def read_games(path, year, ncaa=False):
    table = read_parquet(path.read_bytes())
    required = set(FIELDS.values()) | {'athlete_id', 'season', 'season_type', 'game_date', 'game_id', 'minutes', 'did_not_play', 'three_point_field_goals_attempted'}
    if not required <= set(table.column_names): raise ValueError('Historical schema changed')
    rows = {}
    rejected = Counter()
    for r in table.to_pylist():
        if int(r['season']) != year: raise ValueError('Historical season mismatch')
        if r['season_type'] not in ((2, 3) if ncaa else (2,)) or r['did_not_play'] or r['minutes'] is None or r['minutes'] <= 0: continue
        day = r['game_date'].isoformat()
        if not f'{year-1}-07-01' <= day < f'{year}-07-01': raise ValueError('Historical date mismatch')
        stats = {k: r[v] for k, v in FIELDS.items()}; stats['3PA'] = r['three_point_field_goals_attempted']
        if any(v is None or v < 0 for v in stats.values()):
            rejected['missing-or-negative-stats'] += 1; continue
        if stats['3PM'] > stats['FGM'] or stats['FGM'] > stats['FGA'] or stats['FTM'] > stats['FTA'] or stats['3PA'] > stats['FGA'] or stats['3PM'] > stats['3PA'] or stats['FGM']-stats['3PM'] > stats['FGA']-stats['3PA']:
            rejected['inconsistent-shooting'] += 1; continue
        g = {'id': str(r['athlete_id']), 'gameId': str(r['game_id']), 'date': day,
             'minutes': r['minutes'], 'starter': r.get('starter'), 'teamId': r['team_id'],
             'stats': stats, 'position': r.get('athlete_position_abbreviation', 'unknown')}
        key = (g['id'], g['gameId'])
        if key in rows and rows[key] != g: raise ValueError('Conflicting historical duplicate')
        rows[key] = g
    result = defaultdict(list)
    for g in sorted(rows.values(), key=lambda g: (g['date'], g['gameId'])): result[g['id']].append(g)
    return result, {'columns': table.column_names, 'rows': table.num_rows, 'acceptedGames': len(rows), 'rejected': dict(rejected)}


def ncaa_profile(profile, by_id, before):
    college_id = str((profile.get('collegeAthlete') or {}).get('id', ''))
    # Explicit NBA response crosswalk is necessary, even when IDs happen to be equal.
    rows = [g for g in by_id.get(college_id, []) if g['date'] < before]
    if not rows: return None
    if any(g['id'] != college_id for g in rows): raise ValueError('NCAA source identity mismatch')
    s = summary(rows)
    return {'id': college_id, 'gp': s['gp'], 'minutes': s['minutes'], 'through': rows[-1]['date'],
            'rates': {k: s['rates'][k] for k in RATE_KEYS}, 'position': rows[-1]['position']}


def target(rows):
    s = summary(rows)
    return {'MIN': s['mpg'], **{k: mean(g['stats'][k] for g in rows) for k in METRICS if k not in ('MIN', 'FG%', 'FT%')},
            **{p: s['totals'][m] / s['totals'][a] if s['totals'][a] else None for p,m,a in [('FG%','FGM','FGA'),('FT%','FTM','FTA')]}}


def sample_prior(rows):
    s = summary(rows)
    return {'minutes': s['mpg'], 'rates': {k: s['rates'][k] for k in RATE_KEYS},
            'percentages': {k: s['totals'][m] / s['totals'][a] if s['totals'][a] else 0 for k,m,a in [('2P','2PM','2PA'),('3P','3PM','3PA'),('FT','FTM','FTA')]}}


def fit_priors(cohort):
    groups = defaultdict(list)
    for r in cohort:
        group = draft_group(r['profile']); prior = sample_prior(r['games'][:30])
        groups['all'].append(prior); groups[group].append(prior); groups[group+':'+r['profile']['priorPosition']].append(prior)
    if not groups['all']: raise ValueError('No verified training rookies')
    return {k: {'minutes': mean(p['minutes'] for p in rows),
                'rates': {x: mean(p['rates'][x] for p in rows) for x in RATE_KEYS},
                'percentages': {x: mean(p['percentages'][x] for p in rows) for x in KINDS}, 'players': len(rows)}
            for k, rows in groups.items() if k == 'all' or len(rows) >= 8}


def fit_ncaa(cohort):
    paired = [r for r in cohort if r['profile'].get('ncaa')]
    fits = {}
    for key in RATE_KEYS:
        x = [r['profile']['ncaa']['rates'][key] for r in paired]
        y = [sample_prior(r['games'][:30])['rates'][key] for r in paired]
        if len(x) < 8: continue
        mx,my = mean(x),mean(y)
        variance = sum((v-mx)**2 for v in x)
        slope = max(0, sum((a-mx)*(b-my) for a,b in zip(x,y))/variance) if variance else 0
        fits[key] = {'slope': slope, 'intercept': my-slope*mx, 'players': len(x)}
    return fits


def predictions(row, n, params, mode):
    observed = row['games'][:n]
    if mode == 'earlyNBA': return target(observed) if observed else None
    if mode == 'ncaa' and not params.get('ncaaFits'): return None
    prior = prior_for(row['profile'], {**params, 'ncaaEnabled': mode in ('ncaa','role') and params.get('ncaaEnabled', True)})
    if prior is None: return None
    result = infer(prior, observed, params, use_role=mode == 'role')
    s = result['stats']
    return {'MIN': result['minutes'], **s, 'FG%': s['FGM']/s['FGA'] if s['FGA'] else None, 'FT%': s['FTM']/s['FTA'] if s['FTA'] else None}


def evaluate(cohort, params):
    report = []
    for n in CHECKPOINTS:
        errors = {m: {k: [] for k in METRICS} for m in ('earlyNBA','fixedPrior','ncaa','role')}
        ids = []; excluded = []
        for row in cohort:
            future = row['games'][n:n+30]
            if len(future) < 20: continue
            truth = target(future)
            preds = {mode: predictions(row,n,params,mode) for mode in errors}
            if preds['role'] is None:
                excluded.append(row['id']); continue
            ids.append(row['id'])
            for mode, pred in preds.items():
                if pred is None: continue
                for key in METRICS:
                    # Compare identical players and percentage denominators across models.
                    if n and preds['earlyNBA'][key] is None: continue
                    if truth[key] is not None and pred[key] is not None: errors[mode][key].append(abs(pred[key]-truth[key]))
        report.append({'nbaGames': n, 'players': len(ids), 'ids': ids, 'excludedNoVerifiedPrior': excluded,
            'mae': {m:{k:mean(v) if v else None for k,v in es.items()} for m,es in errors.items()},
            'metricCounts': {m:{k:len(v) for k,v in es.items()} for m,es in errors.items()}})
    return report


def tune(cohort, params):
    # Validation only. Each reliability group minimizes its own meaningful error.
    for field, keys, candidates in [('minutesK', ['MIN'], [1,3,5,10,20,40]),
        *[('rateK.'+k,[k] if k in METRICS else ['FGA'] if k in ('2PA','3PA') else ['FTA'], [50,100,300,600,1200,2400]) for k in RATE_KEYS],
        ('shootingK.2P',['FG%'],[20,50,100,200,400]),('shootingK.3P',['FG%'],[20,50,100,200,400]),('shootingK.FT',['FT%'],[20,50,100,200,400]),
        ('roleWeight',['MIN'],[0,.25,.5])]:
        def setvalue(p,v):
            if '.' in field:
                a,b=field.split('.');p[a][b]=v
            else:p[field]=v
        scores=[]
        for v in candidates:
            p=deepcopy(params);setvalue(p,v); reports=evaluate(cohort,p)
            mode='role' if field=='roleWeight' else 'fixedPrior'
            score=mean(r['mae'][mode][k] for r in reports if r['nbaGames']>0 for k in keys if r['mae'][mode][k] is not None)
            scores.append((score,v))
        setvalue(params,min(scores)[1])
    return params


def run(directory, profiles_raw, output, frozen_parameters=None):
    nba, ncaa, schemas = {}, {}, {}
    for y in range(2023,2028): nba[y],schemas['nba-'+str(y)] = read_games(directory / ('nba-'+str(y)),y)
    for y in range(2022,2027): ncaa[y],schemas['ncaa-'+str(y)] = read_games(directory / ('ncaa-'+str(y)),y,True)
    profiles = {}
    for raw in profiles_raw:
        p=deepcopy(raw); pid=str(p['id']); p['identityVerified'] = not p.get('error') and p.get('uid') == 's:40~l:46~a:'+pid
        p.setdefault('retrievedAt', datetime.now(timezone.utc).isoformat())
        p['historyCoverage'] = list(range(2023,2027))
        p['nbaHistory'] = {str(y):len(rows[pid]) for y,rows in nba.items() if pid in rows}
        if not p['identityVerified']: p['missingReason'] = p.get('error','NBA identity not verified')
        debut=min([s['year'] for s in p.get('seasons',[])] + [int(y) for y in p['nbaHistory']],default=2027)
        c=None
        for college_year in sorted(ncaa,reverse=True):
            if college_year >= debut: continue
            c=ncaa_profile(p,ncaa[college_year],f'{debut-1}-07-01')
            if c:break
        if c:p['ncaa']=c
        p['priorPosition'] = c['position'] if c else 'unknown'
        profiles[pid]=p
    cohorts = defaultdict(list)
    for y in range(2023,2027):
        for pid, games in nba[y].items():
            p=deepcopy(profiles.get(pid,{})); seasons=p.get('seasons',[])
            if not p.get('identityVerified') or not p.get('careerSchemaVerified') or not seasons or min(s['year'] for s in seasons)!=y:continue
            if any(pid in nba[older] for older in range(2023,y)):continue
            if len(games)<20:continue
            # Prior features from the NCAA season BEFORE NBA debut, never current NBA position.
            p.pop('ncaa',None); c=ncaa_profile(p,ncaa[y-1],f'{y-1}-07-01')
            if c:p['ncaa']=c
            p['priorPosition']=c['position'] if c else 'unknown'
            cohorts[y].append({'id':pid,'profile':p,'games':games[:50]})
    params={'schemaVersion':1,'version':'14.1.0','enabled':False,'ncaaEnabled':True,'priors':fit_priors(cohorts[2023]),'ncaaFits':fit_ncaa(cohorts[2023]),
        'minutesK':10,'rateK':{k:600 for k in RATE_KEYS},'shootingK':{k:100 for k in KINDS},'roleWeight':0,
        'trainingSeasons':['2022-23'],'validationSeasons':['2023-24'],'testSeasons':['2024-25','2025-26']}
    params=deepcopy(frozen_parameters) if frozen_parameters is not None else tune(cohorts[2024],params)
    validation=evaluate(cohorts[2024],params)
    # NCAA branch is selected before looking at test seasons.
    if frozen_parameters is None:
        params['ncaaEnabled'] = bool(params['ncaaFits']) and mean(r['mae']['ncaa']['PTS'] for r in validation) < mean(r['mae']['fixedPrior']['PTS'] for r in validation)
    tests={str(y):evaluate(cohorts[y],params) for y in (2025,2026)}
    params['enabled']=False
    params['calibrationStatus']='research-only'
    params['releaseGate']='Research only: historical schedule reconciliation unavailable (HTTP 503); incomplete ESPN career coverage; no automatic production activation.'
    output.mkdir(parents=True,exist_ok=True)
    files=[p for p in directory.iterdir() if p.is_file() and (p.name.startswith('nba-') or p.name.startswith('ncaa-'))]
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    params['inputSha256']=hashes
    report={'schemaVersion':1,'parameters':params,'sourceSchemas':schemas,'cohortCounts':{str(y):len(v) for y,v in cohorts.items()},
        'reportMethod':'Paired player and percentage-denominator comparison; frozen parameters, no test-driven retuning.',
        'ncaaMatchedCohorts':{str(y):sum(bool(r['profile'].get('ncaa')) for r in v) for y,v in cohorts.items()},
        'validation':validation,'test':tests,'limitations':['NBA season_type=2 only: Cup championship exclusion not reconciled; historical schedule endpoints returned 503.',
        'Career metadata retrieved retrospectively; only immutable draft and explicit NCAA crosswalk used as features. No current age, NBA role or future career totals enter priors.',
        'Only verified career debut cohorts; >=20 future appearances conditions on survival. Not an availability or injury model.',
        'NCAA fits use prior season only, not full college career; no European league conversion. Sparse groups (<8) fall back to broader prior.']}
    atomic_write({'schemaVersion':1,'profiles':profiles,'sourceHashes':hashes},output/'rookie-profiles.json')
    atomic_write(params,output/'rookie-parameters.json');atomic_write(report,output/'rookie-backtest.json')
    print('cohorts',report['cohortCounts'],'ncaa',report['ncaaMatchedCohorts'],'NCAA enabled',params['ncaaEnabled'])


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input-dir',type=Path,required=True);p.add_argument('--profiles',type=Path,required=True);p.add_argument('--output-dir',type=Path,required=True);p.add_argument('--frozen-parameters',type=Path);a=p.parse_args()
    run(a.input_dir,json.loads(a.profiles.read_text()),a.output_dir,json.loads(a.frozen_parameters.read_text()) if a.frozen_parameters else None)
