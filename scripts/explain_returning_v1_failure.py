"""Post-hoc error decomposition, not model selection or independent validation."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
from statistics import mean
from ros_history_research import load_season,project_history
from ros_model import project,summary
from returning_veteran import values,observed_values,METRICS


def run(directory):
    data={y:load_season(directory,y) for y in range(2021,2027)};by={y:defaultdict(list) for y in data}
    for y,(games,_,_) in data.items():
        for g in games:by[y][g['id']].append(g)
    errors=defaultdict(lambda:defaultdict(list));rows=[]
    for year in (2025,2026):
        candidates={pid for y in (year-3,year-2) for pid in by.get(y,{}) if not by[year-1].get(pid)}
        for pid in sorted(candidates):
            history={y:by[y].get(pid,[]) for y in range(year-3,year) if y in by};current=by[year].get(pid,[])
            for n in (1,2,3,5,10):
                if len(current)<n:continue
                observed=current[:n];cut=observed[-1]['date'];team=observed[-1]['teamId'];calendar=sorted(v['date'] for v in data[year][1].values() if v['excluded'] is None and team in v['teams'] and v['date']>cut)[:30]
                if len(calendar)<30:continue
                future=[g for g in current[n:] if g['date']<=calendar[-1]];old=project_history(history,observed,year,.75,.5,cut);v1=project([],observed)
                if not future or old is None or v1['status']!='available':continue
                truth=observed_values(future);pred=values(old['minutes'],old['stats']);scale=truth['MIN']/old['minutes']
                oracleMinute=values(truth['MIN'],{k:v*scale for k,v in old['stats'].items()})
                oracleRate=values(old['minutes'],{k:truth[k]*old['minutes']/truth['MIN'] for k in old['stats']})
                for name,v in [('oldCandidate',pred),('oldV1',values(v1['minutes'],v1['stats'])),('oracleMinutesOldRates',oracleMinute),('oldMinutesOracleRates',oracleRate)]:
                    for k in METRICS:
                        if truth.get(k) is not None and v.get(k) is not None:errors[name][k].append(abs(v[k]-truth[k]))
                rows.append({'id':pid,'year':year,'checkpoint':n,'oldMinutes':old['minutes'],'truthMinutes':truth['MIN'],'v1Minutes':v1['minutes']})
    return {'kind':'post-hoc-oracle-decomposition-not-a-forecast','cohort':'exact-old-9-common-checkpoints','checkpointCount':len(rows),'distinctPlayers':len({r['id'] for r in rows}),'weighting':'checkpoint mean to reproduce the old report; not comparable to v2 player-balanced development MAE','mae':{name:{k:mean(v) for k,v in metrics.items()} for name,metrics in errors.items()},'rows':rows}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);a=p.parse_args();Path(a.output).write_text(json.dumps(run(a.input_dir),indent=2,allow_nan=False)+'\n')
