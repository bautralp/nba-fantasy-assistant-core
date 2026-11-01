"""Four requested consumers of a generic research model; no player coefficients."""
import argparse
from datetime import date
import gzip
import hashlib
import json
from pathlib import Path
from returning_veteran import observed_anchor,conditional_performance,participation,summary
from evaluate_returning_veteran import unpack
from ros_model import projection_games,remaining_schedule
from regular_season import schedule_index,coverage


def run(corpus,evaluation,directory):
    groups,_,certified,unknown=unpack(corpus);fold=next(f for f in evaluation['folds'] if f['year']==2027)
    root=Path(directory);raw=(root/'player_box_2027.parquet').read_bytes();sched=(root/'nba_schedule_2027.parquet').read_bytes();cut=date(2026,10,25)
    index=schedule_index(sched,2027,cut);games=projection_games(raw,'2026-27',cut,index);source_cut=date.fromisoformat(max(g['date'] for g in games));source_index=schedule_index(sched,2027,source_cut);coverage(games,source_index,2027,source_cut);remaining=remaining_schedule(sched,2027,source_cut);rows=[]
    for pid in ('4396993','6606','2991230','6442'):
        history={y:gs.get(pid,[]) for y,gs in groups.items() if y<2027 and y in certified and pid not in unknown[y]};current=[g for g in games if g['id']==pid]
        anchor=observed_anchor(history,2027);prediction=None;diagnostic=None
        if anchor and fold.get('selected'):
            prediction=conditional_performance(anchor,current,fold['parameters'],cut.isoformat(),fold['selected'])
            team=current[-1]['teamId'] if current else None
            elapsed=sum(v['excluded'] is None and team in v['teams'] for v in source_index.values()) if team else None
            diagnostic=participation(fold['availability'],len(current),elapsed,min(30,remaining[team]) if team in remaining else None)
        rows.append({'id':pid,'name':current[-1]['name'] if current else None,'history':[{'year':y,'GP':len(gs),'minutes':sum(g['minutes'] for g in gs),'sourceCertified':y in certified} for y,gs in history.items() if gs or y in (2025,2026)],'previousSeasonSourceObservedGP':len(groups[2026].get(pid,[])),'previousSeasonSourceCertified':2026 in certified,'observedCurrent':{'GP':len(current),'minutes':sum(g['minutes'] for g in current),'lastObservation':max((g['date'] for g in current),default=None)},'classification':'conditional-returning-scenario-source-certification-incomplete','warnings':['2026 team scoring mismatches prevent fully certified missed-season routing. Scenario uses source-observed zero appearances and task-provided returning classification.','No historical age/injury/dated roster proof; no injury-specific coefficient.','2027 source has only 28 games through October 23 versus independently observed 36 through October 24. Missing later source is not DNP.','Next-30-team-game attendance diagnostic is unvalidated conditional-on-return. Extrapolation to all remaining ROS games is unsupported; ROS GP and totals remain null.'],'conditionalPerformance':prediction,'diagnosticAvailabilityHorizonGames':min(30,remaining[team]) if current and team in remaining else None,'diagnosticAvailabilityAsOf':source_cut.isoformat(),'diagnosticAvailability':diagnostic,'publishableROSgp':None,'publishableTotals':None,'productionEnabled':False})
    return {'kind':'research-scenarios-not-production','asOf':cut.isoformat(),'currentSource':{'boxSHA256':hashlib.sha256(raw).hexdigest(),'scheduleSHA256':hashlib.sha256(sched).hexdigest(),'sourceThrough':max(g['date'] for g in games)},'trainingYears':fold.get('trainingYears'),'validationYears':fold.get('validationYears'),'policy':fold.get('selected'),'failedCriteria':evaluation['failedCriteria'],'players':rows,'powerRankings':{'beforeCompleteTeams':4,'afterCompleteTeams':4,'leagueRanksAvailable':False,'publicROSchanged':False}}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--corpus',required=True);p.add_argument('--evaluation',required=True);p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);a=p.parse_args()
    c=json.loads(gzip.decompress(Path(a.corpus).read_bytes()));e=json.loads(Path(a.evaluation).read_text());r=run(c,e,a.input_dir);Path(a.output).write_text(json.dumps(r,indent=2,allow_nan=False)+'\n')
    print([(r['name'],r['conditionalPerformance']['minutes'] if r['conditionalPerformance'] else None) for r in r['players']])
