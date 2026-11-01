"""Create the standard boundary before any current regular-season observations.

Requires contemporaneous exact-ID eligibility, not today's roster backdated into
September. Future metadata is refused rather than silently reused.
"""
import copy
from collections import Counter
from ros_model import project,expected_gp


def initial_snapshot(template,catalog,histories,schedule,as_of,computed_at):
    if schedule['asOf']!=as_of:raise ValueError('Preseason schedule date mismatch')
    if schedule.get('retrievedAt',as_of)[:10]>as_of:raise ValueError('Future preseason schedule evidence')
    if any(e['retrievedAt'][:10]>as_of for e in catalog['players']):raise ValueError('Future preseason catalog evidence')
    if any(g['date']>as_of for h in histories.values() for gs in h.values() for g in gs):raise ValueError('Future preseason history')
    season=int(template['season'][:4])+1
    remaining=Counter(t for g in schedule['games'] for t in g['teamIds'])
    root=copy.deepcopy(template);root.update(asOf=as_of,generatedAt=computed_at,refreshedAt=computed_at,players=[])
    # Template contributes schema/source provenance only, never future player stats.
    for e in catalog['players']:
        pid=e['playerId'];past=histories.get(pid,{}).get(season-1,[]);r=project(past,[])
        team=e.get('proTeamId');team=team if isinstance(team,int) and 0<=team<=30 else None
        tr=0 if team==0 else remaining.get(team) if team else None
        gp=0 if team==0 else expected_gp(past,[],tr,0) if tr is not None and r['status']=='available' else None
        stats=r['stats']
        if stats:stats={**stats,'FG%':100*stats['FGM']/stats['FGA'] if stats['FGA'] else None,'FT%':100*stats['FTM']/stats['FTA'] if stats['FTA'] else None}
        root['players'].append({**r,'id':pid,'name':e['name'],'team':'FA' if team==0 else str(team) if team else 'Unknown','teamId':team,'eligibility':e,'positions':e['positions'],'rosGP':gp,'teamRemaining':tr,'stats':stats,'asOf':as_of,'generatedAt':computed_at,'rank':None,'totalZ':None,'injuryStatus':e.get('injuryStatus'),'uncertainty':['Normal sezon maçı yok; geçmiş NBA performansı koşullu öncüldür.']})
    root['positionReport']={'verified':sum(bool(p['positions']) for p in root['players']),'unresolved':sum(not p['positions'] for p in root['players']),'mismatches':[]}
    return root
