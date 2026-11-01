"""Research-only returning veteran empirical Bayes model.

An anchor is an observed significant season, never a synthetic missing season.
Performance and participation are separate; no production import of this module.
"""
from collections import defaultdict
import math
from statistics import mean, median, pvariance
from ros_model import summary, project, CONFIG, validate_stats

RATES=('2PA','3PA','FTA','REB','AST','STL','BLK','TO')
METRICS=('MIN','PTS','3PM','REB','AST','STL','BLK','TO','FGM','FGA','FTM','FTA','FG%','FT%')


def values(minutes,stats):
    return {'MIN':minutes,**stats,'FG%':100*stats['FGM']/stats['FGA'] if stats['FGA'] else None,'FT%':100*stats['FTM']/stats['FTA'] if stats['FTA'] else None}


def observed_values(games):
    s=summary(games)
    if not games:return None
    return values(s['mpg'],{**{k:v/len(games) for k,v in s['totals'].items()},'PTS':mean(g['stats']['PTS'] for g in games)})


def observed_anchor(history,year):
    if any(y>=year for y in history):raise ValueError('Future history leakage')
    anchors=[y for y,gs in history.items() if year-8<=y<year-1 and len(gs)>=20 and sum(g['minutes'] for g in gs)>=500]
    if not anchors:return None
    anchor=max(anchors)
    ids={g['id'] for gs in history.values() for g in gs}
    if len(ids)!=1:raise ValueError('Mixed ESPN identities')
    older=[y for y in sorted(history,reverse=True) if y<anchor and history[y]][:3]
    a=summary(history[anchor]);o=summary([g for y in older for g in history[y]])
    # An older pool has genuine per-minute rates; no calendar-gap multiplication.
    return {'id':next(iter(ids)),'lastFeatureDate':max(g['date'] for gs in history.values() for g in gs),'year':anchor,'summary':a,'older':o if o['minutes'] else a,'years':sorted([anchor,*older]),'observedYears':sorted(y for y,gs in history.items() if gs),'unmodeledPartialYears':sorted(y for y,gs in history.items() if gs and anchor<y<year),'gap':sum(not history.get(y) for y in range(anchor+1,year)),'position':history[anchor][-1].get('position') or 'unknown'}


def anchor_summary(history,year,certified):
    a=observed_anchor(history,year)
    if a is None or history.get(year-1):return None
    if any(y not in certified for y in range(a['year'],year)):return None
    return a


def group_key(a):return f"{min(a['gap'],3)}:{a['position']}"


def fit(training,controls=()):
    """Fit from completed past episodes only, one contribution per identity.

    Each training record carries a historical anchor and later observed season.
    No current/evaluation rows or target-player constants are read here.
    """
    if not training:return None
    per=defaultdict(list)
    for r in training:per[r['id']].append(r)
    weights={id(r):1/len(per[r['id']]) for r in training}
    def avg(pairs):
        return sum(v*w for v,w in pairs)/sum(w for _,w in pairs)
    delta=avg([(summary(r['current'])['mpg']-r['anchor']['summary']['mpg'],weights[id(r)]) for r in training])
    cells=defaultdict(list)
    for r in training:cells[group_key(r['anchor'])].append(r)
    shifts={key:avg([(summary(r['current'])['mpg']-r['anchor']['summary']['mpg'],weights[id(r)]) for r in rs]) for key,rs in cells.items() if len({r['id'] for r in rs})>=10}
    residual=[(summary(r['current'])['mpg']-r['anchor']['summary']['mpg']-shifts.get(group_key(r['anchor']),delta),weights[id(r)]) for r in training]
    rolevar=avg([(v*v,w) for v,w in residual])
    noise=avg([(pvariance(g['minutes'] for g in r['current']) if len(r['current'])>1 else 0,weights[id(r)]) for r in training])
    if controls:
        noise=mean([noise,mean(pvariance(g['minutes'] for g in gs) for gs in controls if len(gs)>1)])
    params={'version':'returning-anchor-eb-v2','players':len(per),'episodes':len(training),'minuteShift':delta,'minuteCellShifts':shifts,'minuteK':max(3,noise/max(rolevar,1e-9)),'rates':{},'shooting':{}}
    floor=5*median(r['anchor']['summary']['mpg'] for r in training)
    for k in RATES:
        pairs=[(r['anchor']['summary']['rates'][k],r['anchor']['older']['rates'][k],summary(r['current'])['rates'][k],weights[id(r)],summary(r['current'])['minutes']) for r in training]
        denom=sum(w*(a-o)**2 for a,o,t,w,m in pairs)
        blend=max(0,min(1,sum(w*(t-o)*(a-o) for a,o,t,w,m in pairs)/denom)) if denom else 1
        priors=[(blend*a+(1-blend)*o,t,w,m) for a,o,t,w,m in pairs]
        residualvar=avg([((t-p)**2-t/max(m,1),w) for p,t,w,m in priors])
        priorrate=avg([(p,w) for p,t,w,m in priors])
        params['rates'][k]={'anchorWeight':blend,'pseudoMinutes':max(floor,priorrate/max(residualvar,1e-9))}
    for kind,minimum in CONFIG['shootingAttemptsK'].items():
        made,att=('FTM','FTA') if kind=='FT' else (kind+'M',kind+'A')
        pairs=[]
        for r in training:
            a=r['anchor']['summary']['totals'];t=summary(r['current'])['totals']
            if a[att]>0 and t[att]>0:p=a[made]/a[att];q=t[made]/t[att];pairs.append((p,q,t[att],weights[id(r)]))
        v=avg([((q-p)**2-q*(1-q)/n,w) for p,q,n,w in pairs]) if pairs else 0
        numerator=avg([(p*(1-p),w) for p,q,n,w in pairs]) if pairs else 0
        params['shooting'][kind]=max(minimum,numerator/max(v,1e-9)-1)
    return params


