"""Audit independently fetched ESPN observations; a box object is not GP proof."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def inspect(raw, expected_id, expected_year):
    data=json.loads(raw);header=data['header'];competition,=header['competitions']
    if header['id']!=expected_id or header['season']['year']!=expected_year or header['season']['type']!=2 or competition['status']['type']['completed'] is not True:
        raise ValueError('Unverified historical NBA game identity/date/status')
    teams={str(c['id']):c for c in competition['competitors']}
    if len(teams)!=2 or any(not 1<=int(t)<=30 for t in teams):raise ValueError('Invalid NBA teams')
    valid=[];missing=[];totals={t:0 for t in teams}
    for side in data['boxscore']['players']:
        team=str(side['team']['id'])
        if team not in teams:raise ValueError('Box/header team mismatch')
        for group in side['statistics']:
            labels=group['labels']
            for row in group['athletes']:
                stats=dict(zip(labels,row.get('stats',[])));pid=str(row['athlete']['id'])
                if row.get('didNotPlay') is True:continue
                if stats.get('MIN') in (None,'','--','-'):
                    missing.append(pid);continue
                made,att=(int(v) for v in stats['FG'].split('-'));three,threea=(int(v) for v in stats['3PT'].split('-'));ft,fta=(int(v) for v in stats['FT'].split('-'));pts=int(stats['PTS'])
                if made>att or ft>fta or three>made or three>threea or pts!=2*made+three+ft:raise ValueError('Inconsistent individual shooting')
                valid.append({'id':pid,'teamId':int(team),'minutes':float(stats['MIN']),'PTS':pts,'FGM':made,'FGA':att,'3PM':three,'3PA':threea,'FTM':ft,'FTA':fta,'REB':int(stats['REB']),'AST':int(stats['AST']),'STL':int(stats['STL']),'BLK':int(stats['BLK']),'TO':int(stats['TO'])});totals[team]+=pts
    scores_agree=bool(valid) and all(totals[t]==int(c['score']) for t,c in teams.items())
    reconciled=not missing and scores_agree
    return {'gameId':expected_id,'year':expected_year,'date':competition['date'],'sha256':hashlib.sha256(raw).hexdigest(),'numericStatRows':len(valid),'missingMinutePlayerIds':missing,'teamPoints':totals,'teamScoreReconciled':scores_agree,'completeStatCoverage':reconciled,'observations':valid,'individualCareerGPReconciled':False,'productionGatePassed':False}


def run(fixture):
    raw=gzip.decompress(Path(fixture).read_bytes());payload=json.loads(raw)
    return [inspect(row['raw'].encode(),row['gameId'],row['year']) for row in payload]

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--fixture',required=True);p.add_argument('--output',required=True);a=p.parse_args();result=run(a.fixture);Path(a.output).write_text(json.dumps(result,indent=2)+'\n');print([(r['gameId'],r['numericStatRows'],r['teamScoreReconciled']) for r in result])
