"""Offline missing-source attribution. Reads collected bytes; never downloads or fits."""
import argparse
from collections import Counter, defaultdict
from datetime import date
import csv
import hashlib
import json
from pathlib import Path
import re
from collect_rookie_revision import (CoverageGap, ESPN_TEAMS, is_nba_appearance,
                                    nba_games, nba_id_from_draft, normalized)
from parquet_io import read_parquet
from regular_season import schedule_index

TRAIN=tuple(range(2013,2019))
YEARS=(*TRAIN,2019)
MISSING={2013:['400278127','400278386','400278387','400278388','400278389'],
         2014:['400489088'],2017:['400900132'],2018:['400975285'],2019:['401070917']}

def group(profile,draft):
    if draft:
        pick=draft['pick'];round_=draft['round']
    else:
        match=re.match(r'\d{4}: Rd (\d+), Pk (\d+)',profile.get('displayDraft') or '')
        if not match:return 'undrafted-or-unknown'
        round_,pick=map(int,match.groups())
    return 'lottery' if round_==1 and pick<=14 else 'first-round' if round_==1 else 'second-round' if round_==2 else 'undrafted-or-unknown'

def identity_drafts(core,picks,official,year):
    official={int(r['overall_pick']):r for r in official}
    mapped={}
    slots=set()
    for p in picks.get('picks',[]):
        try:
            pid=nba_id_from_draft(p['athlete']);o=official[int(p['overall'])]
            if normalized(p['athlete']['displayName'])!=normalized(o['player_name']):continue
            mapped[pid]={'id':pid,'pick':int(p['overall']),'round':int(p['round']),'draftYear':year-1,'teamId':int(p['teamId']),'name':o['player_name']}
            slots.add(int(p['overall']))
        except (KeyError,TypeError,ValueError):continue
    for pid,c in core.items():
        try:
            slot=int(float(c['draft_selection']));o=official[slot]
            if int(float(c['draft_year']))!=year-1 or pid in mapped or slot in slots:continue
            if normalized(c['full_name'])!=normalized(o['player_name']) or int(float(c['draft_round']))!=int(o['round_number']):continue
            mapped[pid]={'id':pid,'pick':slot,'round':int(o['round_number']),'draftYear':year-1,'teamId':ESPN_TEAMS.get(o.get('team_abbreviation')),'name':o['player_name']}
            slots.add(slot)
        except (KeyError,TypeError,ValueError):continue
    return mapped

def eligible_identity(pid,year,p,draft):
    seasons=[s['year'] for s in p.get('seasons',[]) if s.get('gp',0)>0]
    if seasons and min(seasons)<year:return 'earlier-career'
    if not draft and not (p.get('identityVerified') and p.get('careerSchemaVerified') and seasons and min(seasons)==year):
        return 'unverified-career-debut'
    label=f"{year-1}: Rd {draft['round']}, Pk {draft['pick']}" if draft else p.get('displayDraft') or ''
    match=re.match(r'(\d{4}): Rd',label)
    if match and int(match[1])>=year:return 'conflicting-draft-year'
    return None

def classify_effect(*,team_hit,unusable,identity_error,gp_gap,missing_capacity,career_verified,partial,drafted):
    # Other reasons always take precedence over attributing an exclusion to the nine games.
    if unusable:return 'independent-invalid-statistics'
    if identity_error:return 'independent-'+identity_error
    if career_verified and gp_gap<0:return 'independent-individual-gp-gap'
    if gp_gap>0 and (not team_hit or gp_gap>missing_capacity):
        return 'independent-individual-gp-gap'
    if team_hit:
        if gp_gap==0 and career_verified:return 'confirmed-team-exclusion-only'
        if gp_gap>0:return 'coverage-consistent-gp-gap-not-exclusive-proof'
        return 'team-exclusion-otherwise-eligible-career-gp-unverified'
    if partial and not career_verified and drafted:
        return 'partial-season-extra-proof-rule-only'
    if partial and gp_gap!=0:return 'independent-individual-gp-gap'
    return 'retained'

