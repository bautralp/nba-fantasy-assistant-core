"""Offline revision acquisition. Publishes no forecasts and never changes player IDs/eligibility."""
import argparse
from collections import Counter,defaultdict
from copy import deepcopy
from datetime import date,datetime,timezone
import csv
import io
import json
from pathlib import Path
import re
from concurrent.futures import ThreadPoolExecutor
from parquet_io import read_parquet
from regular_season import schedule_index,NBA_TEAMS
from refresh_stats import atomic_write,FIELDS
from rookie_http import SourceClient,SourceError,atomic_bytes
from acquire_rookie_sources import fetch_profile,needs_retry
from rookie_identity import nba_id_from_draft,verify_current_draft,merge_draft_evidence,normalized
from rookie_model import classify
from rookie_selection import POLICY, select_season

BASE='https://github.com/sportsdataverse/sportsdataverse-data/releases/download/'
# Stable NBA franchise abbreviations -> ESPN NBA team IDs, not player names.
ESPN_TEAMS={'ATL':1,'BOS':2,'NOP':3,'NOH':3,'CHI':4,'CLE':5,'DAL':6,'DEN':7,'DET':8,'GSW':9,'HOU':10,'IND':11,'LAC':12,'LAL':13,'MIA':14,'MIL':15,'MIN':16,'BKN':17,'NJN':17,'NYK':18,'ORL':19,'PHI':20,'PHX':21,'PHO':21,'POR':22,'SAC':23,'SAS':24,'OKC':25,'SEA':25,'UTA':26,'WAS':27,'TOR':28,'MEM':29,'CHA':30,'CHO':30}

class CoverageGap(ValueError):
    def __init__(self,games,rejected,detail):
        self.games,self.rejected,self.detail=games,rejected,detail
        super().__init__(json.dumps(detail))

def is_nba_appearance(row):
    # Rising Stars/G League and All-Star rosters also occur in season_type=2.
    return (int(row['season_type'])==2 and not row['did_not_play'] and bool(row.get('minutes')) and row['minutes']>0
        and row.get('team_id') in NBA_TEAMS and row.get('opponent_team_id') in NBA_TEAMS
        and row['team_id']!=row['opponent_team_id'] and str(row['athlete_id']).isdigit())

class Archive:
    def __init__(self,cache,client):self.cache=cache;self.client=client;self.sources=[]
    def read(self,key,url,kind='parquet'):
        path=self.cache/key
        try:
            if not path.exists():atomic_bytes(path,self.client.get(url))
            raw=path.read_bytes()
            import hashlib
            if kind=='csv':
                records=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))));columns=list(records[0]) if records else []
            elif kind=='json':records=json.loads(raw);columns=list(records) if isinstance(records,dict) else []
            else:
                table=read_parquet(raw);columns=table.column_names;records=table.to_pylist()
            self.sources.append({'key':key,'url':url,'status':'success','sha256':hashlib.sha256(raw).hexdigest(),'retrievedAt':datetime.fromtimestamp(path.stat().st_mtime,timezone.utc).isoformat(),'columns':columns,'records':len(records)})
            return records,raw
        except Exception as error:
            self.sources.append({'key':key,'url':url,'status':'unavailable','error':error.record() if isinstance(error,SourceError) else str(error)})
            return None,None

