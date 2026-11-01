"""Explicit draft joins. Draft-internal IDs and player-name similarity are never join keys."""
import re
import unicodedata

def normalized(value):
    return re.sub(r'[^a-z0-9]','',unicodedata.normalize('NFKD',value or '').encode('ascii','ignore').decode().lower())

def nba_id_from_draft(athlete):
    # ESPN draft athlete.id is a separate namespace (e.g. 110904); never use it.
    ids=[]
    for key in ('proLink','link'):
        match=re.search(r'/nba/player/_/id/(\d+)',athlete.get(key,''))
        if match:ids.append(match[1])
    uid=re.fullmatch(r's:40~l:46~a:(\d+)',athlete.get('uid',''))
    if uid:ids.append(uid[1])
    alternative=athlete.get('alternativeId')
    if alternative:ids.append(str(alternative))
    if len(ids)<2 or len(set(ids))!=1:raise ValueError('Unverified ESPN draft/player ID link')
    return ids[0]

def verify_current_draft(official, espn, catalog):
    if official['draftYear']!=2026 or espn.get('year')!=2026:raise ValueError('Draft year mismatch')
    records=official['records']
    if sorted(r['overall'] for r in records)!=list(range(1,61)):raise ValueError('Official draft must contain 60 unique selections')
    picks={p['overall']:p for p in espn['picks']}
    if len(picks)!=len(espn['picks']) or sorted(picks)!=list(range(1,61)):raise ValueError('Incomplete or duplicate ESPN draft selections')
    by_id={p['playerId']:p for p in catalog['players']}
    if len(by_id)!=len(catalog['players']):raise ValueError('Duplicate Fantasy athlete IDs')
    results=[];seen=set()
    for row in records:
        p=picks[row['overall']];a=p['athlete']
        result={**row,'verified':False,'playerId':None,'inFantasyCatalog':False}
        try:
            pid=nba_id_from_draft(a)
            if pid in seen:raise ValueError('ESPN player linked to multiple draft selections')
            names=[row['name'],*row.get('explicitNameAliases',[])]
            if normalized(a.get('displayName')) not in {normalized(n) for n in names}:raise ValueError('Official/ESPN name guard failed; manual review required')
            if int(p['round'])!=row['round'] or int(p['teamId'])!=row['draftTeamId']:raise ValueError('Official draft round/team disagreement')
            if pid in by_id and normalized(by_id[pid]['name']) not in {normalized(n) for n in [a['displayName'],*names]}:raise ValueError('Fantasy player identity guard failed')
            seen.add(pid);result.update(playerId=pid,verified=True,inFantasyCatalog=pid in by_id,
                draftInternalId=str(a['id']),espnUID=a.get('uid'),espnProLink=a.get('proLink') or a.get('link'),
                signals=['official-year-overall-round','official-original-draft-team','exact-name-or-explicit-alias-guard','explicit-ESPN-proLink-UID-alternativeId','Fantasy-athlete-ID'] if pid in by_id else ['official-year-overall-round','official-original-draft-team','exact-name-guard','explicit-ESPN-proLink-UID-alternativeId'],
                missingReason=None)
        except (KeyError,TypeError,ValueError) as error:result['missingReason']=str(error)
        results.append(result)
    return results

def merge_draft_evidence(profile, selection, source, retrieved_at, nba_entry=False):
    out=dict(profile or {'id':selection['playerId']})
    if not selection['verified']:return out
    if str(out['id'])!=selection['playerId']:raise ValueError('Draft/profile ESPN ID mismatch')
    out.update(identityVerified=True,uid=selection['espnUID'],displayName=out.get('displayName') or selection['name'],
        displayDraft=f"2026: Rd {selection['round']}, Pk {selection['overall']}",
        draftIdentity={'verified':True,'playerId':selection['playerId'],'year':2026,'overall':selection['overall'],
                       'round':selection['round'],'source':source,'signals':selection['signals'],'retrievedAt':retrieved_at},
        nbaEntryVerified=bool(nba_entry),verifiedIdentityAt=retrieved_at)
    if nba_entry and selection.get('preNBALeague')=='international-pro':
        out.update(preNBALeague='international-pro',preNBALeagueSource=source,preNBAClub=selection.get('organization'))
    return out
