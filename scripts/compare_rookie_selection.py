"""Compare frozen team censoring with individual GP on existing cache only.

No HTTP client, source acquisition, model fitting, tuning, or holdout evaluation.
"""
import argparse
from collections import Counter
from copy import deepcopy
from datetime import date
import hashlib
import json
from pathlib import Path
from collect_rookie_revision import CoverageGap, nba_games
from regular_season import schedule_index
from parquet_io import read_parquet
from rookie_selection import POLICY, select_season
from evaluate_rookie_revision import validate_corpus

ROOT = Path(__file__).resolve().parents[1]
YEARS = tuple(range(2013, 2020))
FEATURES = ('id', 'uid', 'identityVerified', 'displayDraft', 'collegeAthlete', 'ncaa',
            'priorPosition', 'preNBALeague', 'source', 'sha256', 'careerSha256')

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def comparison(cache, original_corpus):
    audit_raw = (ROOT/'docs/stage-14-1-source-impact.json').read_bytes()
    profiles_raw = (ROOT/'scripts/rookie-profiles.json').read_bytes()
    ledger_raw = (ROOT/'docs/stage-14-1-revision-sources.json').read_bytes()
    audit = json.loads(audit_raw)
    profiles = json.loads(profiles_raw)['profiles']
    ledger = {s['key']: s['sha256'] for s in json.loads(ledger_raw) if s.get('status') == 'success'}
    source_hashes = {}
    def cached(key):
        raw = (cache/key).read_bytes()  # Missing cache deliberately fails; never download.
        sha = digest(raw)
        if ledger.get(key) != sha:
            raise ValueError('Cached source differs from reviewed ledger: ' + key)
        source_hashes[key] = sha
        return raw
    old_rows = []
    new_rows = []
    cohorts = {}
    schedules = {}
    for year in YEARS:
        index = schedule_index(cached(f'nba_schedule_{year}.parquet'), year, date(year,12,31), historical_exhibitions=True)
        try:
            games, rejected = nba_games(read_parquet(cached(f'nba-{year}')).to_pylist(), index, year)
            detail = {}
        except CoverageGap as error:
            games, rejected, detail = error.games, error.rejected, error.detail
        reviewed = json.loads((ROOT/'docs/stage-14-1-revision-coverage.json').read_text())['collection']['partialHistoricalSeasons'].get(str(year), {})
        if json.loads(json.dumps(detail)) != reviewed:
            raise ValueError('Unreviewed league reconciliation error')
        unusable = set(rejected.get('unusablePlayerIds', []))
        old_by_id = {r['id']: r for r in original_corpus['cohorts'][str(year)]}
        candidates = [r for r in audit['records'] if r['year'] == year]
        if set(old_by_id) != {r['id'] for r in candidates if r['retained']}:
            raise ValueError('Frozen corpus and old selection membership differ')
        if any(row['games'] != games.get(pid, []) for pid,row in old_by_id.items()):
            raise ValueError('Frozen individual games differ from the reviewed cache')
        cohorts[str(year)] = []
        schedules[str(year)] = index
        for old in candidates:
            pid = old['id']
            player = profiles.get(pid, {})
            gs = games.get(pid, [])
            # Recovered rows all have positive NBA appearances. No missing draft
            # or native identity is guessed, and draft team is never a censor.
            draft = old_by_id.get(pid, {}).get('draft')
            decision = select_season(pid, year, player, gs, draft, pid in unusable)
            fields = {k: old[k] for k in ('id','year','period','draftGroup','position','boxPosition','ncaaVerifiedPreDebut')}
            old_rows.append({**fields, 'accepted': old['retained'], 'reason': old.get('originalRejection')})
            new_rows.append({**fields, **decision, 'previouslyAccepted': old['retained']})
            if not decision['accepted']:
                continue
            if pid in old_by_id:
                row = deepcopy(old_by_id[pid])
            else:
                # Existing verified pre-NBA crosswalk only; no NCAA name join.
                feature = {k: deepcopy(player[k]) for k in FEATURES if k in player}
                ncaa = feature.get('ncaa')
                if ncaa and (str(ncaa.get('id')) != str((feature.get('collegeAthlete') or {}).get('id'))
                             or ncaa.get('through', '9999') >= f'{year-1}-07-01'):
                    raise ValueError('Unverified or future NCAA feature for recovered row')
                feature['priorPosition'] = (ncaa or {}).get('position') or 'unknown'
                feature['preNBALeague'] = 'NCAA' if ncaa else 'unknown'
                row = {'id': pid, 'games': gs, 'draft': None, 'profile': feature,
                       'identityBasis': 'verified-career-start-plus-earlier-box-history'}
                # Draft grouping comes from immutable NBA metadata, not a future roster.
            row['selectionProof'] = decision
            cohorts[str(year)].append(row)
    new_corpus = {'schemaVersion': 1, 'selectionPolicy': POLICY, 'cohorts': cohorts, 'schedules': schedules}
    validate_corpus(new_corpus)
    summary = {}
    for period in ('training', 'validation'):
        olds = [r for r in old_rows if r['period'] == period]
        news = [r for r in new_rows if r['period'] == period]
        old_accepted = [r for r in olds if r['accepted']]
        new_accepted = [r for r in news if r['accepted']]
        gains = [r for r in news if r['accepted'] and not r['previouslyAccepted']]
        lost = [r for r in news if not r['accepted'] and r['previouslyAccepted']]
        dimensions = {}
        for key in ('draftGroup', 'position', 'boxPosition', 'ncaaVerifiedPreDebut'):
            dimensions[key] = {str(v): {'old': sum(r['accepted'] and r[key] == v for r in olds),
                'new': sum(r['accepted'] and r[key] == v for r in news),
                'recovered': sum(r[key] == v for r in gains), 'removed': sum(r[key] == v for r in lost)}
                for v in sorted({r[key] for r in olds}, key=str)}
        summary[period] = {'oldRecords': len(old_accepted), 'newRecords': len(new_accepted),
            'oldPlayed': sum(r['validGP'] > 0 for r in audit['records'] if r['period'] == period and r['retained']),
            'newPlayed': sum(r['observedGP'] > 0 for r in new_accepted),
            'recovered': gains, 'removed': lost, 'remainingRejected': len(news)-len(new_accepted),
            'rejectionReasons': dict(sorted(Counter(r['reason'] for r in news if not r['accepted']).items())),
            'dimensions': dimensions}
    provenance = {'auditSha256': digest(audit_raw), 'profilesSha256': digest(profiles_raw),
                  'oldCorpusCanonicalSha256': digest(json.dumps(original_corpus,sort_keys=True,separators=(',',':')).encode()),
                  'sourceLedgerSha256': digest(ledger_raw), 'sources': source_hashes}
    return {'old': {'policy': 'frozen-team-censoring', 'records': old_rows, 'provenance': provenance},
            'new': {'policy': POLICY, 'records': new_rows, 'provenance': provenance},
            'comparison': {'schemaVersion': 1, 'policy': POLICY, 'summary': summary, 'provenance': provenance,
                'parametersChanged': False, 'newIndependentAccuracyEvidence': False}, 'new-cohorts': new_corpus}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cache', type=Path, default=Path('.research-cache'))
    p.add_argument('--corpus', type=Path, default=Path('artifacts/rookie-revision/cohorts.json'))
    p.add_argument('--output', type=Path, default=Path('artifacts/rookie-selection'))
    args = p.parse_args()
    result = comparison(args.cache, json.loads(args.corpus.read_text()))
    args.output.mkdir(parents=True, exist_ok=True)
    for name, value in result.items():
        (args.output/(name+'.json')).write_text(json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2)+'\n')
    print('INDIVIDUAL_SELECTION_SUMMARY '+json.dumps(result['comparison']['summary']), flush=True)
if __name__ == '__main__':
    main()
