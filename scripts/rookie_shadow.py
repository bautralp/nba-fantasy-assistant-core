"""Isolated conditional rookie inference and write-once prospective records.

Never imports the production publisher, changes public/data, fits availability,
or downloads historical evidence. Percentages in this research schema are 0..1.
"""
import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import subprocess
from statistics import mean

from rookie_model import classify, prior_for, infer, validate_parameters
from ros_model import projection_games, summary
from regular_season import schedule_index, coverage

ROOT = Path(__file__).resolve().parents[1]
RESEARCH = ROOT/'research/rookie-shadow/14.2-shadow-v1'
MODEL = RESEARCH/'parameters.json'
PROTOCOL = ROOT/'docs/stage-14-2-protocol.json'
METRICS = ('MIN', 'FGM', 'FGA', 'FG%', 'FTM', 'FTA', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO')
CHECKPOINTS = (0, 1, 3, 5, 10, 20)


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path):
    return json.loads(Path(path).read_bytes())


def write(path, value):
    path = Path(path)
    if not path.resolve().is_relative_to((ROOT/'research/rookie-shadow').resolve()) and not path.resolve().is_relative_to((ROOT/'artifacts').resolve()):
        raise ValueError('Shadow output must be inside research/rookie-shadow or artifacts')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode(value))


def prepare(input_dir, production_path=ROOT/'public/data/player-projections.json'):
    """Normalize only current-season bytes identified by an existing production snapshot."""
    production = read(production_path)
    as_of = date.fromisoformat(production['asOf'])
    contents = {}
    sources = [s for s in production['sources'] if s['season'] == '2026-27']
    if len(sources) != 2:
        raise ValueError('Current-season source pair required')
    for source in sources:
        name = source['url'].rsplit('/', 1)[1]
        raw = (input_dir/name).read_bytes()
        if digest(raw) != source['sha256']:
            raise ValueError('Source differs from pinned production snapshot: ' + name)
        contents[name] = raw
    index = schedule_index(contents['nba_schedule_2027.parquet'], 2027, as_of)
    games = projection_games(contents['player_box_2027.parquet'], '2026-27', as_of, index)
    report = coverage(games, index, 2027, as_of)
    profiles = read(ROOT/'scripts/rookie-profiles.json')
    current = defaultdict(list)
    for g in games:
        current[g['id']].append(g)
    eligible = {}
    excluded = Counter()
    for pid, profile in profiles['profiles'].items():
        kind = classify(profile, [], current[pid])
        if kind in ('rookie', 'international-newcomer'):
            eligible[pid] = profile
        else:
            excluded[kind] += 1
    return {'schemaVersion': 1, 'season': '2026-27', 'asOf': as_of.isoformat(), 'sources': sources,
            'productionSnapshotSha256': digest(Path(production_path).read_bytes()),
            'profilesSha256': digest((ROOT/'scripts/rookie-profiles.json').read_bytes()),
            'coverage': report, 'scheduleIndex': index, 'games': games, 'profiles': eligible,
            'excludedAtPreparation': dict(excluded)}


