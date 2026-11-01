"""Offline acquisition: bounded retries, per-endpoint success cache, failed-only resume."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from parquet_io import read_parquet
from refresh_stats import atomic_write
from rookie_http import SourceClient, SourceError

BASE='https://github.com/sportsdataverse/sportsdataverse-data/releases/download/'
ATHLETE='https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/'

def download(url, client=None):
    return (client or SourceClient()).get(url)

def needs_retry(profile):
    return not profile or not profile.get('identityVerified') or not profile.get('careerSchemaVerified') or bool(profile.get('error') or profile.get('endpointErrors'))

def fetch_profile(pid, client=None, previous=None):
    client=client or SourceClient()
    url=ATHLETE+pid;out=dict(previous or {'id':pid});out['id']=pid
    if not pid.isdigit():
        out.update(error='Invalid ESPN athlete ID',missingReason='Invalid ESPN athlete ID',identityVerified=False,
                   endpointErrors={'athlete':{'kind':'invalid-id','detail':'Numeric ESPN athlete ID required'}})
        return out
    errors={}
    try:
        raw=client.get(url);a=json.loads(raw)['athlete']
        if str(a['id'])!=pid or a.get('uid')!='s:40~l:46~a:'+pid:
            raise ValueError('ESPN NBA identity mismatch')
        out.update({k:a.get(k) for k in ['id','displayName','uid','college','collegeAthlete','position','displayDOB','displayHeight','displayWeight','displayExperience','displayDraft']})
        out.update(identityVerified=True,source=url,retrievedAt=datetime.now(timezone.utc).isoformat(),sha256=hashlib.sha256(raw).hexdigest())
    except Exception as error:
        if isinstance(error,(ValueError,KeyError,TypeError)):client.invalidate(url,str(error))
        errors['athlete']=error.record() if isinstance(error,SourceError) else {'kind':'validation','detail':str(error)}
    # A failed career request must never erase a successful NBA identity or NCAA crosswalk.
    if out.get('identityVerified') or out.get('uid')=='s:40~l:46~a:'+pid:
        try:
            statraw=client.get(url+'/stats');s=json.loads(statraw)
            categories=[c for c in s.get('categories',[]) if c.get('name')=='averages' and 'gamesPlayed' in c.get('names',[])]
            if not categories:raise ValueError('ESPN NBA career averages schema not verified')
            seasons=[]
            for c in categories:
                for row in c.get('statistics',[]):
                    gp=float(row['stats'][c['names'].index('gamesPlayed')])
                    if gp>0:seasons.append({'year':row['season']['year'],'gp':int(gp),'position':row.get('position')})
            out.update(seasons=seasons,careerSchemaVerified=bool(categories),careerSha256=hashlib.sha256(statraw).hexdigest())
        except Exception as error:
            if isinstance(error,(ValueError,KeyError,TypeError)):client.invalidate(url+'/stats',str(error))
            errors['career']=error.record() if isinstance(error,SourceError) else {'kind':'validation','detail':str(error)}
    if errors:
        out['endpointErrors']=errors
        if not out.get('identityVerified'):out['error']=str(errors.get('athlete'))
        else:out.pop('error',None)
        out['missingReason']='; '.join(k+': '+v.get('kind','unknown') for k,v in errors.items())
    else:
        out.pop('endpointErrors',None);out.pop('error',None);out.pop('missingReason',None)
    return out

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache-dir',type=Path,required=True)
    p.add_argument('--catalog',type=Path,default=Path('public/data/fantasy-positions.json'))
    p.add_argument('--seed-profiles',type=Path,default=Path('scripts/rookie-profiles.json'))
    p.add_argument('--retry-errors',action='store_true')
    p.add_argument('--ids-file',type=Path)
    p.add_argument('--workers',type=int,choices=[1,2],default=2)
    p.add_argument('--request-budget',type=int,default=1800)
    p.add_argument('--ending-years',type=int,nargs='+',default=list(range(2023,2028)))
    a=p.parse_args();a.cache_dir.mkdir(parents=True,exist_ok=True)
    client=SourceClient(a.cache_dir/'responses',budget=a.request_budget)
    sources={}
    for y in a.ending_years:
        sources['nba-'+str(y)]=BASE+f'espn_nba_player_boxscores/player_box_{y}.parquet'
        sources[f'nba_schedule_{y}.parquet']=BASE+f'espn_nba_schedules/nba_schedule_{y}.parquet'
        sources['ncaa-'+str(y-1)]=BASE+f'espn_mens_college_basketball_player_boxscores/player_box_{y-1}.parquet'
    access=[]
    for key,url in sources.items():
        path=a.cache_dir/key
        try:
            if not path.exists():
                from rookie_http import atomic_bytes
                atomic_bytes(path,client.get(url))
            access.append({'key':key,'url':url,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'status':'success'})
        except Exception as error:access.append({'key':key,'url':url,'error':error.record() if isinstance(error,SourceError) else str(error)})
    atomic_write(access,a.cache_dir/'access.json')
    ids={str(r['playerId']) for r in json.loads(a.catalog.read_text())['players']}
    if a.ids_file:ids={str(x) for x in json.loads(a.ids_file.read_text())}
    else:
        for y in a.ending_years:
            path=a.cache_dir/('nba-'+str(y))
            if path.exists():ids.update(str(x) for x in read_parquet(path.read_bytes()).column('athlete_id').to_pylist())
    seed=json.loads(a.seed_profiles.read_text()).get('profiles',{}) if a.seed_profiles.exists() else {}
    cache=a.cache_dir/'profiles';cache.mkdir(exist_ok=True)
    def fetch(pid):
        path=cache/(pid+'.json')
        old=json.loads(path.read_text()) if path.exists() else seed.get(pid)
        if old and not (a.retry_errors and needs_retry(old)):return old
        row=fetch_profile(pid,client,old);atomic_write(row,path);return row
    with ThreadPoolExecutor(max_workers=a.workers) as executor:rows=list(executor.map(fetch,sorted(ids)))
    atomic_write(rows,a.cache_dir/'profiles.json')
    atomic_write(client.events,a.cache_dir/'http-events.json')
    print({'requested':len(rows),'failed':sum(needs_retry(r) for r in rows),'http':dict(Counter(e['kind'] for e in client.events))})

if __name__=='__main__':main()
