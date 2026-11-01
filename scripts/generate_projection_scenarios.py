"""Explicit exploratory product scenarios; never enables the scientific gates.

Standard ROS is read-only. All GP/role assumptions stay in a separate snapshot.
"""
import argparse
from collections import defaultdict
from datetime import date,datetime,timezone
import copy
import gzip
import hashlib
import json
import tempfile
from pathlib import Path
from statistics import mean
from ros_model import summary,project,projection_games,validate_stats
from ros_history_research import load_season
from rookie_model import prior_for,infer,classify
from returning_veteran import observed_anchor,conditional_performance
from projection_phase import before_regular_season
from regular_season import schedule_index
from refresh_stats import atomic_write
from attendance_opportunities import observed_opportunities, observed_team_games, matched_appearances, validate_period_map, VERSION as OPPORTUNITY_VERSION

ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'scripts/scenario-projection-config.json').read_text())


def usable(evidence,as_of):
    return evidence and evidence['observedAt'][:10]<=as_of<=evidence['validUntil']


def adjust_role(result,evidence,current,as_of,config=CONFIG):
    """Only independent depth/preseason signals; NBA games already update performance."""
    r=copy.deepcopy(result);targets=[];used=[]
    if usable(evidence,as_of):
        ranks=evidence.get('depthRanks',[])
        if ranks:
            rank=min(x['rank'] for x in ranks)
            if rank<1:raise ValueError('Invalid depth rank')
            targets.append(config['depthMinutes'][min(rank,4)-1]);used.append('provider-depth-estimate')
        observations=[x for x in evidence.get('preseason',[]) if x['seasonType']==1 and x['date']<=as_of and x['teamId']==evidence['nbaTeamId']][-config['preseasonMaximumGames']:]
        if len({x['gameId'] for x in observations})!=len(observations):raise ValueError('Duplicate preseason role observations')
        if {x['gameId'] for x in observations}&{g['gameId'] for g in current}:raise ValueError('Preseason/regular season identity overlap')
        if observations:targets.append(mean(x['minutes'] for x in observations));used.append('observed-preseason-minutes')
        restriction=evidence.get('minuteRestriction')
        if restriction is not None and not 0<=restriction<=48:raise ValueError('Invalid minute restriction')
    else:restriction=None
    weight=config['roleMaximumWeight']/(1+len(current)/config['roleFadeGames']) if targets else 0
    old=r['minutes'];mpg=(1-weight)*old+weight*mean(targets) if targets else old
    mpg=min(48,max(0,mpg))
    if restriction is not None:mpg=min(mpg,restriction);used.append('verified-minute-restriction')
    if old<=0 and mpg>0:raise ValueError('Role evidence cannot create unknown performance rates')
    scale=mpg/old if old else 0
    r['minutes']=mpg;r['stats']={k:v*scale for k,v in r['stats'].items() if k not in ('FG%','FT%')}
    r['shooting']={k:{**v,'attempts':v['attempts']*scale} for k,v in r['shooting'].items()}
    validate_stats(r['stats'],r['shooting'])
    return r,{'used':used,'weight':weight,'performanceMinutesBeforeRole':old,'regularGamesAlreadyInPerformance':len(current),'preseasonUsedForRates':False,'assumption':'scenario-assumption' if used else None}


def rookie_attendance(corpus):
    """Reuse frozen TRAINING years only; no fresh fit or development/holdout leakage."""
    rates=defaultdict(list);seen=set()
    from rookie_model import draft_group
    for year in range(2013,2019):
        schedule=corpus['schedules'][str(year)]
        for row in corpus['cohorts'][str(year)]:
            if (row['id'],year) in seen:raise ValueError('Duplicate rookie cohort identity')
            seen.add((row['id'],year));games=row['games']
            if not games:continue
            # No dated historical transaction ledger exists in the frozen corpus.
            # Exclude ambiguous transfer episodes from this NEW product GP prior;
            # never retrofit a transaction date or alter frozen 14.2 parameters.
            teams={g['teamId'] for g in games}
            if len(teams)!=1:continue
            events=[{'id':gid,'date':v['date'],'teamIds':v['teams']} for gid,v in schedule.items() if v['excluded'] is None]
            scope=observed_opportunities(row['id'],games,events,next(iter(teams)),f'{year}-06-30')
            opportunities=scope['count']
            if not opportunities or len(games)>opportunities:continue
            p=len(games)/opportunities;rates['all'].append(p);rates[draft_group(row['profile'])].append(p)
    return {k:{'rate':mean(v),'episodes':len(v),'trainingEndingYears':list(range(2013,2019)), 'opportunityPolicy':OPPORTUNITY_VERSION, 'transferEpisodes':'excluded-without-dated-assignment-history'} for k,v in rates.items()}


