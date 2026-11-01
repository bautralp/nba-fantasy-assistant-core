"""Offline coverage report and metadata-only migration of a validated ROS snapshot.

Never changes numerical projections, ranks, eligibility, identity, dates or GP.
Daily generation adds the same metadata through generate_projections.build.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
from rookie_model import load_artifacts, classify, prior_for, verified_identity_date
from refresh_stats import atomic_write


def report(snapshot, artifacts):
    profiles, parameters=artifacts
    counts=Counter();unavailable=[];rookies=[];matched=[];candidates=[]
    for player in snapshot['players']:
        p=profiles['profiles'].get(player['id'])
        experience=classify(p,[],[])
        player.update(experience=experience, projectionBasis='NBA history' if player['role']['previous']['gp'] else 'Current NBA sample' if player['role']['current']['gp'] else None,
            verifiedSourceDate=verified_identity_date(p),
            experienceReason=p.get('missingReason') if p else 'Doğrulanmış kariyer metadata kaydı yok')
        player['draftIdentityVerified']=bool(p and p.get('draftIdentity', {}).get('verified'))
        player['nbaEntryVerified']=bool(p and p.get('nbaEntryVerified'))
        counts[experience]+=1
        if p and p.get('identityVerified'):counts['identityVerified']+=1
        if p and p.get('careerSchemaVerified'):counts['careerVerified']+=1
        if p and p.get('ncaa'):matched.append({'id':p['id'],'name':player['name'],'ncaaId':p['ncaa']['id'],'gp':p['ncaa']['gp'],'minutes':p['ncaa']['minutes'],'through':p['ncaa']['through']})
        if experience in ('rookie','international-newcomer'):
            rookies.append({'id':player['id'],'name':player['name'],'experience':experience,'draft':p.get('displayDraft'),'ncaa':bool(p.get('ncaa')),'source':p.get('draftIdentity',{}).get('source') or p.get('source')})
            if not parameters['enabled']:
                text='Rookie öncülü araştırma aşamasında; production doğrulama kapısı kapalı'
                if text not in player['uncertainty']:player['uncertainty'].append(text)
            if prior_for(p,parameters):candidates.append(player['id'])
        if player['status']=='unavailable':unavailable.append({'id':player['id'],'name':player['name'],'experience':experience,'reason':player['reason'],'metadataReason':player['experienceReason']})
    snapshot['rookieModel']={'version':parameters['version'],'enabled':parameters['enabled'],'releaseGate':parameters['releaseGate']}
    return {'schemaVersion':1,'poolSize':len(snapshot['players']),'counts':dict(counts),'verifiedRookies':rookies,'preNBAData':matched,
        'researchPriorCandidates':candidates,'newProductionProjections':0,'unavailable':unavailable,
        'releaseGate':parameters['releaseGate'],'note':'Research candidates are not validated individual predictions. No numerical projection changed.'}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--snapshot',type=Path,default=Path('public/data/player-projections.json'))
    p.add_argument('--output',type=Path,default=Path('docs/stage-14-1-coverage.json'));p.add_argument('--annotated-output',type=Path);a=p.parse_args()
    snapshot=json.loads(a.snapshot.read_text());result=report(snapshot,load_artifacts());atomic_write(result,a.output)
    if a.annotated_output:atomic_write(snapshot,a.annotated_output)
    print({k:v for k,v in result.items() if k in ('poolSize','counts','newProductionProjections')})
