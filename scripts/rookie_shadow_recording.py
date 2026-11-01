"""Daily frozen-model recording; source main and an independent append-only archive.

No calibration, historical downloads, production writes or main pushes. The
archive has its own root commit; main is never merged into its history.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.request import urlopen

import rookie_shadow as shadow

ARCHIVE_BRANCH = 'research/rookie-shadow-14.2-recordings'
MODEL_SHA = '0f828d3ced43c9abe323514833e356c1ccb7bb8ec243285684bd2023602a5267'
PROTOCOL_SHA = 'f598a3332048f96a6b9ea09b3c899264be7b2cc05d72505e7a85736183eddb53'
FIRST_SHA = 'c2cbac1f26588d31ca94348057cb2a6d3c21f510fcf02bf00533eb2994fc0f25'
FIRST_NAME = '2026-10-23T07-35-04.000033+00-00_' + FIRST_SHA + '.json'
FIRST = shadow.ROOT/'research/rookie-shadow/records'/FIRST_NAME
MAX_AGE = timedelta(hours=30)
SOURCE_URLS = {
    'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_player_boxscores/player_box_2027.parquet',
    'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules/nba_schedule_2027.parquet',
}


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, text=True, stderr=subprocess.PIPE).strip()


def instant(value):
    stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if stamp.utcoffset() != timedelta(0):
        raise ValueError('UTC timestamp required')
    return stamp


def frozen_manifest():
    for path, expected in ((shadow.MODEL, MODEL_SHA), (shadow.PROTOCOL, PROTOCOL_SHA), (FIRST, FIRST_SHA)):
        if shadow.digest(path.read_bytes()) != expected:
            raise ValueError('Frozen model/protocol/first origin changed: ' + path.name)
    return {'schemaVersion': 1, 'modelVersion': '14.2-shadow-v1', 'modelFileSha256': MODEL_SHA,
            'protocolSha256': PROTOCOL_SHA, 'firstRecordSha256': FIRST_SHA, 'firstRecordName': FIRST_NAME}


def validate_refresh(projections, stats, status, latest_run, now, event_run_id=None):
    """Reject degraded, stale, superseded or in-progress refreshes before inference."""
    if latest_run.get('head_branch') != 'main' or latest_run.get('status') != 'completed' or latest_run.get('conclusion') != 'success':
        raise ValueError('Latest main production refresh is not completed successfully')
    if event_run_id is not None and str(latest_run['id']) != str(event_run_id):
        raise ValueError('Refresh completion event was superseded; no stale origin recorded')
    if status.get('status') != 'ok' or status.get('errors'):
        raise ValueError('Production refresh is degraded')
    started = instant(latest_run['run_started_at'])
    completed = instant(latest_run['updated_at'])
    refreshed = instant(projections['refreshedAt'])
    stats_at = instant(stats['refreshedAt'])
    attempted = instant(status['attemptedAt'])
    if not started <= stats_at <= refreshed <= attempted <= completed + timedelta(minutes=5) or completed > now:
        raise ValueError('Snapshot does not belong to the successful refresh')
    if not timedelta(0) <= now-refreshed <= MAX_AGE or now-completed > MAX_AGE:
        raise ValueError('Stale production snapshot; no origin recorded')
    cutoff = datetime.fromisoformat(projections['asOf']).date()
    if projections['asOf'] != stats['asOf'] or not now.date()-timedelta(days=1) <= cutoff <= now.date():
        raise ValueError('Stale or inconsistent data cutoff')
    if projections.get('season') != '2026-27' or projections.get('rookieModel', {}).get('enabled') is not False:
        raise ValueError('Unexpected season or production rookie activation')
    sources = [s for s in projections['sources'] if s['season'] == '2026-27']
    if len(sources) != 2 or {s['url'] for s in sources} != SOURCE_URLS:
        raise ValueError('Only pinned routine 2027 source pair is allowed')


def checkpoint_report(records, current=None):
    """Report gaps; never turn a later observation into an earlier prediction."""
    history = sorted(records + ([current] if current else []), key=lambda r: r['generatedAt'])
    by_id = {}
    for record in history:
        for p in record['players']:
            by_id.setdefault(p['espnPlayerId'], []).append(p['observedNBAGP'])
    rows = []
    for pid, counts in sorted(by_id.items()):
        for n in shadow.CHECKPOINTS:
            state = ('captured' if n in counts else 'missed-before-first-record' if counts[0] > n
                     else 'missed-between-records' if max(counts) > n else 'not-yet-reached')
            rows.append({'espnPlayerId': pid, 'checkpoint': n, 'state': state,
                         'latestObservedGP': counts[-1], 'gpRegression': any(b < a for a, b in zip(counts, counts[1:]))})
    return {'schemaVersion': 1, 'kind': 'checkpoint-coverage', 'players': rows,
            'missed': sum(r['state'].startswith('missed-') for r in rows),
            'gpRegressionPlayers': sorted({r['espnPlayerId'] for r in rows if r['gpRegression']}),
            'cadence': 'Daily after successful refresh usually sees one new NBA appearance. Provider delays, double appearances across UTC cutoffs, failed/stale refreshes and delayed runs can skip exact checkpoints. No guarantee and no backfill.'}


def verify_archive(root):
    if (root/'manifest.json').read_bytes() != shadow.encode(frozen_manifest()):
        raise ValueError('Research archive manifest changed')
    if (root/'records'/FIRST_NAME).read_bytes() != FIRST.read_bytes():
        raise ValueError('First prospective record changed')
    records = shadow.verify_ledger(root/'records')
    files = git(root, 'ls-files').splitlines()
    if any(p != 'manifest.json' and not (p.startswith(('records/', 'reports/')) and p.endswith('.json') and p.count('/') == 1) for p in files):
        raise ValueError('Unexpected archive files; never merge main into the archive')
    for commit in git(root, 'rev-list', 'HEAD').splitlines():
        changes = git(root, 'diff-tree', '--root', '-m', '--no-commit-id', '--name-status', '--no-renames', '-r', commit)
        if any(line.split('\t')[0] != 'A' for line in changes.splitlines()):
            raise ValueError('Research branch has non-append-only history')
    for path in (root/'reports').glob('*.json'):
        if not path.stem.endswith('_'+shadow.digest(path.read_bytes())):
            raise ValueError('Checkpoint report changed')
    return records


def same_snapshot(records, candidate):
    fingerprint = candidate['recordingContext']['productionSnapshotSha256']
    first_input = shadow.read(shadow.RESEARCH/'inputs.json')
    for r in records:
        old = (first_input['productionSnapshotSha256'] if r['inputSha256'] == shadow.digest(shadow.encode(first_input))
               else r.get('recordingContext', {}).get('productionSnapshotSha256'))
        if old == fingerprint:
            return True
    return False


def add_file(path, raw):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(raw)


def publish(remote, candidate=None, before_push=None, attempts=3):
    """Build on the archive tip, retry a concurrent writer with the SAME origin.

    The callback is only for local race tests. All pushes are ordinary fast-forward
    pushes to one fixed research ref; neither force nor main destinations exist.
    """
    manifest = frozen_manifest()
    for attempt in range(attempts):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            git(root, 'init', '-q', '-b', 'archive')
            git(root, 'remote', 'add', 'origin', remote)
            git(root, 'config', 'user.name', 'github-actions[bot]')
            git(root, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
            ref = 'refs/heads/' + ARCHIVE_BRANCH
            exists = bool(git(root, 'ls-remote', '--heads', 'origin', ref))
            parent = None
            if exists:
                git(root, 'fetch', '-q', 'origin', ref)
                git(root, 'checkout', '-q', '--detach', 'FETCH_HEAD')
                parent = git(root, 'rev-parse', 'HEAD')
                records = verify_archive(root)
            else:
                add_file(root/'manifest.json', shadow.encode(manifest))
                add_file(root/'records'/FIRST_NAME, FIRST.read_bytes())
                records = [shadow.read(FIRST)]
            duplicate = candidate is not None and same_snapshot(records, candidate)
            if exists and (candidate is None or duplicate):
                return {'status': 'already-recorded' if duplicate else 'archive-ready', 'archiveBranch': ARCHIVE_BRANCH,
                        'archiveCommit': parent, 'checkpoints': checkpoint_report(records)}
            if candidate is not None and not duplicate:
                raw = shadow.encode(candidate)
                name = candidate['generatedAt'].replace(':', '-') + '_' + shadow.digest(raw) + '.json'
                add_file(root/'records'/name, raw)
                report = checkpoint_report(records, candidate)
                report_raw = shadow.encode(report)
                add_file(root/'reports'/(name.split('_')[0]+'_'+shadow.digest(report_raw)+'.json'), report_raw)
            git(root, 'add', '.')
            git(root, 'commit', '-q', '-m', 'research: append frozen rookie origin' if candidate and not duplicate else 'research: preserve first frozen rookie origin')
            verify_archive(root)
            if before_push:
                before_push(attempt)
            push = subprocess.run(['git', 'push', 'origin', 'HEAD:'+ref], cwd=root, capture_output=True, text=True)
            if push.returncode == 0:
                return {'status': 'recorded' if candidate and not duplicate else 'archive-seeded', 'archiveBranch': ARCHIVE_BRANCH,
                        'archiveCommit': git(root, 'rev-parse', 'HEAD'),
                        'checkpoints': checkpoint_report(shadow.verify_ledger(root/'records'))}
            # Main changes never matter. A research writer moving the ref is
            # retried; permission/protection failures are visible immediately.
            latest = git(root, 'ls-remote', '--heads', 'origin', ref).split()
            if not latest or latest[0] == parent:
                raise RuntimeError('Research push failed: ' + push.stderr.strip())
    raise RuntimeError('Research branch remained busy after bounded fast-forward retries')


def capture(inputs, run_id):
    frozen_manifest()
    protected = ['scripts', 'docs/stage-14-2-protocol.json', str(shadow.MODEL.relative_to(shadow.ROOT))]
    if git(shadow.ROOT, 'status', '--porcelain', '--', *protected):
        raise ValueError('Recording implementation must be committed')
    data = shadow.snapshot(inputs, shadow.read(shadow.MODEL), datetime.now(timezone.utc).isoformat())
    data.update(kind='prospective-record', implementationCommit=git(shadow.ROOT, 'rev-parse', 'HEAD'))
    data['recordingContext'] = {'productionSnapshotSha256': inputs['productionSnapshotSha256'],
                              'refreshRunId': run_id, 'sourceMainCommit': data['implementationCommit']}
    return data


def run(latest, event_run_id, remote, work):
    projections = shadow.read(shadow.ROOT/'public/data/player-projections.json')
    validate_refresh(projections, shadow.read(shadow.ROOT/'public/data/player-stats.json'),
                     shadow.read(shadow.ROOT/'public/data/projection-refresh-status.json'),
                     latest, datetime.now(timezone.utc), event_run_id)
    frozen_manifest()
    work.mkdir(parents=True, exist_ok=True)
    for source in projections['sources']:
        if source['season'] != '2026-27':
            continue
        raw = urlopen(source['url'], timeout=90).read()
        if shadow.digest(raw) != source['sha256']:
            raise ValueError('Routine current-season source changed since production refresh')
        (work/source['url'].rsplit('/', 1)[1]).write_bytes(raw)
    inputs = shadow.prepare(work)
    validate_refresh(projections, shadow.read(shadow.ROOT/'public/data/player-stats.json'),
                     shadow.read(shadow.ROOT/'public/data/projection-refresh-status.json'),
                     latest, datetime.now(timezone.utc), event_run_id)
    candidate = capture(inputs, latest['id'])
    shadow.write(work/'inputs.json', inputs)
    shadow.write(work/'candidate.json', candidate)
    return publish(remote, candidate)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--latest-run', type=Path)
    parser.add_argument('--event-run-id')
    parser.add_argument('--seed-only', action='store_true')
    args = parser.parse_args()
    remote = git(shadow.ROOT, 'remote', 'get-url', 'origin')
    work = shadow.ROOT/'artifacts/rookie-shadow/recording'
    try:
        result = publish(remote) if args.seed_only else run(shadow.read(args.latest_run), args.event_run_id, remote, work)
    except Exception as error:
        shadow.write(work/'status.json', {'status': 'blocked', 'reason': str(error), 'newOrigins': 0})
        raise
    shadow.write(work/'status.json', result)
    print(json.dumps({'status': result['status'], 'archiveBranch': ARCHIVE_BRANCH,
                      'missedCheckpoints': result['checkpoints']['missed']}))


if __name__ == '__main__':
    main()