def attendance(experience,history,current,team,remaining,elapsed,evidence,as_of,rookie_prior,config=CONFIG,season_ending_year=None):
    if team==0:return {'expectedGames':0,'range':[0,0,0],'basis':'verified-unassigned','assumptions':[]}
    scope=elapsed if isinstance(elapsed,dict) else None
    if scope is not None:current=matched_appearances(current,scope)
    elapsed=scope['count'] if scope is not None else elapsed
    if team is None or remaining is None or elapsed is None:return None
    active=[y for y,gs in history.items() if gs]
    if experience in ('rookie','international-newcomer'):prior=rookie_prior['rate'];basis='frozen-rookie-training-attendance'
    elif active:
        last=max(active);prior=min(1,len(history[last])/82)
        intervening=range(last+1,season_ending_year or (int(as_of[:4])+1 if int(as_of[5:7])>=7 else int(as_of[:4])))
        gap=sum(y in history and not history[y] for y in intervening)
        # History uses ending years; current season is ending year as_of fall +1.
        if experience=='returning-veteran':prior/=1+gap
        basis='observed-history-scenario-attendance'
    else:return None
    injury=None
    if usable(evidence,as_of):
        injury=evidence.get('injuryStatus')
        normalized=str(injury or '').upper().replace(' ','_').replace('-','_')
        prior*=config['injuryParticipationFactors'].get(normalized,1)
        if evidence.get('seasonOut') is True:return {'expectedGames':0,'range':[0,0,0],'basis':'verified-season-out','assumptions':[]}
    n=len(current);k=config['participationPriorGames'];rate=(n+k*prior)/(max(n,elapsed)+k)
    gp=remaining*max(0,min(1,rate))
    return {'expectedGames':gp,'range':[min(remaining,max(0,gp*f)) for f in config['participationScenarioFactors']], 'basis':basis,'priorRate':prior,'priorGames':k,'observedGames':n,'elapsedOpportunities':elapsed,'opportunityEvidence':scope,'injuryStatus':injury,'assumptions':['scenario-assumption; not a calibrated playing probability','ranges are sensitivity scenarios, not confidence intervals','unknown injury return date; attendance spread uniformly over schedule']+(scope['assumptions'] if scope else [])}