def validate_games(games, as_of):
    seen = set()
    for g in games:
        key = (g['id'], g['gameId'])
        if key in seen:
            raise ValueError('Duplicate observed player/game')
        seen.add(key)
        if not '2026-07-01' <= g['date'] <= as_of:
            raise ValueError('Future or wrong-season observation')
        s = g['stats']
        required = ('FGM', 'FGA', 'FTM', 'FTA', '3PM', '3PA', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO')
        if any(k not in s or isinstance(s[k], bool) or not isinstance(s[k], (int, float)) or not math.isfinite(s[k]) or s[k] < 0 for k in required):
            raise ValueError('Missing or invalid observed stats')
        # Normalization already excludes DNP and missing-minute placeholders.
        # An explicit zero is an appearance: GP informs minutes, not rate exposure.
        minutes = g.get('minutes')
        if isinstance(minutes, bool) or not isinstance(minutes, (float, int)) or not math.isfinite(minutes) or minutes < 0:
            raise ValueError('Invalid minutes')
        if not 0 <= s['3PM'] <= s['FGM'] <= s['FGA'] or not s['3PM'] <= s['3PA'] <= s['FGA'] or s['FGM']-s['3PM'] > s['FGA']-s['3PA'] or s['FTM'] > s['FTA'] or abs(s['PTS']-(2*s['FGM']+s['3PM']+s['FTM'])) > 1e-8:
            raise ValueError('Inconsistent observed shooting/points')


def snapshot(inputs, params, created_at):
    created = datetime.fromisoformat(created_at)
    if created.tzinfo is None or inputs['asOf'] > created.astimezone(timezone.utc).date().isoformat():
        raise ValueError('Future cutoff or naive creation timestamp')
    validate_parameters(params)
    if params['enabled'] or params['version'] != '14.2-shadow-v1' or params['protocolSha256'] != digest(PROTOCOL.read_bytes()):
        raise ValueError('Unreviewed model/protocol')
    validate_games(inputs['games'], inputs['asOf'])
    by_id = defaultdict(list)
    for g in inputs['games']:
        by_id[g['id']].append(g)
    players, excluded = [], Counter(inputs.get('excludedAtPreparation', {}))
    for pid, profile in sorted(inputs['profiles'].items()):
        if profile['id'] != pid:
            raise ValueError('Profile ESPN ID mismatch')
        # Reject future identity/draft evidence, including late same-day metadata.
        evidence_times = [profile.get('retrievedAt'), profile.get('verifiedIdentityAt'), profile.get('draftIdentity', {}).get('retrievedAt')]
        if any(t and (datetime.fromisoformat(t) > created or t[:10] > inputs['asOf']) for t in evidence_times):
            excluded['metadata-after-cutoff'] += 1
            continue
        games = sorted(by_id[pid], key=lambda g: (g['date'], g['gameId']))
        experience = classify(profile, [], games)
        if experience not in ('rookie', 'international-newcomer'):
            excluded[experience] += 1
            continue
        candidate_profile = dict(profile)
        warnings = ['Conditional per appearance; availability, ROS GP and totals are unvalidated',
                    'Current GP counts observed valid source rows; independent career GP reconciliation is pending',
                    'Confidence is qualitative low, not a calibrated probability interval']
        if experience == 'international-newcomer':
            candidate_profile.pop('ncaa', None)
            warnings.append('No international professional-league or NCAA conversion applied')
        prior = prior_for(candidate_profile, params)
        if prior is None:
            excluded['no-verified-prior'] += 1
            continue
        ncaa = candidate_profile.get('ncaa')
        if ncaa and (ncaa['through'] >= '2026-07-01' or str(ncaa['id']) != str(candidate_profile.get('collegeAthlete', {}).get('id'))):
            raise ValueError('Unverified or post-entry NCAA evidence')
        if not games:
            warnings.append('0 observed NBA GP; minutes and role are population priors, not a playing-time promise')
        if not ncaa:
            warnings.append('No verified NCAA data; draft prior only')
        if profile.get('missingReason'):
            warnings.append(profile['missingReason'])
        if any(g['starter'] is None for g in games):
            warnings.append('Starter observations incomplete')
        result = infer(prior, games, params)
        minute_weight = result['rookieWeights']['minutes']
        recent_weight = result['rookieRole']['appliedWeight']
        minute_components = {'prior': (1-recent_weight)*(1-minute_weight),
                             'observedMean': (1-recent_weight)*minute_weight, 'recentFive': recent_weight}
        stats = dict(MIN=result['minutes'], **result['stats'])
        stats.update({'FG%': stats['FGM']/stats['FGA'] if stats['FGA'] else None,
                      'FT%': stats['FTM']/stats['FTA'] if stats['FTA'] else None})
        players.append({'espnPlayerId': pid, 'name': profile.get('displayName', pid), 'modelVersion': params['version'],
                        'experience': experience, 'basis': 'NCAA-assisted' if prior['basis'] == 'NCAA-assisted' else 'draft prior',
                        'priorComponents': {'minutes': 'training NBA draft/position group',
                                            'rates': 'verified NCAA-to-NBA fit' if prior['basis'] == 'NCAA-assisted' else 'training NBA draft/position group',
                                            'shootingPercentages': 'training NBA draft/position group'},
                        'observedNBAGP': len(games), 'observedNBAMinutes': sum(g['minutes'] for g in games),
                        'observationWeights': result['rookieWeights'], 'minuteComponents': minute_components,
                        'role': result['rookieRole'],
                        'perGame': stats, 'perMinute': {k: v/result['minutes'] for k, v in result['stats'].items()},
                        'shooting': result['shooting'], 'confidence': 'low', 'warnings': warnings,
                        'availabilityProbability': None, 'rosGP': None, 'totals': None,
                        'asOf': inputs['asOf'], 'generatedAt': created_at})
    start = created.astimezone(timezone.utc).date() + timedelta(days=1)
    return {'schemaVersion': 1, 'modelVersion': params['version'], 'season': '2026-27',
            'kind': 'research-preview', 'unit': 'perGame', 'percentageUnit': 'fraction', 'productionEnabled': False,
            'asOf': inputs['asOf'], 'generatedAt': created_at,
            'horizon': {'start': start.isoformat(), 'end': (start+timedelta(days=29)).isoformat()},
            'modelSha256': digest(encode(params)), 'protocolSha256': digest(PROTOCOL.read_bytes()),
            'inputSha256': digest(encode(inputs)), 'sources': inputs['sources'],
            'players': players, 'excludedProfiles': dict(excluded)}


def record(inputs_path, ledger):
    """Actual clock only. Require model/protocol/implementation committed before origin."""
    protected = ['scripts/rookie_shadow.py', 'scripts/calibrate_rookie_shadow.py', 'scripts/rookie_model.py',
                 'scripts/ros_model.py', 'scripts/regular_season.py', 'scripts/refresh_stats.py', 'scripts/projection-config.json',
                 'docs/stage-14-2-protocol.json', str(MODEL.relative_to(ROOT))]
    subprocess.run(['git', 'ls-files', '--error-unmatch', *protected], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    if subprocess.check_output(['git', 'status', '--porcelain', '--', *protected], cwd=ROOT):
        raise ValueError('Commit the frozen model and implementation before recording')
    inputs = read(inputs_path)
    data = snapshot(inputs, read(MODEL), datetime.now(timezone.utc).isoformat())
    data['kind'] = 'prospective-record'
    data['implementationCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    raw = encode(data)
    ledger = ledger.resolve()
    if not ledger.is_relative_to((ROOT/'research/rookie-shadow/records').resolve()):
        raise ValueError('Prospective records must use the research ledger')
    ledger.mkdir(parents=True, exist_ok=True)
    path = ledger / (data['generatedAt'].replace(':', '-') + '_' + digest(raw) + '.json')
    # x mode refuses replacement; filename digest makes any later edit detectable.
    with path.open('xb') as stream:
        stream.write(raw)
    print(path)
    return path


def verify_ledger(ledger):
    records = []
    for path in sorted(ledger.glob('*.json')):
        raw = path.read_bytes()
        if not path.stem.endswith('_'+digest(raw)):
            raise ValueError('Modified prospective record: ' + path.name)
        data = json.loads(raw)
        if data['kind'] != 'prospective-record' or data['productionEnabled']:
            raise ValueError('Invalid record kind')
        if data['modelVersion'] != '14.2-shadow-v1' or data['protocolSha256'] != digest(PROTOCOL.read_bytes()) or data['modelSha256'] != digest(encode(read(MODEL))):
            raise ValueError('Mixed model versions or changed frozen protocol')
        if data['asOf'] > data['generatedAt'][:10] or data['horizon']['start'] <= data['generatedAt'][:10]:
            raise ValueError('Backdated/future record')
        records.append(data)
    return records


def outcome_stats(games):
    s = summary(games)
    return {'MIN': s['mpg'], **{k: mean(g['stats'][k] for g in games) for k in METRICS if k not in ('MIN', 'FG%', 'FT%')},
            'FG%': s['totals']['FGM']/s['totals']['FGA'] if s['totals']['FGA'] else None,
            'FT%': s['totals']['FTM']/s['totals']['FTA'] if s['totals']['FTA'] else None}


def score_records(ledger, outcomes):
    """Earliest saved exact checkpoint per player; never regenerates a prediction."""
    validate_games(outcomes['games'], outcomes['asOf'])
    if outcomes['asOf'] > datetime.now(timezone.utc).date().isoformat():
        raise ValueError('Future outcome cutoff')
    coverage(outcomes['games'], outcomes['scheduleIndex'], 2027, date.fromisoformat(outcomes['asOf']))
    records = sorted(verify_ledger(ledger), key=lambda r: r['generatedAt'])
    selected = {}
    for r in records:
        for p in r['players']:
            n = p['observedNBAGP']
            if n in CHECKPOINTS:
                selected.setdefault((p['espnPlayerId'], n), (r, p))
    report = []
    for n in CHECKPOINTS:
        errors = {k: [] for k in METRICS}
        rates = {k: [] for k in ('FGM', 'FGA', 'FTM', 'FTA', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO')}
        pending = no_future = 0
        ids = []
        for (pid, checkpoint), (r, p) in selected.items():
            if checkpoint != n:
                continue
            if outcomes['asOf'] < r['horizon']['end']:
                pending += 1
                continue
            future = [g for g in outcomes['games'] if g['id'] == pid and r['horizon']['start'] <= g['date'] <= r['horizon']['end']]
            if not future:
                no_future += 1
                continue
            truth = outcome_stats(future)
            for k in METRICS:
                if truth[k] is not None and p['perGame'][k] is not None:
                    errors[k].append(abs(truth[k]-p['perGame'][k]))
            for k in rates:
                rates[k].append(abs(truth[k]/truth['MIN']-p['perMinute'][k]))
            ids.append(pid)
        report.append({'observedNBAGP': n, 'scoredPlayers': len(ids), 'ids': ids, 'pending': pending,
                       'noFutureAppearance': no_future, 'savedExactCheckpoint': sum(k[1] == n for k in selected),
                       'perGameMAE': {k: mean(v) if v else None for k, v in errors.items()},
                       'metricCounts': {k: len(v) for k, v in errors.items()},
                       'perMinuteMAE': {k: mean(v) if v else None for k, v in rates.items()}})
    return {'schemaVersion': 1, 'kind': 'prospective-evaluation', 'outcomesAsOf': outcomes['asOf'],
            'outcomesSha256': digest(encode(outcomes)), 'checkpoints': report,
            'availability': None, 'rosGP': None, 'totals': None,
            'caveat': 'Exact checkpoint misses are never backfilled; repeated players are correlated; no-future-appearance is not zero per-game production'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--input-dir', type=Path, required=True)
    p.add_argument('--output', type=Path, default=RESEARCH/'inputs.json')
    p.add_argument('--production-snapshot', type=Path, default=ROOT/'public/data/player-projections.json')
    for name in ('preview', 'record'):
        p = sub.add_parser(name)
        p.add_argument('--inputs', type=Path, default=RESEARCH/'inputs.json')
    p = sub.add_parser('score')
    p.add_argument('--outcomes', type=Path, required=True)
    sub.add_parser('verify-ledger')
    args = parser.parse_args()
    ledger = ROOT/'research/rookie-shadow/records'
    if args.command == 'prepare':
        write(args.output, prepare(args.input_dir, args.production_snapshot))
    elif args.command == 'preview':
        write(RESEARCH/'projections.json', snapshot(read(args.inputs), read(MODEL), datetime.now(timezone.utc).isoformat()))
    elif args.command == 'record':
        record(args.inputs, ledger)
    elif args.command == 'score':
        write(ROOT/'artifacts/rookie-shadow/prospective-evaluation.json', score_records(ledger, read(args.outcomes)))
    else:
        print('Verified records:', len(verify_ledger(ledger)))


if __name__ == '__main__':
    main()