def predict(history,current,year,certified,params,as_of,policy='anchorEB'):
    if not params:return None
    if any(g['date']>as_of for gs in [*history.values(),current] for g in gs):raise ValueError('Future observation leakage')
    a=anchor_summary(history,year,certified)
    if a is None:return None
    if len({g['id'] for gs in [*history.values(),current] for g in gs})!=1:raise ValueError('Mixed ESPN identities')
    return conditional_performance(a,current,params,as_of,policy)


def conditional_performance(a,current,params,as_of,policy='anchorEB'):
    """Conditional scenario API, independent of returning-eligibility routing.

    Does not certify missing seasons or GP. Caller must expose classification
    uncertainty. Raw dates and exact identity remain checked even in research.
    """
    if a['lastFeatureDate']>as_of or any(g['date']>as_of for g in current):raise ValueError('Future observation leakage')
    if any(g['id']!=a['id'] for g in current):raise ValueError('Mixed ESPN identities')
    v1=project([],current)
    if policy=='preserveAvailableV1' and v1['status']=='available':
        return {**v1,'model':'production-v1-preserved','anchorYear':a['year'],'historyYears':a['years'],'observedHistoryYears':a['observedYears'],'unmodeledPartialYears':a['unmodeledPartialYears'],'currentMinutesWeight':1,'productionEnabled':False}
    if policy not in ('anchorEB','preserveAvailableV1'):raise ValueError('Unknown model policy')
    p=a['summary'];o=a['older'];c=summary(current)
    w=len(current)/(len(current)+params['minuteK'])
    prior=max(0,p['mpg']+params['minuteCellShifts'].get(group_key(a),params['minuteShift']))
    mpg=min(CONFIG['role']['maxMinutes'],max(0,(1-w)*prior+w*(c['mpg'] or 0)))
    rates={}
    for k in RATES:
        cfg=params['rates'][k];rate=cfg['anchorWeight']*p['rates'][k]+(1-cfg['anchorWeight'])*o['rates'][k]
        strength=cfg['pseudoMinutes'];rates[k]=(rate*strength+c['totals'][k])/(strength+c['minutes'])
    shots={}
    for kind,strength in params['shooting'].items():
        made,att=('FTM','FTA') if kind=='FT' else (kind+'M',kind+'A')
        a0=p['totals'][att];b0=o['totals'][att]
        # Genuine zero volume is different from missing statistics. If neither
        # history has attempts, current attempts alone identify efficiency.
        prior=p['totals'][made]/a0 if a0 else o['totals'][made]/b0 if b0 else None
        ca=c['totals'][att]
        probability=(strength*prior+c['totals'][made])/(strength+ca) if prior is not None else c['totals'][made]/ca if ca else 0
        shots[kind]={'attempts':rates[att]*mpg,'percentage':probability}
    threes=shots['3P']['attempts']*shots['3P']['percentage'];fgm=shots['2P']['attempts']*shots['2P']['percentage']+threes;ftm=shots['FT']['attempts']*shots['FT']['percentage']
    stats={'FGM':fgm,'FGA':shots['2P']['attempts']+shots['3P']['attempts'],'FTM':ftm,'FTA':shots['FT']['attempts'],'3PM':threes,'PTS':2*fgm+threes+ftm,**{k:rates[k]*mpg for k in ('REB','AST','STL','BLK','TO')}}
    validate_stats(stats,shots)
    return {'model':params['version'],'minutes':mpg,'stats':stats,'shooting':shots,'anchorYear':a['year'],'historyYears':a['years'],'observedHistoryYears':a['observedYears'],'unmodeledPartialYears':a['unmodeledPartialYears'],'missedSeasons':a['gap'],'minutesPrior':prior,'minuteK':params['minuteK'],'currentRateWeights':{k:c['minutes']/(cfg['pseudoMinutes']+c['minutes']) for k,cfg in params['rates'].items()},'currentShotWeights':{kind:c['totals']['FTA' if kind=='FT' else kind+'A']/(strength+c['totals']['FTA' if kind=='FT' else kind+'A']) for kind,strength in params['shooting'].items()},'currentMinutesWeight':w,'productionEnabled':False,'confidence':'research-only','publishedROSgp':None,'publishedTotals':None}


def participation_fit(rows):
    by=defaultdict(list)
    for r in rows:by[r['id']].append(r)
    if not by:return None
    rates=[mean(x['futureGP']/x['horizon'] for x in rs) for rs in by.values()]
    p=mean(rates);var=pvariance(rates)
    return {'priorRate':p,'concentration':max(1,p*(1-p)/max(var,1e-9)-1),'anyAppearance':mean(mean(x['futureGP']>0 for x in rs) for rs in by.values()),'distinctPlayers':len(by),'zeroFutureCases':sum(r['futureGP']==0 for r in rows),'researchMaximumHorizon':max(r['horizon'] for r in rows),'validated':False}


def participation(params,n,elapsed,horizon):
    if params is None or n==0 or elapsed is None or horizon is None:return None
    if horizon>params['researchMaximumHorizon']:return None
    rate=(n+params['concentration']*params['priorRate'])/(max(n,elapsed)+params['concentration'])
    return {'expectedGP':horizon*rate,'probabilityAnyAppearance':params['anyAppearance'],'confidence':'research-only-conditional-on-return','publishableGP':None}