def build(standard,histories,current,schedule,roles,profiles,rookie_parameters,returning_parameters,rookie_prior,as_of,computed_at,team_periods=None):
    if as_of!=standard['asOf'] or as_of!=schedule['asOf']:raise ValueError('Snapshot asOf mismatch')
    if any(g['date']>as_of or g['date']<standard['season'][:4]+'-07-01' for gs in current.values() for g in gs):raise ValueError('Future/wrong-season current observation')
    projection=copy.deepcopy(standard);metadata={};source_cut=max((g['date'] for gs in current.values() for g in gs),default=None)
    observed_events=observed_team_games(g for gs in current.values() for g in gs)
    validate_period_map(team_periods, {p['id'] for p in standard['players']})
    # The attendance denominator is restricted to the same observed source cut;
    # future/missing releases are never interpreted as DNP.
    remaining=defaultdict(int)
    for g in schedule['games']:
        for t in g['teamIds']:remaining[t]+=1
    for row in projection['players']:
        pid=row['id'];history=histories.get(pid,{});now=current.get(pid,[]);profile=profiles.get(pid)
        if profile and (profile.get('retrievedAt','')[:10]>as_of or profile.get('draftIdentity',{}).get('retrievedAt','')[:10]>as_of):profile=None
        evidence=roles['players'].get(pid);evidence=evidence if usable(evidence,as_of) else None
        if evidence:evidence={**evidence,'regularObservations':[{'gameId':g['gameId'],'date':g['date'],'teamId':g['teamId'],'minutes':g['minutes'],'starter':g['starter']} for g in now]}
        pos=row['eligibility'];known=pos['status']=='verified' and pos['retrievedAt'][:10]<=as_of
        catalog_team=pos.get('proTeamId') if known else None
        team=catalog_team if type(catalog_team) is int and 0<=catalog_team<=30 else None
        # A live roster conflict is not resolved by guessing from old game teams.
        conflict=bool(evidence and team is not None and team!=evidence['nbaTeamId'])
        if conflict:team=None
        if team==0:evidence=None
        opportunities=observed_opportunities(pid,now,observed_events,team,as_of,(team_periods or {}).get(pid))
        expected=row['rosGP'];tier='standard';model='established-ros-v1';role_use={'used':[]};availability=None
        stats_ok=row['status']=='available' and row['stats'] is not None
        if evidence and str(evidence['espnId'])!=pid:raise ValueError('Role identity mismatch')
        if team==0:
            row['teamId']=0;row['teamRemaining']=0;row['rosGP']=0
        experience=classify(profile,history.get(int(standard['season'][:4]),[]),now,int(standard['season'][:4])+1)
        if experience=='unknown' and not history.get(int(standard['season'][:4])) and any(gs for y,gs in history.items() if y<int(standard['season'][:4])):experience='returning-veteran'
        # Component routing: valid performance is immutable, even when GP is missing.
        # Zero is known contribution, never a request for an attendance prior.
        missing_performance=not stats_ok
        missing_gp=expected is None
        can_complete=team is not None and team!=0 and known and not conflict
        if can_complete and (missing_performance or missing_gp):
            tier='extended';row['confidence']='low';result=None
            if profile and str(profile['id'])!=pid:raise ValueError('Profile identity mismatch')
            if evidence and str(evidence['espnId'])!=pid:raise ValueError('Role identity mismatch')
            if missing_performance:
                if profile and experience in ('rookie','international-newcomer'):
                    if profile.get('draftIdentity',{}).get('verified') and profile.get('nbaEntryVerified'):
                        prior=prior_for(profile,rookie_parameters)
                        if prior:result=infer(prior,now,rookie_parameters,use_role=False);model=rookie_parameters['version']
                else:
                    anchor=observed_anchor(history,int(standard['season'][:4])+1)
                    if anchor and experience=='returning-veteran':
                        result=conditional_performance(anchor,now,returning_parameters,as_of);model=result['model']
                    elif history.get(int(standard['season'][:4])):
                        result=project(history[int(standard['season'][:4])],now)
                        if result['status']!='available':result=None
                if result:
                    result,role_use=adjust_role(result,evidence,now,as_of)
                    row.update(experience=experience,projectionBasis=result.get('projectionBasis','NBA history' if any(history.values()) else 'Current NBA sample'),status='available',reason=None,stats=result['stats'],shooting=result['shooting'],minutes=result['minutes'],rank=None,totalZ=None)
                    row['stats'].update({'FG%':100*row['stats']['FGM']/row['stats']['FGA'] if row['stats']['FGA'] else None,'FT%':100*row['stats']['FTM']/row['stats']['FTA'] if row['stats']['FTA'] else None})
            if missing_gp and row['status']=='available':
                from rookie_model import draft_group
                prior=rookie_prior.get(draft_group(profile or {}),rookie_prior['all'])
                availability=attendance(experience,history,now,team,remaining.get(team,0),opportunities,evidence,as_of,prior,season_ending_year=int(standard['season'][:4])+1)
                if availability:
                    row.update(rosGP=availability['expectedGames'],teamRemaining=remaining.get(team,0),teamId=team)
            row['uncertainty']=[*row['uncertainty'],'Genişletilmiş model senaryosu; bilimsel production kabulü değildir.',f'Model {model}; veri kapsamı {source_cut or "normal sezon gözlemi yok"}.']
            if row['status']!='available' or row['rosGP'] is None:row['uncertainty'].append('Senaryo için temel kimlik/takım/performans girdisi eksik.')
        # Source safety overrides remain explicit. They invalidate a projection;
        # they never manufacture a replacement for conflicting/unknown identity.
        if conflict:
            row.update(status='unavailable',reason='NBA takım kaynakları çelişiyor',stats=None,minutes=None,rank=None,totalZ=None,rosGP=None,teamId=None,teamRemaining=None,teamIdentity={'status':'unknown','teamId':None,'source':'conflicting-roster-and-catalog','observedAt':roles['observedAt']})
            tier='extended';row['confidence']='low'
        if team!=0 and opportunities['count'] is None and row['rosGP']!=0:
            row['rosGP']=None;row['confidence']='low';tier='extended';availability=None
            if team is None:
                row.update(teamId=None,teamRemaining=None,team='Unknown')
                if not conflict:row['teamIdentity']={'status':'unknown','teamId':None,'source':'unresolved-current-catalog','observedAt':pos.get('retrievedAt')}
            row['uncertainty']=[*row['uncertainty'],opportunities['warning']]
        if can_complete and evidence and evidence.get('seasonOut') is True and row['rosGP']!=0:
            row['rosGP']=0;row['confidence']='low';tier='extended'
            availability={'expectedGames':0,'range':[0,0,0],'basis':'verified-season-out','assumptions':[]}
        metadata[pid]={'experience':experience,'tier':tier,'modelVersion':model,'scientificAcceptance':False,'confidence':row['confidence'],'roleEvidence':evidence,'roleUse':role_use,'availability':availability,'opportunityEvidence':opportunities,'sourceHistory':sorted(y for y,gs in history.items() if gs),'sourceHistoryCoverage':{'observedYears':sorted(history),'sourceObservedZeroYears':[y for y,gs in history.items() if not gs],'qualification':'calendar/team-side coverage; older source score/individual-GP limitations remain; not certified injury absence'},'regularGP':len(now),'preseasonGP':len(evidence.get('preseason',[])) if evidence else 0,'sourceConflict':conflict}
    return {'schemaVersion':1,'kind':'extended-model-scenarios','modelVersion':CONFIG['version'],'asOf':as_of,'computedAt':computed_at,'sourceDataThrough':source_cut,'standardGeneratedAt':standard['generatedAt'],'standardSources':standard['sources'],'projection':projection,'players':metadata,'parameters':CONFIG,'horizon':{'kind':'full-season' if source_cut is None else 'remaining-season','fromExclusive':as_of,'through':schedule['through']},'scientificGatesEnabled':False,'warnings':['Koşullu model senaryosu; ESPN sonucu veya doğrulanmış sezon toplamı değildir.','Kaynak tarihi ile hesaplama tarihi ayrıdır. Eksik veriler sıfıra dönüştürülmez.']}


