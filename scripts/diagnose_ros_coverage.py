from migration_baselines import read_historical
"""Pinned baseline diagnosis; no model parameters or production data are written."""
import sys,json,hashlib
from pathlib import Path
from datetime import date
from collections import Counter
sys.path.insert(0,str(Path(__file__).resolve().parent))
import argparse, subprocess, re
parser=argparse.ArgumentParser();parser.add_argument('--input-dir',required=True);parser.add_argument('--output',required=True);parser.add_argument('--baseline-ref',default='16c88abfb9fee2e93040acd29aaa96cf5b82f5ab');args=parser.parse_args()
if not re.fullmatch('[a-f0-9]{40}',args.baseline_ref):raise ValueError('Pinned full commit SHA required')
def pinned(path):return json.loads(read_historical(args.baseline_ref, path))
from parquet_io import read_parquet
from ros_model import projection_games
CONFIG=pinned('scripts/projection-config.json')
from regular_season import schedule_index,coverage
from refresh_stats import SEASONS
ids='4396993 6606 5142620 5175737 5254165 5041935 5041955 5095151 2991230 6442 4397140'.split()
ros=pinned('public/data/player-projections.json'); profiles=pinned('scripts/rookie-profiles.json')['profiles']; catalog={p['playerId']:p for p in pinned('public/data/fantasy-positions.json')['players']}
rows=[];sources=[]
for year in [2025,2026,2027]:
 p=Path(args.input_dir)/f'player_box_{year}.parquet';s=p.with_name(f'nba_schedule_{year}.parquet')
 if not p.exists() or not s.exists():continue
 b=p.read_bytes();sb=s.read_bytes();table=read_parquet(b);season=f'{year-1}-{str(year)[2:]}';SEASONS[season]=year
 index=schedule_index(sb,year,date(2026,10,25));games=projection_games(b,season,date(2026,10,25),index)
 try:cov=coverage(games,index,year,date(2026,10,25))
 except ValueError as e:cov={'error':str(e),'modelGames':len({g['gameId'] for g in games})}
 sources.append({'year':year,'boxSHA':hashlib.sha256(b).hexdigest(),'scheduleSHA':hashlib.sha256(sb).hexdigest(),'coverage':cov,'maxDate':max(g['date'] for g in games)})
 raw=table.to_pylist()
 for pid in ids:
  rawp=[r for r in raw if str(r['athlete_id'])==pid and r['season_type']==2 and r.get('did_not_play') is False and r.get('minutes') is not None]
  model=[g for g in games if g['id']==pid]
  rows.append({'id':pid,'year':year,'rawGP':len({r['game_id'] for r in rawp}),'rawMinutes':sum(r['minutes'] for r in rawp),'parsedGP':len(model),'parsedMinutes':sum(g['minutes'] for g in model),'modelUsesSeason':year in [2026,2027],'excludedGameIds':sorted(set(str(r['game_id']) for r in rawp)-{g['gameId'] for g in model})})
players=[]
for pid in ids:
 p=next(p for p in ros['players'] if p['id']==pid);profile=profiles.get(pid,{})
 players.append({'id':pid,'name':p['name'],'class':p['experience'],'identityVerified':profile.get('identityVerified'),'careerSeasons':profile.get('seasons'),'nbaHistory':profile.get('nbaHistory'),'draftIdentity':profile.get('draftIdentity'),'historyCoverage':profile.get('historyCoverage'),'nbaEntryVerified':profile.get('nbaEntryVerified'),'currentProTeamId':catalog.get(pid,{}).get('proTeamId'),'catalogRetrievedAt':catalog.get(pid,{}).get('retrievedAt'),'teamId':p.get('teamId'),'rosGP':p['rosGP'],'teamRemaining':p['teamRemaining'],'status':p['status'],'reason':p['reason'],'sourceSamples':[r for r in rows if r['id']==pid],'modelPrevious':{k:p['role']['previous'][k] for k in ['gp','minutes']},'modelCurrent':{k:p['role']['current'][k] for k in ['gp','minutes']}})
out={'baselineCommit':args.baseline_ref,'parametersUnmodified':True,'thresholds':{k:CONFIG[k] for k in ['minimumGames','minimumMinutes','availability']},'sources':sources,'players':players}
Path(args.output).write_text(json.dumps(out,indent=2)+'\n')
for p in players:print(p['id'],p['name'],p['class'],'history',[(s['year'],s['parsedGP'],s['parsedMinutes']) for s in p['sourceSamples']],'model',p['modelPrevious'],p['modelCurrent'],'team',p['currentProTeamId'],p['teamId'],'GP',p['rosGP'],p['reason'])
print('SOURCES',sources)