def nba_games(rows,index,year):
    by_id=defaultdict(list);ids=set();pairs=set();rejected=Counter();unusable=set()
    for r in rows or []:
        if int(r['season'])!=year:raise ValueError('Historical box season mismatch')
        if int(r['season_type'])!=2:continue
        key=str(r['game_id']);event=index.get(key)
        if event is None:raise ValueError('Historical box missing schedule game')
        if event['excluded']:continue
        if r['game_date'].isoformat()!=event['date']:raise ValueError('Historical box/schedule date mismatch')
        if int(r['team_id']) not in event['teams'] or int(r['opponent_team_id']) not in event['teams']:raise ValueError('Historical box/schedule team mismatch')
        ids.add(key);pairs.add((key,int(r['team_id'])))
        if r['did_not_play'] or r['minutes'] is None or r['minutes']<=0:continue
        stats={k:r.get(v) for k,v in FIELDS.items()};stats['3PA']=r.get('three_point_field_goals_attempted')
        if any(v is None or v<0 for v in stats.values()):
            rejected['missing-stat']+=1;unusable.add(str(r['athlete_id']));continue
        if stats['3PM']>stats['FGM'] or stats['FGM']>stats['FGA'] or stats['FTM']>stats['FTA'] or stats['3PM']>stats['3PA'] or stats['3PA']>stats['FGA'] or stats['FGM']-stats['3PM']>stats['FGA']-stats['3PA'] or abs(stats['PTS']-(2*stats['FGM']+stats['3PM']+stats['FTM']))>1e-8:
            rejected['inconsistent-shots']+=1;unusable.add(str(r['athlete_id']));continue
        by_id[str(r['athlete_id'])].append({'id':str(r['athlete_id']),'gameId':key,'date':event['date'],'teamId':int(r['team_id']),
            'minutes':float(r['minutes']),'starter':r.get('starter'),'stats':stats})
    expected={k for k,v in index.items() if v['excluded'] is None}
    expected_pairs={(k,t) for k in expected for t in index[k]['teams']}
    for games in by_id.values():games.sort(key=lambda g:(g['date'],g['gameId']))
    rejected={**dict(rejected),'unusablePlayerIds':sorted(unusable)}
    if ids!=expected or pairs!=expected_pairs:
        missing=expected_pairs-pairs
        affected={team for key,_ in missing for team in index[key]['teams']}
        detail={'year':year,'expectedGames':len(expected),'observedGames':len(ids),'missingGames':sorted(expected-ids),'extraGames':sorted(ids-expected),'missingTeamSides':sorted(missing),'extraTeamSides':sorted(pairs-expected_pairs),'affectedTeams':sorted(affected)}
        if ids-expected or pairs-expected_pairs:raise ValueError(json.dumps(detail))
        raise CoverageGap(by_id,rejected,detail)
    return by_id,rejected

