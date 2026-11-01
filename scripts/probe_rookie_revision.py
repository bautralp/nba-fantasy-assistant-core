"""Bounded public-source probe. No name joins and no production writes."""
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import pyarrow.parquet as pq

BASE='https://github.com/sportsdataverse/sportsdataverse-data/releases/download/'
SOURCES={
 'draft2027':BASE+'nba_stats_draft/draft_2027.csv',
 'draft2019':BASE+'nba_stats_draft/draft_2019.csv',
 'crosswalk2027':BASE+'nba_crosswalk/nba_player_crosswalk_2027.csv',
 'crosswalk2020':BASE+'nba_crosswalk/nba_player_crosswalk_2020.csv',
 'core2027':BASE+'espn_nba_player_core/player_core_2027.csv',
 'roster2020':BASE+'nba_stats_rosters/rosters_2020.csv',
 'espnRoster2027':BASE+'espn_nba_rosters/rosters_2027.csv',
 'nba2013':BASE+'espn_nba_player_boxscores/player_box_2013.parquet',
 'ncaa2012':BASE+'espn_mens_college_basketball_player_boxscores/player_box_2012.parquet',
 'schedule2020':BASE+'espn_nba_schedules/nba_schedule_2020.parquet',
 'official2026':'https://www.nba.com/news/2026-nba-draft-order',
 'espnRosterWAS':'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/27/roster',
 'espnDraft2026':'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/draft?season=2026',
 'coreDraft2026':'https://sports.core.api.espn.com/v2/sports/basketball/nba/draft/2026/rounds/1/picks?limit=100',
 'ajProfile':'https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/5142718',
}
def main():
 out=Path('artifacts/rookie-revision');out.mkdir(parents=True,exist_ok=True)
 rows=[]
 for name,url in SOURCES.items():
  time.sleep(1)
  row={'name':name,'url':url,'retrievedAt':datetime.now(timezone.utc).isoformat()}
  try:
   with urlopen(Request(url,headers={'User-Agent':'nba-fantasy-assistant-source-research'}),timeout=30) as response:
    raw=response.read(25_000_001)
    if len(raw)>25_000_000:raise ValueError('Source too large')
    row.update(status=response.status,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
    if '.parquet' in url:
     table=pq.read_table(io.BytesIO(raw),use_threads=False);row.update(columns=table.column_names,rows=table.num_rows,sample=table.slice(0,1).to_pylist())
    elif '.csv' in url:
     import csv
     records=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))));row.update(columns=list(records[0]) if records else [],rows=len(records),sample=records[:2])
     if name=='core2027':row['anchors']=[r for r in records if any(str(r.get(k,'')) in ['5142718','5041935','5095151','5142620'] for k in r)]
     if name=='draft2027':row['sample']=records[:16]
    elif name=='official2026':
     import re
     row['markers']={word:word in raw.decode(errors='replace') for word in ['Dybantsa','Boozer','Acuff','2026']}
    else:
     data=json.loads(raw);row['keys']=list(data);row['sample']=data if name in ['coreDraft2026','espnDraft2026'] else data.get('athletes',data.get('athlete',data))
  except HTTPError as error:row.update(status=error.code,error=str(error),retryAfter=error.headers.get('Retry-After'))
  except Exception as error:row.update(error=str(error))
  rows.append(row);print('ROOKIE_PROBE '+json.dumps(row,default=str,separators=(',',':')),flush=True)
 (out/'probe.json').write_text(json.dumps(rows,default=str,indent=2))
if __name__=='__main__':main()
