"""Independent numerical reference: no TS analysis/ranking implementation reuse."""
from projection_replay_inputs import load_inputs
import argparse
import json
import math
from statistics import mean,stdev
from pathlib import Path

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--report',default='docs/season/final-projection-results.json');parser.add_argument('--source',default=None);args=parser.parse_args()
    report=json.loads(Path(args.report).read_text())
    source=json.loads(Path(args.source).read_text() if args.source else load_inputs()['files']['projection-scenarios.json']);players={p['id']:p for p in source['projection']['players']}
    categories=['FG%','FT%','3PM','REB','AST','STL','BLK','TO','PTS'];values={};checked=0
    for team in report['teams']:
        total={k:0.0 for k in ['FGM','FGA','FTM','FTA','3PM','REB','AST','STL','BLK','TO','PTS']}
        for c in team['contributions']:
            p=players[str(c['espnId'])];gp=c['expectedGames']
            if gp:
                for k in total:total[k]+=p['stats'][k]*gp
        values[team['teamId']]={**total,'FG%':100*total['FGM']/total['FGA'],'FT%':100*total['FTM']/total['FTA']}
    for category in categories:
        rows=report['rankings'][category];direction=-1 if category=='TO' else 1
        ordered=sorted(values,key=lambda t:direction*-values[t][category]);data=[values[t][category] for t in ordered];mu=mean(data);sd=stdev(data)
        for row in rows:
            v=values[row['teamId']][category];rank=1+sum(direction*x>direction*v and not math.isclose(x,v,rel_tol=1e-10) for x in data)
            z=direction*(v-mu)/sd if sd else 0
            assert math.isclose(v,row['projectedValue'],rel_tol=1e-10),(category,row['teamId'],'value')
            assert rank==row['rank'],(category,row['teamId'],'rank')
            assert math.isclose(z,row['powerScore'],abs_tol=1e-9),(category,row['teamId'],'z')
            checked+=1
    assert checked==90
    print('Independent weighted FG/FT, reversed TO, competition ranks and sample z: 90/90 actual-fixture cells verified')
