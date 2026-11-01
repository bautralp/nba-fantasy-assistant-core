"""Case report only. Research numbers never enter public/data or the ranking engine."""
import argparse
from collections import defaultdict
from datetime import date
import json
from pathlib import Path
from ros_history_research import load_season,project_history
from ros_model import projection_games
from regular_season import schedule_index
from rookie_model import prior_for,infer


def run(directory,candidate):
    root=Path(directory);diagnosis=json.loads(Path('docs/season/ros-model-audit/initial-diagnosis.json').read_text());evaluation=json.loads(Path('docs/season/ros-model-audit/history-evaluation.json').read_text())
    profiles=json.loads(Path('scripts/rookie-profiles.json').read_text())['profiles'];params=json.loads(Path('research/rookie-shadow/14.2-shadow-v1/parameters.json').read_text())
    data={y:load_season(root,y)[0] for y in [2024,2025,2026]}
    index=schedule_index((root/'nba_schedule_2027.parquet').read_bytes(),2027,date(2026,10,25));current=projection_games((root/'player_box_2027.parquet').read_bytes(),'2026-27',date(2026,10,25),index)
    new={p['id']:p for p in json.loads(Path(candidate).read_text())['players']};rows=[]
    for old in diagnosis['players']:
        pid=old['id'];observed=[g for g in current if g['id']==pid];row=new[pid];research=None
        if old['class']=='returning-veteran':
            history={y:[g for g in gs if g['id']==pid] for y,gs in data.items()}
            research=project_history(history,observed,2027,evaluation['selected']['decay'],evaluation['selected']['gapRetention'],'2026-10-25')
        elif old['class']=='rookie':
            prior=prior_for(profiles[pid],params)
            if prior:
                result=infer(prior,observed,params)
                research={'minutes':result['minutes'],'stats':result['stats'],'confidence':'research-only','model':'frozen-14.2-shadow-v1','basis':result['projectionBasis']}
        rows.append({'id':pid,'name':old['name'],'class':old['class'],'sourceObservedGP':len(observed),'before':{'statsAvailable':old['status']=='available','rosGP':old['rosGP'],'teamId':old['teamId']},'afterCandidate':{'statsAvailable':row['status']=='available','rosGP':row['rosGP'],'teamIdentity':row['teamIdentity'],'availability':row['availability']},'researchConditional':research,'researchROS_GP':None,'researchTotals':None,'productionPromotion':False})
    return {'asOf':'2026-10-25','kind':'diagnostic-not-published','rookieGateEnabled':params['enabled'],'historicalGateFailed':evaluation['failedCriteria'],'players':rows}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--candidate',required=True);p.add_argument('--output',required=True);a=p.parse_args();r=run(a.input_dir,a.candidate);Path(a.output).write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');print([(p['id'],p['afterCandidate']['statsAvailable'],p['afterCandidate']['rosGP']) for p in r['players']])