def main():
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--roles',required=True);p.add_argument('--standard',default='public/data/player-projections.json');p.add_argument('--schedule',default='public/data/analysis-schedule.json');p.add_argument('--output',required=True);p.add_argument('--computed-at');p.add_argument('--as-of');p.add_argument('--catalog',default='public/data/fantasy-positions.json');p.add_argument('--team-periods');a=p.parse_args()
    root=Path(a.input_dir);standard=json.loads(Path(a.standard).read_text());schedule=json.loads(Path(a.schedule).read_text());as_of=a.as_of or standard['asOf'];roles=json.loads(Path(a.roles).read_text());histories=defaultdict(dict);current=defaultdict(list)
    archive=json.loads(gzip.decompress((ROOT/'scripts/scenario-history.json.gz').read_bytes()))
    for year in (2024,2025,2026):
        games=archive['games'][str(year)] if year in (2024,2025) else load_season(root,year)[0]
        for g in games:
            if g['date']<=as_of:histories[g['id']].setdefault(year,[]).append(g)
    for row in standard['players']:
        for year in (2024,2025,2026):histories[row['id']].setdefault(year,[])
    sched=(root/'nba_schedule_2027.parquet').read_bytes();current_path=root/'player_box_2027.parquet'
    raw=current_path.read_bytes() if current_path.exists() else None
    if raw is None and not before_regular_season(sched,2027,date.fromisoformat(as_of)):raise ValueError('Current source missing outside verified preseason')
    required={x['url'].rsplit('/',1)[-1]:x['sha256'] for x in standard['sources']}
    if raw is not None and hashlib.sha256(raw).hexdigest()!=required.get('player_box_2027.parquet') or hashlib.sha256(sched).hexdigest()!=required['nba_schedule_2027.parquet']:raise ValueError('Current source revision mismatch')
    index=schedule_index(sched,2027,date.fromisoformat(as_of))
    observed=any(v['excluded'] is None for v in index.values())
    if observed:
        for g in projection_games(raw,'2026-27',date.fromisoformat(as_of),index):current[g['id']].append(g)
    if not observed:
        from preseason_projection_snapshot import initial_snapshot
        all_index=schedule_index(sched,2027,date(2027,6,30));future=[{'id':gid,'date':v['date'],'teamIds':v['teams']} for gid,v in all_index.items() if v['excluded'] in (None,'unplayed') and v['date']>as_of]
        schedule={**schedule,'asOf':as_of,'games':future,'through':max(g['date'] for g in future)}
        if standard['asOf']!=as_of:standard=initial_snapshot(standard,json.loads(Path(a.catalog).read_text()),histories,schedule,as_of,a.computed_at or datetime.now(timezone.utc).isoformat())
    profiles=json.loads((ROOT/'scripts/rookie-profiles.json').read_text())['profiles'];artifacts=json.loads((ROOT/'scripts/scenario-model-artifacts.json').read_text());rookie=artifacts['rookie'];returning=artifacts['returning'];priors=artifacts['rookieAttendancePriors']
    result=build(standard,histories,current,schedule,roles,profiles,rookie,returning,priors,as_of,a.computed_at or datetime.now(timezone.utc).isoformat(),team_periods=json.loads(Path(a.team_periods).read_text()) if a.team_periods else None);result['rookieAttendancePriors']=priors
    result['inputRevision']={'roleEvidenceSHA256':hashlib.sha256(Path(a.roles).read_bytes()).hexdigest(),'standardSHA256':hashlib.sha256(Path(a.standard).read_bytes()).hexdigest(),'rookieParametersSHA256':hashlib.sha256((ROOT/'research/rookie-shadow/14.2-shadow-v1/parameters.json').read_bytes()).hexdigest(),'returningParametersVersion':returning['version'],'modelArtifactsSHA256':hashlib.sha256((ROOT/'scripts/scenario-model-artifacts.json').read_bytes()).hexdigest(),'scenarioConfigSHA256':hashlib.sha256((ROOT/'scripts/scenario-projection-config.json').read_bytes()).hexdigest(),'rookieProfilesSHA256':hashlib.sha256((ROOT/'scripts/rookie-profiles.json').read_bytes()).hexdigest(),'historySHA256':hashlib.sha256((ROOT/'scripts/scenario-history.json.gz').read_bytes()).hexdigest()}
    result['inputRevision'].update(opportunityModelSHA256=hashlib.sha256((ROOT/'scripts/attendance_opportunities.py').read_bytes()).hexdigest(),teamPeriodsSHA256=hashlib.sha256(Path(a.team_periods).read_bytes()).hexdigest() if a.team_periods else None)
    import subprocess
    with tempfile.TemporaryDirectory() as temporary:
        candidate=Path(temporary)/'scenario.json';atomic_write(result,candidate)
        subprocess.run(['node','--experimental-strip-types','scripts/rank_scenarios.ts',str(candidate)],cwd=ROOT,check=True)
        atomic_write(json.loads(candidate.read_text()),a.output)
    print('Scenario coverage',sum(r['status']=='available' for r in result['projection']['players']),'of',len(result['projection']['players']))

if __name__=='__main__':main()