def verify_unique_games(games):
    if len(games)!=len({g['gameId'] for g in games}):
        raise ValueError('Duplicate player-game rows; GP reconciliation cannot prove completeness')

def distribution(rows,field):
    return dict(sorted(Counter(str(r[field]) for r in rows).items()))

def audit(cache,corpus,coverage,profiles):
    manifest={}
    root=Path(__file__).resolve().parents[1]
    ledger=json.loads((root/'docs/stage-14-1-revision-sources.json').read_text())
    expected_hashes={r['key']:r['sha256'] for r in ledger if r.get('status')=='success' and r.get('sha256')}
    def checked(key,raw):
        digest=hashlib.sha256(raw).hexdigest()
        if expected_hashes.get(key)!=digest:raise ValueError('Unreviewed cached source bytes: '+key)
        manifest[key]=digest
    def read(key,kind='parquet'):
        path=cache/key
        if not path.is_file():raise ValueError('Existing cache required; no network fallback: '+key)
        raw=path.read_bytes();checked(key,raw)
        if kind=='csv':return list(csv.DictReader(raw.decode('utf-8-sig').splitlines()))
        if kind=='json':return json.loads(raw)
        return read_parquet(raw).to_pylist()
    prior=set();all_records=[];all_affected=[];replay={};accepted={}
    original={(r['id'],r['year']):r['reason'] for r in coverage['collection']['historicalCandidatesRejected']}
    for year in range(2002,2020):
        raw=read('nba-'+str(year))
        appearances={str(r['athlete_id']) for r in raw if is_nba_appearance(r)}
        if year not in YEARS:
            prior.update(appearances);continue
        path=cache/('nba_schedule_'+str(year)+'.parquet')
        schedule_raw=path.read_bytes();checked(path.name,schedule_raw)
        index=schedule_index(schedule_raw,year,date(year,12,31),historical_exhibitions=True)
        partial=False;detail={}
        try:games,rejected=nba_games(raw,index,year)
        except CoverageGap as error:
            games,rejected,detail=error.games,error.rejected,error.detail;partial=True
        if sorted(detail.get('missingGames',[]))!=sorted(MISSING.get(year,[])):raise ValueError('Unreviewed missing fixtures')
        if detail.get('extraGames') or detail.get('extraTeamSides'):raise ValueError('Unreviewed source errors')
        if partial and json.loads(json.dumps(detail))!=coverage['collection']['partialHistoricalSeasons'][str(year)]:
            raise ValueError('Reconciliation detail differs from the frozen collection')
        affected=set(detail.get('affectedTeams',[]))
        unusable=set(rejected.get('unusablePlayerIds',[]))
        core={str(r['athlete_id']):r for r in read('core-'+str(year)+'.csv','csv')
              if r.get('uid')=='s:40~l:46~a:'+str(r['athlete_id'])}
        drafts=identity_drafts(core,read('espn-draft-'+str(year-1)+'.json','json'),read('draft-'+str(year)+'.csv','csv'),year)
        observed_teams=defaultdict(set);positions=defaultdict(Counter)
        for r in raw:
            if is_nba_appearance(r):
                pid=str(r['athlete_id']);observed_teams[pid].add(int(r['team_id']))
                positions[pid][r.get('athlete_position_abbreviation') or 'unknown']+=1
        for pid,teams in observed_teams.items():
            if teams&affected:all_affected.append({'id':pid,'year':year,'teams':sorted(teams),'missingTeamIntersection':sorted(teams&affected),'rookieCandidate':pid not in prior})
        kept={r['id']:r for r in corpus['cohorts'][str(year)]}
        for pid in sorted(set(drafts)|set(games)):
            if pid in prior:continue
            verify_unique_games(games.get(pid,[]))
            draft=drafts.get(pid);p=profiles.get(pid,{})
            teams={g['teamId'] for g in games.get(pid,[])}
            if draft and draft.get('teamId') is not None:teams.add(draft['teamId'])
            hit=bool(teams&affected)
            capacity=sum(bool(set(index[k]['teams'])&observed_teams.get(pid,set())) for k in MISSING.get(year,[]))
            expected=max((s['gp'] for s in p.get('seasons',[]) if s['year']==year),default=0)
            gap=expected-len(games.get(pid,[]))
            err=eligible_identity(pid,year,p,draft)
            effect=classify_effect(team_hit=hit,unusable=pid in unusable,identity_error=err,gp_gap=gap,
                missing_capacity=capacity,career_verified=bool(p.get('careerSchemaVerified')),partial=partial,drafted=bool(draft))
            ncaa=p.get('ncaa');pointer=(p.get('collegeAthlete') or {}).get('id')
            has_ncaa=bool(p.get('identityVerified') and ncaa and str(ncaa.get('id'))==str(pointer) and ncaa.get('through','9999')<f'{year-1}-07-01')
            # Accepted corpus is the authoritative pre-debut feature snapshot.
            feature=kept.get(pid,{}).get('profile',{})
            if feature:has_ncaa=bool(feature.get('ncaa'))
            pos=(feature.get('priorPosition') if feature else ncaa.get('position') if has_ncaa else 'unknown') or 'unknown'
            record={'id':pid,'year':year,'name':draft.get('name') if draft else core.get(pid,{}).get('full_name'),
                    'period':'training' if year in TRAIN else 'validation','retained':pid in kept,
                    'playedObserved':bool(games.get(pid)),'draftGroup':group(p,draft),'position':pos,
                    'boxPosition':positions[pid].most_common(1)[0][0] if positions[pid] else 'unknown',
                    'profileCareerSha256':p.get('careerSha256'),'profileSourceSha256':p.get('sha256'),
                    'ncaaCollegeId':str(pointer) if has_ncaa else None,'ncaaThrough':ncaa.get('through') if has_ncaa and ncaa else None,
                    'observedMeanMinutes':sum(g['minutes'] for g in games.get(pid,[]))/len(games[pid]) if games.get(pid) else None,
                    'ncaaVerifiedPreDebut':has_ncaa,'ncaaStatus':'available' if has_ncaa else 'not-verified-in-existing-profile',
                    'profilePresent':bool(p),'draftVerified':bool(draft),'careerSchemaVerified':bool(p.get('careerSchemaVerified')),
                    'identityError':err,'validGP':len(games.get(pid,[])),'careerGP':expected if p.get('careerSchemaVerified') else None,
                    'gpGap':gap if p.get('careerSchemaVerified') else None,'unusableStatistics':pid in unusable,
                    'teamHit':hit,'observedTeamHit':bool(observed_teams.get(pid,set())&affected),'draftTeamHit':bool(draft and draft.get('teamId') in affected),'teams':sorted(teams),'missingGameCapacity':capacity,'effect':effect,
                    'originalRejection':original.get((pid,year))}
            if (pid in kept)!=(effect=='retained'):raise ValueError('Replay mismatch '+json.dumps(record))
            all_records.append(record)
        accepted[str(year)]=len(kept)
        prior.update(appearances)
    replayed={(r['id'],r['year']) for r in all_records if not r['retained']}
    original_keys={key for key in original if key[1] in YEARS}
    if replayed!=original_keys:raise ValueError('Rejection ledger player-season mismatch')
    summary={}
    attributable={'confirmed-team-exclusion-only','coverage-consistent-gp-gap-not-exclusive-proof',
                  'team-exclusion-otherwise-eligible-career-gp-unverified','partial-season-extra-proof-rule-only'}
    for period in ('training','validation'):
        rows=[r for r in all_records if r['period']==period]
        kept=[r for r in rows if r['retained']]
        effects=[r for r in rows if r['effect'] in attributable]
        direct=[r for r in effects if r['teamHit']]
        eligible=kept+effects
        dims={}
        for field in ('draftGroup','position','boxPosition','ncaaStatus'):
            dims[field]={}
            for value in sorted({str(r[field]) for r in eligible}):
                k=[r for r in kept if str(r[field])==value];e=[r for r in effects if str(r[field])==value]
                dims[field][value]={'retained':len(k),'affected':len(e),'eligibleCounterfactual':len(k)+len(e),
                    'lossFraction':len(e)/(len(k)+len(e)),'retainedPlayed':sum(r['playedObserved'] for r in k),
                    'affectedPlayedObserved':sum(r['playedObserved'] for r in e)}
        summary[period]={'retained':len(kept),'retainedPlayed':sum(r['playedObserved'] for r in kept),
            'candidatePlayerSeasons':len(rows),'sourcePolicyAssociatedExclusions':len(effects),'directTeamExclusionsOtherwiseEligible':len(direct),
            'counterfactualEligibleWithUnverifiedGPCaveat':len(eligible),'lossFraction':len(effects)/len(eligible),
            'effectCounts':distribution(rows,'effect'),'affectedByYear':dict(sorted(Counter(r['year'] for r in effects).items())),
            'dimensions':dims,'retainedNCAAPairsPlayed':sum(r['playedObserved'] and r['ncaaVerifiedPreDebut'] for r in kept),
            'affectedPlayedObserved':sum(r['playedObserved'] for r in effects),
            'retainedObservedMeanMinutes':sum(r['observedMeanMinutes'] for r in kept if r['playedObserved'])/sum(r['playedObserved'] for r in kept),
            'affectedObservedMeanMinutes':sum(r['observedMeanMinutes'] for r in effects if r['playedObserved'])/sum(r['playedObserved'] for r in effects) if any(r['playedObserved'] for r in effects) else None,
            'confirmedTeamOnly':sum(r['effect']=='confirmed-team-exclusion-only' for r in effects),
            'possibleDirectPlayed':sum(r['playedObserved'] for r in direct),
            'possibleDirectPlayedLossFraction':sum(r['playedObserved'] for r in direct)/(sum(r['playedObserved'] for r in kept)+sum(r['playedObserved'] for r in direct)),
            'affectedProfilesAbsent':sum(not r['profilePresent'] for r in effects),
            'affectedNoVerifiedPreDebutPosition':sum(r['position']=='unknown' for r in effects)}
    return {'schemaVersion':1,'kind':'offline-post-hoc-source-impact-not-new-holdout','missingGames':MISSING,
            'originalCriteriaUnchanged':True,'productionEnabled':False,'sourceSha256':manifest,
            'allObservedAffectedPlayerSeasons':all_affected,'records':all_records,'summary':summary,
            'limitations':['All observed affected team-seasons are conservative franchise exposure, not proof of playing a missing game.',
                'Career GP gaps consistent with missing fixtures do not prove exclusive causation.',
                'Absent NCAA features mean not verified in existing profile, not proof no NCAA history.',
                'Counterfactual eligibility never imputes missing statistics or changes training membership.']}

def main():
    p=argparse.ArgumentParser();p.add_argument('--cache',type=Path,default=Path('.research-cache'))
    p.add_argument('--corpus',type=Path,default=Path('artifacts/rookie-revision/cohorts.json'))
    p.add_argument('--output',type=Path,default=Path('artifacts/rookie-impact/report.json'));a=p.parse_args()
    root=Path(__file__).resolve().parents[1]
    report=audit(a.cache,json.loads(a.corpus.read_text()),json.loads((root/'docs/stage-14-1-revision-coverage.json').read_text()),
                 json.loads((root/'scripts/rookie-profiles.json').read_text())['profiles'])
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('IMPACT_SUMMARY '+json.dumps(report['summary']),flush=True)
if __name__=='__main__':main()
