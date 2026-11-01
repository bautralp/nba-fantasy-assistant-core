"""Offline observational corpus. Never used by production refresh.

Unknown individual lines quarantine that player-season; missing team/game source
coverage quarantines the entire season for absence certification. No imputation.
"""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime
from zoneinfo import ZoneInfo
import gzip
import hashlib
import json
import math
from pathlib import Path
from parquet_io import read_parquet
from refresh_stats import FIELDS
from regular_season import schedule_index


def expected_calendar(year):
    if year == 2020: return (1059, 30, None)  # Bubble: franchises played 64-75 games.
    if year == 2021: return (1080, 30, 72)
    if year == 2012: return (990, 30, 66)
    return (1189, 29, 82) if year < 2005 else (1230, 30, 82)


def verified_scores(raw, year, gid, event):
    d=json.loads(raw);h=d['header'];c,=h['competitions']
    if str(h['id'])!=gid or h['season']['year']!=year or h['season']['type']!=2 or c['status']['type']['completed'] is not True:raise ValueError('Unverified score probe identity')
    day=datetime.fromisoformat(c['date'].replace('Z','+00:00')).astimezone(ZoneInfo('America/New_York')).date().isoformat()
    teams={int(t['id']):int(t['score']) for t in c['competitors']}
    if sorted(teams)!=event['teams'] or day!=event['date']:raise ValueError('Score probe team/date mismatch')
    return teams


def load_source(directory, year, probes=None):
    paths=[Path(directory)/f'{stem}_{year}.parquet' for stem in ('player_box','nba_schedule')]
    box, sched = [p.read_bytes() for p in paths]
    end=date(year,10,31) if year==2020 else date(year,6,30)
    index=schedule_index(sched,year,end,historical_exhibitions=True)
    events={k:v for k,v in index.items() if v['excluded'] is None}
    counts=Counter(t for e in events.values() for t in e['teams'])
    expected,teams,perteam=expected_calendar(year)
    calendar_ok=len(events)==expected and len(counts)==teams and (set(counts.values())=={perteam} if perteam else min(counts.values(),default=0)>=64 and max(counts.values(),default=99)<=75)
    scores={str(r['game_id']):{int(r['home_id']):r['home_score'],int(r['away_id']):r['away_score']} for r in read_parquet(sched).to_pylist() if str(r['game_id']) in events}
    games={};unknown=set();seen_pairs=set();score_totals=defaultdict(float);seen_lines=set(); reasons=Counter();unidentified=0
    for r in read_parquet(box).to_pylist():
        if int(r['season'])!=year: raise ValueError('Source season mismatch')
        if r['season_type']!=2:continue
        stop=date(year,11,1) if year==2020 else date(year,7,1)
        if not date(year-1,7,1)<=r['game_date']<stop:raise ValueError('Game date outside historical season')
        gid=str(r['game_id']);event=events.get(gid)
        if not event:
            if gid in index:continue
            raise ValueError('Regular box missing schedule')
        pid=str(r['athlete_id']);team=int(r['team_id']);key=(pid,gid)
        if not pid.isdigit():unidentified+=1
        if r['game_date'].isoformat()!=event['date'] or sorted([team,int(r['opponent_team_id'])])!=event['teams']:raise ValueError('Date/team mismatch')
        if key in seen_lines:raise ValueError('Duplicate player/game identity')
        seen_lines.add(key);seen_pairs.add((gid,team))
        if r['did_not_play'] is True:continue
        if r['did_not_play'] is not False:raise ValueError('Unknown DNP flag')
        pts=r['points']
        if pts is not None and math.isfinite(pts):score_totals[(gid,team)]+=pts
        numeric=[r.get(f) for f in [*FIELDS.values(),'minutes','three_point_field_goals_attempted']]
        if any(x is None or not math.isfinite(x) or x<0 for x in numeric):
            unknown.add(pid);reasons['unknownIndividualLine']+=1;continue
        stats={k:int(r[f]) for k,f in FIELDS.items()};stats['3PA']=int(r['three_point_field_goals_attempted'])
        if any(r[f]!=int(r[f]) for f in FIELDS.values()) or r['three_point_field_goals_attempted']!=stats['3PA'] or not stats['3PM']<=stats['3PA']<=stats['FGA'] or stats['FGM']-stats['3PM']>stats['FGA']-stats['3PA'] or stats['FGM']>stats['FGA'] or stats['FTM']>stats['FTA'] or stats['3PM']>stats['FGM'] or stats['PTS']!=2*stats['FGM']+stats['3PM']+stats['FTM']:raise ValueError('Invalid shooting/count line')
        if not pid.isdigit() or not r['athlete_display_name']:raise ValueError('Unknown identity')
        games[key]={'id':pid,'name':r['athlete_display_name'],'date':event['date'],'gameId':gid,'teamId':team,'team':r['team_abbreviation'],'position':r['athlete_position_abbreviation'],'minutes':r['minutes'],'starter':r.get('starter'),'stats':stats,'teamShotShare':None}
    missing={(g,t) for g,e in events.items() for t in e['teams']}-seen_pairs
    bad_scores=[(g,t) for g,e in events.items() for t in e['teams'] if scores[g][t] is None or score_totals[(g,t)]!=scores[g][t]]
    reconciled=[]
    for gid in sorted({g for g,t in bad_scores}):
        path=Path(probes)/(gid+'.json') if probes else None
        if path and path.exists():
            raw=path.read_bytes()
            try: definitive=verified_scores(raw,year,gid,events[gid])
            except (ValueError,KeyError,TypeError):continue
            if all(score_totals[(gid,t)]==definitive[t] for t in events[gid]['teams']):
                reconciled.append({'gameId':gid,'rawSHA256':hashlib.sha256(raw).hexdigest(),'url':'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event='+gid,'scheduleScores':scores[gid],'independentHeaderScores':definitive,'boxScores':{t:score_totals[(gid,t)] for t in events[gid]['teams']}})
    unresolved=[(g,t) for g,t in bad_scores if g not in {v['gameId'] for v in reconciled}]
    complete=calendar_ok and not missing and not unresolved and not unidentified
    report={'year':year,'sources':[{'file':p.name,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'url':f'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/{release}/{p.name}'} for p,b,release in zip(paths,[box,sched],['espn_nba_player_boxscores','espn_nba_schedules'])],'calendarGames':len(events),'teamGames':dict(sorted(counts.items())),'expectedCalendarGames':expected,'calendarComplete':calendar_ok,'missingTeamSides':len(missing),'scoreMismatches':len(bad_scores),'scoreMismatchDetails':[{'gameId':g,'teamId':t,'schedulePoints':scores[g][t],'boxPoints':score_totals[(g,t)]} for g,t in bad_scores],'unidentifiedLines':unidentified,'unknownPlayerSeasons':len(unknown),'unknownLineReasons':dict(reasons),'scoreReconciliations':reconciled,'unresolvedScoreGames':sorted({g for g,t in unresolved}),'absenceCertified':complete,'firstDate':min((e['date'] for e in events.values()),default=None),'lastDate':max((e['date'] for e in events.values()),default=None)}
    return sorted(games.values(),key=lambda g:(g['date'],g['gameId'],g['id'])),events,unknown,report


