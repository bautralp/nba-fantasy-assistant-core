"""Reviewable metadata-only migration from offline research artifacts.

Never activates a model or changes a numerical projection, ID or eligibility.
The full historical corpus stays in offline artifacts, outside the daily path.
"""
import argparse
from copy import deepcopy
import json
import hashlib
from pathlib import Path
from collections import Counter
from rookie_model import classify, validate_parameters
from report_rookie_coverage import report
from refresh_stats import atomic_write

METADATA={'experience','projectionBasis','verifiedSourceDate','experienceReason',
          'draftIdentityVerified','nbaEntryVerified','uncertainty'}

def protected(player):
    return {k:v for k,v in player.items() if k not in METADATA}

def migrate(snapshot, profiles, parameters):
    if parameters['enabled']:raise ValueError('Metadata migration cannot enable production')
    validate_parameters(parameters)
    before=deepcopy(snapshot);annotated=deepcopy(snapshot)
    coverage=report(annotated,(profiles,parameters))
    if len(before['players'])!=len(annotated['players']):raise ValueError('Player pool changed')
    if [protected(p) for p in before['players']]!=[protected(p) for p in annotated['players']]:
        raise ValueError('Numerical/identity/eligibility snapshot changed')
    for key in before:
        if key not in ('players','rookieModel') and before[key]!=annotated[key]:raise ValueError('Snapshot provenance changed')
    return annotated,coverage

def run(directory):
    read=lambda name:json.loads((directory/name).read_text())
    profiles=read('rookie-profiles.json');draft=read('rookie-draft-2026.json');summary=read('collection-summary.json')
    profiles['sourceHashes']={**profiles.get('sourceHashes',{}),**{s['key']:s['sha256'] for s in read('sources.json') if s.get('status')=='success'}}
    summary['old503RemainingEndpointKinds']=dict(Counter(error['kind'] for pid in summary['remaining503'] for error in profiles['profiles'][pid].get('endpointErrors',{}).values()))
    summary['old503StillHTTP503']=sum(any(error.get('status')==503 for error in profiles['profiles'][pid].get('endpointErrors',{}).values()) for pid in summary['remaining503'])
    backtest=read('rookie-revision-backtest.json')
    parameter_path=directory/'rookie-revision-parameters.json'
    parameters=read('rookie-revision-parameters.json') if parameter_path.exists() else json.loads(Path('scripts/rookie-parameters.json').read_text())
    frozen=deepcopy(parameters)
    if backtest.get('parameterSha256') and hashlib.sha256(json.dumps(frozen,sort_keys=True,separators=(',',':')).encode()).hexdigest()!=backtest['parameterSha256']:
        raise ValueError('Frozen parameter hash mismatch; refusing metadata migration')
    parameters['enabled']=False;parameters['calibrationStatus']='research-only'
    failed=backtest.get('acceptance',{}).get('failedCriteria',[backtest.get('status','unevaluated')])
    parameters['releaseGate']='Research only; production disabled. Research gates: '+', '.join(failed)+'. Activation also requires full CI and production review.'
    snapshot=json.loads(Path('public/data/player-projections.json').read_text())
    annotated,coverage=migrate(snapshot,profiles,parameters)
    counts=Counter();selected=[]
    by_id={p['id']:p for p in annotated['players']}
    for row in draft['selections']:
        pid=row['playerId'];profile=profiles['profiles'].get(pid,{}) if pid else {};player=by_id.get(pid)
        experience=classify(profile,[],[])
        selected.append({**row,'experience':experience,'ncaaAvailable':bool(profile.get('ncaa')),
            'ncaaGames':profile.get('ncaa',{}).get('gp'),'ncaaMinutes':profile.get('ncaa',{}).get('minutes'),
            'projectionStatus':player['status'] if player else 'outside-current-pool',
            'missingReason':player['reason'] if player and player['status']=='unavailable' else row.get('missingReason'),
            'metadataErrors':profile.get('endpointErrors')})
    for player in annotated['players']:
        counts['available' if player['status']=='available' else 'unavailable']+=1
        counts['draftIdentityVerified']+=int(player['draftIdentityVerified'])
        counts['nbaEntryVerified']+=int(player['nbaEntryVerified'])
    coverage.update(collection=summary,draftSelections=selected,numericalIntegrity={'playersBefore':len(snapshot['players']),
        'playersAfter':len(annotated['players']),'allProtectedFieldsEqual':True,'counts':dict(counts)},
        historicalTraining=backtest.get('trainingRookies'),historicalNCAA=backtest.get('ncaaTrainingPairs'),
        acceptance=backtest.get('acceptance',{'productionEnabled':False,'status':backtest.get('status')}))
    coverage['numericalIntegrity']['protectedSHA256']=hashlib.sha256(json.dumps([protected(p) for p in annotated['players']],sort_keys=True,separators=(',',':')).encode()).hexdigest()
    corpus_path=directory/'cohorts.json'
    if corpus_path.exists() and backtest.get('availabilityHoldout'):
        from evaluate_rookie_revision import observation,predict
        corpus=read('cohorts.json');denominators={}
        for year,reports in backtest['availabilityHoldout'].items():
            denominators[year]=[]
            for checkpoint in reports:
                scored=set(checkpoint['ids']);missing=[]
                for row in corpus['cohorts'].get(year,[]):
                    if row['id'] not in scored:continue
                    if predict(row,checkpoint['nbaGames'],frozen,'role') is None:missing.append(row['id'])
                denominators[year].append({'nbaGames':checkpoint['nbaGames'],'GPAndBrierPlayers':len(scored),
                    'totalProductionPlayers':len(scored)-len(missing),'missingPerGamePredictionIds':missing})
        coverage['availabilityPredictionCoverage']=denominators
    # All validation completes before any production artifact is replaced.
    atomic_write(profiles,'scripts/rookie-profiles.json');atomic_write(parameters,'scripts/rookie-parameters.json')
    atomic_write(annotated,'public/data/player-projections.json')
    atomic_write(coverage,'docs/stage-14-1-revision-coverage.json')
    atomic_write(backtest,'docs/stage-14-1-revision-backtest.json')
    atomic_write(coverage,'docs/stage-14-1-coverage.json')
    atomic_write(backtest,'docs/stage-14-1-backtest.json')
    atomic_write(frozen,'docs/stage-14-1-revision-frozen-parameters.json')
    atomic_write(read('sources.json'),'docs/stage-14-1-revision-sources.json')
    atomic_write(draft,'scripts/rookie-draft-2026.json')
    print('REVISION_METADATA_SUMMARY '+json.dumps({'poolSize':coverage['poolSize'],'counts':coverage['counts'],
        'newProductionProjections':0,'numericalIntegrity':coverage['numericalIntegrity']}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--input-dir',type=Path,default=Path('artifacts/rookie-revision'));args=parser.parse_args();run(args.input_dir)
