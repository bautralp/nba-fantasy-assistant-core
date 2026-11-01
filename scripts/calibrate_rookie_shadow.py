"""Offline Stage 14.2 calibration under the committed protocol; no network access."""
import argparse
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path

from evaluate_rookie_revision import (fit, tune, training_scales, validate_corpus,
                                      conditional_evaluate, observation, predict)
from rookie_model import RATE_KEYS, prior_for, infer, validate_parameters
from ros_model import summary
from refresh_stats import atomic_write

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = ROOT / 'docs/stage-14-2-protocol.json'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_corpus(path, protocol):
    raw = Path(path).read_bytes()
    if Path(path).suffix == '.gz':
        raw = gzip.decompress(raw)
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if blob != protocol['corpusBlob']:
        raise ValueError('Unreviewed corpus; pinned individual-gp-v1 blob required')
    corpus = json.loads(raw)
    allowed = set(map(str, protocol['trainingEndingYears'] + protocol['validationEndingYears']))
    if set(corpus['cohorts']) != allowed or corpus['selectionPolicy']['version'] != 'individual-gp-v1':
        raise ValueError('Forbidden seasons or selection policy')
    validate_corpus(corpus)
    for year, rows in corpus['cohorts'].items():
        for row in rows:
            proof = row['selectionProof']
            if not proof['accepted'] or proof['verifiedGP'] != len(row['games']) or not row['games']:
                raise ValueError('Individual GP not reconciled')
            row['year'] = int(year)
    train = [r for y in protocol['trainingEndingYears'] for r in corpus['cohorts'][str(y)]]
    validation = [r for y in protocol['validationEndingYears'] for r in corpus['cohorts'][str(y)]]
    counts = dict(training=len(train), validation=len(validation), ncaaTraining=sum(bool(r['profile'].get('ncaa')) for r in train))
    if counts != protocol['expectedCounts']:
        raise ValueError('Reviewed sample counts changed')
    return corpus, train, validation, counts


def rate_diagnostics(rows, schedules, params):
    """Future minutes are outcomes only; predictions receive exactly games[:n]."""
    from statistics import mean
    reports = []
    for n in (0, 1, 3, 5, 10, 20):
        errors = {k: [] for k in RATE_KEYS}
        weights = {k: [] for k in ('minutes', *RATE_KEYS, '2P%', '3P%', 'FT%')}
        missing = no_future = 0
        shot_errors = {k: [] for k in ('FGM', 'FTM', 'FGA', 'FTA', '3PM')}
        role_errors = {'recentStarter': [], 'recentBench': [], 'starterUnknown': []}
        consistency = []
        for row in rows:
            view = observation(row, n, schedules[str(row['year'])])
            if view is None:
                missing += 1
                continue
            if not view['conditional']:
                no_future += 1
                continue
            prior = prior_for(row['profile'], params)
            if prior is None:
                missing += 1
                continue
            result = infer(prior, view['observed'], params)
            truth = summary(view['conditional'])
            role = result['rookieRole']['starterRate']
            bucket = 'starterUnknown' if role is None else 'recentStarter' if role >= .5 else 'recentBench'
            role_errors[bucket].append(abs(result['minutes']-truth['mpg']))
            for k in shot_errors:
                shot_errors[k].append(abs(result['stats'][k]-sum(g['stats'][k] for g in view['conditional'])/len(view['conditional'])))
            s = result['stats']
            consistency.append(abs(s['PTS']-(2*s['FGM']+s['3PM']+s['FTM'])))
            for k in RATE_KEYS:
                predicted = (result['shooting']['2P' if k == '2PA' else '3P' if k == '3PA' else 'FT']['attempts']
                             if k in ('2PA', '3PA', 'FTA') else result['stats'][k]) / result['minutes']
                errors[k].append(abs(predicted - truth['rates'][k]))
            for k, w in result['rookieWeights'].items():
                weights[k].append(w)
        reports.append({'nbaGames': n, 'scoredPlayers': len(errors['REB']), 'noFutureAppearance': no_future,
                        'unscored': missing, 'perMinuteMAE': {k: mean(v) if v else None for k, v in errors.items()},
                        'shotVolumeMAE': {k: mean(v) if v else None for k, v in shot_errors.items()},
                        'minutesMAEByObservedRole': {k: {'players': len(v), 'mae': mean(v) if v else None} for k, v in role_errors.items()},
                        'maximumPointsConsistencyResidual': max(consistency, default=0),
                        'meanObservationWeights': {k: mean(v) if v else None for k, v in weights.items()}})
    return reports