def build(directory,probes=None):
    data={};manifest=[]
    for year in range(2002,2027):
        try:
            games,index,unknown,r=load_source(directory,year,probes)
            data[year]=(games,index,unknown,r);manifest.append(r)
        except (ValueError,KeyError,FileNotFoundError,TypeError) as e:manifest.append({'year':year,'absenceCertified':False,'error':str(e)})
    # Keep actual appearances, including partial historical seasons, for all eligible
    # identities. Source manifests retain rejected years; never manufacture 0 GP.
    groups={y:defaultdict(list) for y in data}
    for y,(games,_,_,_) in data.items():
        for g in games:groups[y][g['id']].append(g)
    eligible=set();episodes=[]
    for year in range(2005,2027):
        if year not in data or not data[year][3]['absenceCertified']:continue
        for pid,current in groups[year].items():
            if pid in data[year][2]:continue
            anchors=[y for y in range(max(2002,year-8),year-1) if y in data and data[y][3]['absenceCertified'] and pid not in data[y][2] and len(groups[y].get(pid,[]))>=20 and sum(g['minutes'] for g in groups[y][pid])>=500]
            if not anchors:continue
            anchor=max(anchors)
            if any(y not in data or not data[y][3]['absenceCertified'] or pid in data[y][2] for y in range(anchor,year)):continue
            if groups[year-1].get(pid):continue
            eligible.add(pid);episodes.append({'id':pid,'year':year,'anchorYear':anchor,'gap':sum(not groups[y].get(pid) for y in range(anchor+1,year))})
    # Explicit continuous-veteran control cohort, deterministic IDs, not returners.
    controls=[];control_ids=set()
    for year in range(2005,2027):
        if not all(y in data and data[y][3]['absenceCertified'] for y in (year-2,year-1,year)):continue
        pids=[pid for pid in sorted(groups[year]) if pid not in control_ids and all(pid not in data[y][2] and len(groups[y].get(pid,[]))>=20 and sum(g['minutes'] for g in groups[y][pid])>=500 for y in (year-2,year-1,year))]
        for pid in pids[:20]:controls.append({'id':pid,'year':year});eligible.add(pid);control_ids.add(pid)
    # Preserve current target histories generically: all IDs missing in 2026 with
    # significant 2025 history. Cases are consumers of this cohort, not its rule.
    for pid,gs in groups.get(2025,{}).items():
        if len(gs)>=20 and sum(g['minutes'] for g in gs)>=500 and not groups.get(2026,{}).get(pid):eligible.add(pid)
    return {'version':'returning-observations-v2','manifest':manifest,'episodes':episodes,'controls':controls,'seasons':{str(y):{'schedule':v[1],'unknownPlayers':sorted(v[2]),'games':[g for g in v[0] if g['id'] in eligible]} for y,v in data.items()}}


def write_gzip(path,value):
    Path(path).write_bytes(gzip.compress((json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n').encode(),mtime=0))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);p.add_argument('--score-probes');a=p.parse_args()
    c=build(a.input_dir,a.score_probes);write_gzip(a.output,c)
    print(json.dumps({'episodes':len(c['episodes']),'players':len({e['id'] for e in c['episodes']}),'sources':[{k:v for k,v in r.items() if k not in ('sources','teamGames')} for r in c['manifest']]},indent=2))
