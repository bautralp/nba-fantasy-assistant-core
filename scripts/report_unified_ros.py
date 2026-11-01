"""Compare pinned old Extended and unified candidates without editing published data."""
import argparse
import json
from collections import Counter
from pathlib import Path


def report(candidate, league_report):
    standard=json.loads(Path('public/data/player-projections.json').read_text())
    old=json.loads(Path('public/data/projection-scenarios.json').read_text())
    before=json.loads(Path('docs/season/final-projection-results.json').read_text())
    base={p['id']:p for p in standard['players']}; previous={p['id']:p for p in old['projection']['players']}
    rows=candidate['projection']['players']
    keep=lambda r:{k:v for k,v in r.items() if k not in ('rank','totalZ')}
    incomplete=[{'id':p['id'],'name':p['name'],'status':p['status'],'reason':p['reason'],'gp':p['rosGP'],'teamId':p.get('teamId'),'opportunityBasis':candidate['players'][p['id']]['opportunityEvidence']['basis']} for p in rows if p['status']!='available' or p['rosGP'] is None]
    comparisons=[]
    for category,rs in league_report['rankings'].items():
        for row in rs:
            b=next(x for x in before['rankings'][category] if x['teamId']==row['teamId'])
            comparisons.append({'category':category,'teamId':row['teamId'],'before':{k:b[k] for k in ('projectedValue','rank','powerScore')},'after':{k:row[k] for k in ('projectedValue','rank','powerScore')},'valueDelta':row['projectedValue']-b['projectedValue'],'cause':'Standard performance and known GP retained instead of depth/preseason/continuous-model replacement; league distributions and lineup participation recalculated.'})
    return {'asOf':candidate['asOf'],'modelVersion':candidate['modelVersion'],'standardPerformancePreserved':sum(p['status']=='available' and p['stats']==base[p['id']]['stats'] and p['shooting']==base[p['id']]['shooting'] and p['minutes']==base[p['id']]['minutes'] for p in rows if base[p['id']]['status']=='available'),'standardCompleteRowsPreserved':sum(base[p['id']]['status']=='available' and base[p['id']]['rosGP'] is not None and keep(p)==keep(base[p['id']]) for p in rows),'completedPerformances':sum(p['status']=='available' and base[p['id']]['status']!='available' for p in rows),'completionModels':dict(Counter(candidate['players'][p['id']]['modelVersion'] for p in rows if p['status']=='available' and base[p['id']]['status']!='available')),'examples':[{'id':p['id'],'name':p['name'],'standard':base[p['id']],'oldExtended':previous[p['id']],'unified':p} for p in rows if p['name'] in ('Nikola Jokic','Kawhi Leonard','LeBron James')],'incompleteCount':len(incomplete),'incomplete':incomplete,'coverage':league_report['extendedCoverage'],'cells':comparisons,'changedValues':sum(c['valueDelta']!=0 for c in comparisons),'changedRanks':sum(c['before']['rank']!=c['after']['rank'] for c in comparisons)}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);p.add_argument('--output',required=True);a=p.parse_args();root=Path(a.input_dir)
    result=report(json.loads((root/'projection-scenarios.json').read_text()),json.loads((root/'final-projection-results.json').read_text()))
    Path(a.output).write_text(json.dumps(result,indent=2)+'\n')
    print({k:v for k,v in result.items() if k not in ('examples','incomplete','cells')})