def main():
    p=argparse.ArgumentParser();p.add_argument('--cache-dir',type=Path,default=Path('.research-cache'));p.add_argument('--output-dir',type=Path,default=Path('artifacts/rookie-individual-revision'))
    a=p.parse_args();a.cache_dir.mkdir(exist_ok=True);a.output_dir.mkdir(parents=True,exist_ok=True)
    client=SourceClient(a.cache_dir/'responses',attempts=2,budget=2200,interval=1.0);archive=Archive(a.cache_dir,client)
    original=json.loads(Path('scripts/rookie-profiles.json').read_text());profiles=deepcopy(original['profiles'])
    old503={pid for pid,v in profiles.items() if '503' in v.get('error','')}
    catalog=json.loads(Path('public/data/fantasy-positions.json').read_text())
    # Parsed eligibility records omit the raw active flag. Measure it separately
    # without replacing either the Fantasy catalog or the frozen projection pool.
    fantasy_activity={'status':'unavailable'}
    try:
        from fantasy_positions import fetch_api,URL
        activity_path=a.cache_dir/'fantasy-activity.json'
        if activity_path.exists():activity=json.loads(activity_path.read_text())
        else:
            payload,digest=fetch_api()
            activity={'source':URL+'kona_player_info','sha256':digest,'retrievedAt':datetime.now(timezone.utc).isoformat(),'players':payload}
            atomic_write(activity,activity_path)
        flags=Counter();active_ids=[]
        for item in activity['players']:
            player=item.get('player',item);flag=player.get('active')
            flags['true' if flag is True else 'false' if flag is False else 'unspecified']+=1
            if flag is True:active_ids.append(str(player['id']))
        snapshot_ids={r['id'] for r in json.loads(Path('public/data/player-projections.json').read_text())['players']}
        fantasy_activity={k:v for k,v in activity.items() if k!='players'}
        fantasy_activity.update(status='success',rawRecords=len(activity['players']),activeFlags=dict(flags),activeTrueInSnapshot=sum(pid in snapshot_ids for pid in active_ids),activeTrueOutsideSnapshot=[pid for pid in active_ids if pid not in snapshot_ids])
    except Exception as error:fantasy_activity['error']=str(error)
    official=json.loads(Path('scripts/rookie-official-draft-2026.json').read_text())
    espn,_=archive.read('espn-draft-2026.json','https://site.api.espn.com/apis/site/v2/sports/basketball/nba/draft?season=2026','json')
    if espn is None:raise ValueError('Current draft ID source unavailable; no inferred joins')
    selections=verify_current_draft(official,espn,catalog)
    # Roster evidence is independent of the failing common athlete/career endpoint.
    current_roster={}
    for team in range(1,31):
        response,_=archive.read(f'live-roster-{team}.json',f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/roster','json')
        for player in (response or {}).get('athletes',[]):
            pid=str(player['id'])
            if player.get('uid')!='s:40~l:46~a:'+pid:continue
            current_roster[pid]={'teamId':team,'experienceYears':player.get('experience',{}).get('years'),'dateOfBirth':player.get('dateOfBirth'),'uid':player['uid'],'source':f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/roster'}
    nba={};schedules={};core={};drafts={};source_failures=[];history=defaultdict(dict);draft_coverage={};cohort_rejected=[];partial={};unusable={}
    # Earlier boxscores establish prior NBA experience; no name-based debut inference.
    for year in range(2002,2028):
        rows,_=archive.read(f'nba-{year}',BASE+f'espn_nba_player_boxscores/player_box_{year}.parquet')
        if rows is None:source_failures.append({'year':year,'component':'box'});continue
        seen=set()
        for row in rows:
            key=(str(row['athlete_id']),str(row['game_id']))
            if is_nba_appearance(row) and key not in seen:
                seen.add(key);pid=key[0];history[pid][str(year)]=history[pid].get(str(year),0)+1
        if year not in [*range(2013,2023),2027]:continue
        _,raw=archive.read(f'nba_schedule_{year}.parquet',BASE+f'espn_nba_schedules/nba_schedule_{year}.parquet')
        if raw is None:source_failures.append({'year':year,'component':'schedule'});continue
        # COVID 2020 extends beyond June; source season and event IDs determine membership.
        try:
            index=schedule_index(raw,year,min(date.today(),date(year,12,31)),historical_exhibitions=True);schedules[year]=index
            nba[year],rejected=nba_games(rows,index,year)
        except CoverageGap as error:
            # Keep league gaps visible. Research admissibility is determined by
            # each player's verified GP, not observed or original draft teams.
            # This changes the method; it does not waive production validation.
            nba[year],rejected=error.games,error.rejected;partial[year]=error.detail
            failure={'year':year,'component':'reconciliation','detail':str(error),'researchOnlyPartialUse':True}
            source_failures.append(failure)
            print('SOURCE_RECONCILIATION_FAILURE '+json.dumps(failure),flush=True)
        except ValueError as error:
            failure={'year':year,'component':'reconciliation','detail':str(error)}
            source_failures.append(failure)
            print('SOURCE_RECONCILIATION_FAILURE '+json.dumps(failure),flush=True)
            atomic_write(source_failures,a.output_dir/'source-failures.json')
            continue
        unusable[year]=set(rejected.get('unusablePlayerIds',[]))
        archive.sources[-1]['rejectedBoxRows']=rejected
        if year==2027:continue
        c,_=archive.read(f'core-{year}.csv',BASE+f'espn_nba_player_core/player_core_{year}.csv','csv')
        core[year]={str(r['athlete_id']):r for r in c or [] if r.get('uid')=='s:40~l:46~a:'+str(r['athlete_id'])}
        d,_=archive.read(f'espn-draft-{year-1}.json',f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/draft?season={year-1}','json')
        official_d,_=archive.read(f'draft-{year}.csv',BASE+f'nba_stats_draft/draft_{year}.csv','csv')
        official_by_pick={int(r['overall_pick']):r for r in official_d or []}
        mapped=[]
        for pick in (d or {}).get('picks',[]):
            try:
                pid=nba_id_from_draft(pick['athlete']);o=official_by_pick[int(pick['overall'])]
                if normalized(pick['athlete']['displayName'])!=normalized(o['player_name']):continue
                mapped.append({'id':pid,'pick':int(pick['overall']),'round':int(pick['round']),'draftYear':year-1,'teamId':int(pick['teamId']),'name':o['player_name'],'organization':o.get('organization'),'organizationType':o.get('organization_type'),'nbaId':o['person_id'],'verified':True})
            except (KeyError,TypeError,ValueError):continue
        # Older ESPN draft responses sometimes omit modern proLink fields. Core
        # metadata supplies an independent native UID + exact draft year/slot;
        # official NBA draft record remains the other side of this join.
        seen_ids={r['id'] for r in mapped};seen_slots={r['pick'] for r in mapped}
        for pid,c in core[year].items():
            try:
                if int(float(c['draft_year']))!=year-1:continue
                slot=int(float(c['draft_selection']));o=official_by_pick[slot]
                if pid in seen_ids or slot in seen_slots:continue
                if normalized(c['full_name'])!=normalized(o['player_name']):continue
                if int(float(c['draft_round']))!=int(o['round_number']):continue
                mapped.append({'id':pid,'pick':slot,'round':int(o['round_number']),'draftYear':year-1,
                    'teamId':ESPN_TEAMS.get(o.get('team_abbreviation')),'name':o['player_name'],'organization':o.get('organization'),
                    'organizationType':o.get('organization_type'),'nbaId':o['person_id'],
                    'verified':True,'identityBasis':'NBA-official-slot-plus-ESPN-core-UID-draft-year-round-selection'})
                seen_ids.add(pid);seen_slots.add(slot)
            except (KeyError,TypeError,ValueError):continue
        drafts[year]=mapped
        draft_coverage[str(year)]={'officialSelections':len(official_by_pick),'verifiedNBAIDs':len(mapped),
            'unresolvedSelections':[{'overall':slot,'name':o['player_name'],'reason':'No verified explicit NBA ID/draft slot match'} for slot,o in official_by_pick.items() if slot not in {r['pick'] for r in mapped}]}
        print('HISTORICAL_ID_DIAGNOSTIC '+json.dumps({'year':year,'coreRows':len(core[year]),'espnDraftYear':(d or {}).get('year'),'espnDraftPicks':len((d or {}).get('picks',[])),'officialDraftRows':len(official_by_pick),'coreSample':next(iter(core[year].values()),None),'draftSample':next(iter((d or {}).get('picks',[])),None)}),flush=True)
        print('COLLECT_SEASON '+json.dumps({'year':year,'draftIdentities':len(mapped),'playedPlayers':len(nba[year])}),flush=True)
    # Build candidates from positively verified draft identities or explicit rookie core metadata.
    cohorts=defaultdict(list);needed=set(old503);needed.update(r['playerId'] for r in selections if r['verified'])
    for year,games_by_id in nba.items():
        if year==2027:continue
        mapped={r['id']:r for r in drafts.get(year,[])}
        # Core experience_years/age are retrospective, not season snapshots.
        # Debut candidates require checked earlier boxscores and career-start
        # confirmation below; never use present-day rookie labels as historical truth.
        candidates=set(mapped)|set(games_by_id)
        for pid in sorted(candidates):
            prior=[int(y) for y,gp in history[pid].items() if int(y)<year and gp>0]
            if prior:continue  # Drafted earlier, returning veterans and false rookie labels are not debut cohorts.
            c=core.get(year,{}).get(pid,{})
            # Drafted but never appeared players remain in the availability population.
            profile=profiles.get(pid,{})
            cohorts[year].append({'id':pid,'draft':mapped.get(pid),'core':c,'games':games_by_id.get(pid,[]),'identityBasis':'draft-slot-explicit-ID' if pid in mapped else 'pending-career-start'})
            needed.add(pid)
    profile_cache=a.cache_dir/'profiles';profile_cache.mkdir(exist_ok=True)
    def recover(pid):
        path=profile_cache/(pid+'.json');old=json.loads(path.read_text()) if path.exists() else profiles.get(pid)
        if old and not needs_retry(old):return pid,old
        row=fetch_profile(pid,client,old);atomic_write(row,path);return pid,row
    with ThreadPoolExecutor(max_workers=2) as executor:
        for index,(pid,row) in enumerate(executor.map(recover,sorted(needed))):
            profiles[pid]=row
            if index%50==0:print('COLLECT_PROGRESS '+json.dumps({'done':index+1,'total':len(needed),'requests':client.requests}),flush=True)
    for pid,profile in profiles.items():
        profile['nbaHistory']=history.get(pid,{})
        profile['historyCoverage']=list(range(2002,2027)) if not any(f['component']=='box' and f['year']<2027 for f in source_failures) else sorted(y for y in range(2002,2027) if not any(f['component']=='box' and f['year']==y for f in source_failures))
        if pid in current_roster:
            profile['nbaEntryVerified']=True;profile['currentRosterEvidence']=current_roster[pid]
    now=datetime.now(timezone.utc).isoformat()
    for selection in selections:
        if not selection['verified']:continue
        pid=selection['playerId'];entry=pid in current_roster or pid in nba.get(2027,{})
        profiles[pid]=merge_draft_evidence(profiles.get(pid),selection,official['source'],now,entry)
        selection['nbaEntryVerified']=entry
    # NCAA profiles are joined ONLY through a verified NBA collegeAthlete.id pointer.
    from calibrate_rookies import read_games,ncaa_profile
    college={}
    college_ids={str((profile.get('collegeAthlete') or {}).get('id')) for profile in profiles.values() if profile.get('identityVerified') and (profile.get('collegeAthlete') or {}).get('id')}
    for year in [*range(2012,2022),2026]:
        _,raw=archive.read(f'ncaa-{year}',BASE+f'espn_mens_college_basketball_player_boxscores/player_box_{year}.parquet')
        if raw is not None:
            parsed=read_games(a.cache_dir/f'ncaa-{year}',year,True)[0]
            college[year]={pid:games for pid,games in parsed.items() if pid in college_ids}
            del parsed
    for year,cohort in cohorts.items():
        verified=[]
        for row in cohort:
            profile=deepcopy(profiles.get(row['id'],{'id':row['id']}));draft=row['draft']
            decision=select_season(row['id'],year,profile,row['games'],draft,
                                   row['id'] in unusable.get(year,set()))
            if not decision['accepted']:
                cohort_rejected.append({'id':row['id'],'year':year,'reason':decision['reason'],'selectionProof':decision})
                continue
            row['selectionProof']=decision
            if not draft:row['identityBasis']='verified-career-start-plus-earlier-box-history'
            # Static draft and birth date only. Current NBA role/position never enters historical priors.
            profile['identityVerified']=True
            profile['displayDraft']=f"{year-1}: Rd {draft['round']}, Pk {draft['pick']}" if draft else profile.get('displayDraft')
            draft_metadata=re.match(r'(\d{4}): Rd (\d+), Pk (\d+)(?: \(([^)]+)\))?',profile.get('displayDraft') or '')
            if draft_metadata and int(draft_metadata[1])>=year:
                cohort_rejected.append({'id':row['id'],'year':year,'reason':'Draft metadata conflicts with NBA debut year'})
                continue
            if not draft and draft_metadata and draft_metadata[4] in ESPN_TEAMS:
                row['entryTeamId']=ESPN_TEAMS[draft_metadata[4]]
                row['entryTeamBasis']='Verified NBA athlete original draft team; pre-debut roster/trades unavailable'
            ncaa=None
            for college_year in sorted((y for y in college if y<year),reverse=True):
                ncaa=ncaa_profile(profile,college[college_year],f'{year-1}-07-01')
                if ncaa:break
            profile.pop('ncaa',None)
            if ncaa:profile['ncaa']=ncaa
            profile['priorPosition']=ncaa['position'] if ncaa else 'unknown'
            profile['preNBALeague']='NCAA' if ncaa or draft and draft.get('organizationType')=='College/University' else 'other-organization' if draft and draft.get('organization') else 'unknown'
            # Store only pre-debut features in the model corpus. Retrospective
            # career totals/experience/age/current team stay in the audit profile
            # artifact and cannot accidentally enter historical prediction.
            row['profile']={k:profile[k] for k in ('id','uid','identityVerified','displayDraft','collegeAthlete','ncaa','priorPosition','preNBALeague','source','sha256','careerSha256') if k in profile}
            row.pop('core',None)
            verified.append(row)
        cohorts[year]=verified
    # The same verified crosswalks also cover current veterans whose college
    # seasons predate the original five-year research window. These annotations
    # never change their NBA projection formula. Preserve a newer verified NCAA
    # record already present in the seed (e.g. 2022-25).
    for profile in profiles.values():
        if not profile.get('identityVerified'):continue
        starts=[s['year'] for s in profile.get('seasons',[]) if s.get('gp',0)>0] if profile.get('careerSchemaVerified') else []
        if starts:debut=min(starts)
        elif classify(profile,[],[]) in ('rookie','international-newcomer'):debut=2027
        else:continue
        latest=profile.get('ncaa')
        if latest and (latest['through']>=f'{debut-1}-07-01' or str(latest['id'])!=str((profile.get('collegeAthlete') or {}).get('id'))):latest=None
        for college_year in sorted((y for y in college if y<debut),reverse=True):
            candidate=ncaa_profile(profile,college[college_year],f'{debut-1}-07-01')
            if candidate and (latest is None or candidate['through']>latest['through']):latest=candidate
        if latest:profile['ncaa']=latest;profile['priorPosition']=latest['position']
    for selection in selections:
        if selection['verified']:
            pid=selection['playerId'];ncaa=ncaa_profile(profiles[pid],college.get(2026,{}),'2026-07-01')
            if ncaa:profiles[pid]['ncaa']=ncaa;profiles[pid]['priorPosition']=ncaa['position']
    identity_recovered=sum(bool(profiles[pid].get('identityVerified')) for pid in old503)
    fully_recovered=sum(not profiles[pid].get('error') and not profiles[pid].get('endpointErrors') for pid in old503)
    summary={'schemaVersion':1,'selectionPolicy':POLICY,'collectedAt':now,'old503':len(old503),'old503IdentityRecovered':identity_recovered,'old503FullyRecovered':fully_recovered,
        'remaining503':[pid for pid in sorted(old503) if profiles[pid].get('error') or profiles[pid].get('endpointErrors')],
        'fantasyCatalogSize':len(catalog['players']),'currentRosterVerified':len(current_roster),'fantasyActivity':fantasy_activity,
        'activeCountReason':'Raw Fantasy active=true/false/unspecified measured separately from parsed eligibility and roster membership.',
        'draftCoverage':{str(n):{'selected':n,'verified':sum(r['verified'] for r in selections[:n]),'inFantasyCatalog':sum(r['inFantasyCatalog'] for r in selections[:n]),'NBAEntryVerified':sum(r.get('nbaEntryVerified',False) for r in selections[:n])} for n in (14,30,60)},
        'sourceFailures':source_failures,'cohortCounts':{str(y):len(rows) for y,rows in cohorts.items()},
        'historicalDraftIdentityCoverage':draft_coverage,'historicalCandidatesRejected':cohort_rejected,
        'partialHistoricalSeasons':{str(y):v for y,v in partial.items()},
        'ncaaCohortCounts':{str(y):sum(bool(r['profile'].get('ncaa')) for r in rows) for y,rows in cohorts.items()},
        'httpKinds':dict(Counter(e['kind'] for e in client.events))}
    atomic_write({'schemaVersion':1,'profiles':profiles,'sourceHashes':original.get('sourceHashes',{})},a.output_dir/'rookie-profiles.json')
    atomic_write({'schemaVersion':1,'draftYear':2026,'source':official['source'],'selections':selections},a.output_dir/'rookie-draft-2026.json')
    atomic_write(summary,a.output_dir/'collection-summary.json')
    atomic_write(archive.sources,a.output_dir/'sources.json')
    atomic_write({'schemaVersion':1,'selectionPolicy':POLICY,'cohorts':dict(cohorts),'schedules':{str(y):v for y,v in schedules.items() if y<2027}},a.output_dir/'cohorts.json')
    atomic_write(client.events,a.output_dir/'http-events.json')
    print('COLLECTION_SUMMARY '+json.dumps(summary,separators=(',',':')),flush=True)

if __name__=='__main__':main()