def sensitivity(params):
    """Synthetic, deterministic response tests; never presented as player evidence."""
    profile = {'id': 'synthetic', 'identityVerified': True, 'displayDraft': '2026: Rd 1, Pk 1'}
    prior = prior_for(profile, params)
    def game(i, minutes=20, spike=False, starter=False):
        stats = {'FGM': 12 if spike else 3, 'FGA': 20 if spike else 8, '3PM': 4 if spike else 1,
                 '3PA': 8 if spike else 3, 'FTM': 4 if spike else 2, 'FTA': 5 if spike else 3,
                 'PTS': 32 if spike else 9, 'REB': 5, 'AST': 3, 'STL': 1, 'BLK': 0, 'TO': 2}
        return {'id': 'synthetic', 'gameId': str(i), 'date': '2026-10-01', 'teamId': 1,
                'minutes': minutes, 'starter': starter, 'stats': stats}
    reports = []
    for n in (0, 1, 3, 5, 10, 20):
        base = [game(i) for i in range(n)]
        scenarios = {'steady': base,
                     'lastGameSpike': base[:-1] + [game(n, 36, True, True)] if n else [],
                     'recentRoleIncrease': [game(i, 32 if i >= n-5 else 20, starter=i >= n-5) for i in range(n)],
                     'starterLabelOnly': [dict(g, starter=True) for g in base]}
        results = {}
        for label, games in scenarios.items():
            r = infer(prior, games, params)
            results[label] = {'MIN': r['minutes'], 'stats': r['stats'], 'weights': r['rookieWeights'],
                              'role': r['rookieRole'], 'perMinute': {k: v/r['minutes'] for k, v in r['stats'].items()},
                              'availability': None, 'rosGP': None, 'totals': None}
        reports.append({'nbaGames': n, 'scenarios': results})
    return reports


def run(corpus_path, output):
    protocol = json.loads(PROTOCOL.read_text())
    corpus, train, validation, counts = load_corpus(corpus_path, protocol)
    priors, fits, pairs = fit(train, 30, 100)
    params = {'schemaVersion': 1, 'version': protocol['version'], 'enabled': False,
              'calibrationStatus': 'development-only', 'releaseGate': 'Prospective validation and availability/role review required',
              'selectionPolicy': 'individual-gp-v1', 'protocolSha256': sha(PROTOCOL), 'corpusBlob': protocol['corpusBlob'],
              'trainingSeasons': protocol['trainingEndingYears'], 'validationSeasons': [2019], 'testSeasons': [],
              'priors': priors, 'ncaaFits': fits, **deepcopy(protocol['initialHyperparameters'])}
    params, choices = tune(validation, corpus['schedules'], params, training_scales(train, corpus['schedules']))
    validate_parameters(params)
    legacy = json.loads((ROOT/'scripts/rookie-parameters.json').read_text())
    report = {'schemaVersion': 1, 'modelVersion': params['version'], 'protocolSha256': sha(PROTOCOL),
              'corpusBlob': protocol['corpusBlob'], 'sampleCounts': counts, 'ncaaPairs': pairs,
              'independentTest': False, 'holdoutRead': False, 'productionEnabled': False,
              'evaluationLabel': '2018-19 development validation; selected parameters evaluated on their selection set',
              'selection': choices,
              'shadow': conditional_evaluate(validation, corpus['schedules'], params),
              'legacy328': conditional_evaluate(validation, corpus['schedules'], legacy),
              'rateDiagnostics': rate_diagnostics(validation, corpus['schedules'], params),
              'syntheticSensitivity': sensitivity(params),
              'availability': {'probability': None, 'rosGP': None, 'totals': None,
                               'reason': 'Verified non-participation sample absent; conditional inference only'}}
    atomic_write(params, output/'parameters.json')
    atomic_write(report, output/'development.json')
    print('Shadow calibration:', counts, 'NCAA enabled:', params['ncaaEnabled'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, default=ROOT/'research/rookie-shadow/14.2-shadow-v1')
    args = parser.parse_args()
    run(args.corpus, args.output_dir)
