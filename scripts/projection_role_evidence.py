"""Dated, exact-ID observational role inputs. Never consumes news/projections."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo
from refresh_stats import atomic_write

BASE='https://site.api.espn.com/apis/site/v2/sports/basketball/nba'


def build(directory, observed_at):
    root=Path(directory);players={};sources=[];warnings=[]
    def read(name,url):
        raw=(root/name).read_bytes();d=json.loads(raw)
        sources.append({'url':url,'sha256':hashlib.sha256(raw).hexdigest(),'observedAt':observed_at})
        return d
    for team in range(1,31):
        try:
            roster=read(f'roster-{team}.json',f'{BASE}/teams/{team}/roster')
            if int(roster['team']['id'])!=team or roster['season']['year']!=2027:raise ValueError('Roster team/season mismatch')
            for p in roster['athletes']:
                pid=str(p['id'])
                if not pid.isdigit() or p['uid']!='s:40~l:46~a:'+pid or pid in players:raise ValueError('Roster identity/duplicate mismatch')
                injuries=p.get('injuries',[])
                players[pid]={'espnId':pid,'nbaTeamId':team,'status':'injured' if injuries else 'active','injuryStatus':injuries[0].get('status') if injuries else None,'depthRanks':[], 'competitionIds':[], 'minuteRestriction':None,'observedAt':observed_at,'validUntil':(datetime.fromisoformat(observed_at.replace('Z','+00:00')).date()).isoformat(),'sources':[sources[-1]],'preseason':[],'confidence':'observed-roster'}
            path=root/f'depth-{team}.json'
            if not path.exists():continue
            depth=read(path.name,f'{BASE}/teams/{team}/depthcharts')
            if int(depth['team']['id'])!=team or depth['season']['year']!=2027:raise ValueError('Depth team/season mismatch')
            for chart in depth.get('depthchart',[]):
                for position,slot in chart.get('positions',{}).items():
                    ids=[str(a['id']) for a in slot['athletes']]
                    for rank,pid in enumerate(ids,1):
                        p=players.get(pid)
                        if p and p['nbaTeamId']==team:
                            p['depthRanks'].append({'position':position,'rank':rank})
                            p['competitionIds']=sorted(set(p['competitionIds'])|set(ids)-{pid})
                            p['sources'].append(sources[-1]);p['confidence']='provider-depth-estimate'
        except (FileNotFoundError,KeyError,ValueError) as e:warnings.append(f'team {team}: {e}')
    for path in sorted(root.glob('preseason-summary-*.json')):
        d=read(path.name,f"{BASE}/summary?event={path.stem.rsplit('-',1)[1]}");h=d['header'];c,=h['competitions'];gid=str(h['id'])
        if h['season']['year']!=2027 or h['season']['type']!=1 or c['status']['type']['completed'] is not True:raise ValueError('Preseason identity/type/status mismatch')
        day=datetime.fromisoformat(c['date'].replace('Z','+00:00')).astimezone(ZoneInfo('America/New_York')).date().isoformat()
        teams={int(x['id']) for x in c['competitors']}
        if len(teams)!=2 or not all(1<=t<=30 for t in teams):continue
        for side in d.get('boxscore',{}).get('players',[]):
            team=int(side['team']['id'])
            if team not in teams:raise ValueError('Preseason team mismatch')
            for group in side['statistics']:
                for a in group['athletes']:
                    pid=str(a['athlete'].get('id',''));p=players.get(pid);s=dict(zip(group['labels'],a.get('stats',[])))
                    if not p or p['nbaTeamId']!=team or a.get('didNotPlay') is True or s.get('MIN') in (None,'','--'):continue
                    minutes=float(s['MIN'])
                    if not 0<=minutes<=60:raise ValueError('Invalid preseason minutes')
                    p['preseason'].append({'gameId':gid,'date':day,'seasonType':1,'teamId':team,'minutes':minutes,'starter':a.get('starter') if isinstance(a.get('starter'),bool) else None,'source':sources[-1]})
    for p in players.values():
        p['preseason'].sort(key=lambda x:(x['date'],x['gameId']))
        p['sources']=list({x['url']:x for x in p['sources']}.values())
    return {'schemaVersion':1,'kind':'observed-role-evidence','observedAt':observed_at,'seasonId':2027,'sources':sources,'warnings':warnings,'players':players}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--observed-at',required=True);p.add_argument('--output',required=True);a=p.parse_args();atomic_write(build(a.input_dir,a.observed_at),a.output)
