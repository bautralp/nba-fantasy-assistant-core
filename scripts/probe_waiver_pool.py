"""Anonymous ESPN waiver-pool evidence for Stage 17.4. Prints aggregates only.

No cookies or credentials. Checks the CORS preflight a browser on the published
origin sends for the custom X-Fantasy-Filter header, then pages kona_player_info
with the same filter the app uses and cross-checks every ID against the league's
current rosters. Player names and raw payloads are never written.
"""
import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ORIGIN = 'https://nba-fantasy-assistant.github.io'
BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{season}/segments/0/leagues/{league}'
MAX_PAGE_BYTES = 4 * 1024 * 1024
# Experiments may ask for larger pages than the app reads today.
MAX_EXPERIMENT_BYTES = 8 * 1024 * 1024
# Sequential requests only, with a pause between them; the scan stops on any 429.
REQUEST_GAP_SECONDS = 0.5
MAX_EXPERIMENT_REQUESTS = 30
COUNT_HEADER = 'x-fantasy-filter-player-count'
# Fields the app's normalizePoolPage needs from each entry.
REQUIRED = ('id', 'status', 'player.id', 'player.fullName', 'player.eligibleSlots', 'player.proTeamId',
            'player.defaultPositionId', 'player.ownership.percentOwned')


def pool_filter(offset, limit, trim=True, **extra):
    """Same filter as src/infrastructure/espn/waiverPool.ts; trim=False is the pre-trim baseline."""
    players = {'filterStatus': {'value': ['FREEAGENT', 'WAIVERS']}, 'limit': limit, 'offset': offset,
               'sortPercOwned': {'sortPriority': 1, 'sortAsc': False},
               **({'filterStatsForSourceIds': {'value': [99]}} if trim else {}), **extra}
    return json.dumps({'players': players}, separators=(',', ':'))


def get(url, headers=None, max_bytes=MAX_PAGE_BYTES):
    request = Request(url, headers={'User-Agent': 'nba-fantasy-assistant', 'Origin': ORIGIN, **(headers or {})})
    with urlopen(request, timeout=30) as response:
        body = response.read(max_bytes + 1)
        if len(body) > max_bytes:
            raise ValueError('page exceeds the client size limit')
        return response.status, dict(response.headers), body


def header(headers, name):
    return next((v for k, v in headers.items() if k.lower() == name), None)


def has_path(entry, path):
    value = entry
    for key in path.split('.'):
        if not isinstance(value, dict) or key not in value:
            return False
        value = value[key]
    return True


def summarize(status, headers, body, players):
    return {'status': status, 'received': len(players), 'bytes': len(body), 'playerCountHeader': header(headers, COUNT_HEADER),
            'missingRequiredFields': sorted({f for e in players for f in REQUIRED if not has_path(e, f)}),
            'playerFields': sorted({k for e in players for k in e.get('player', {})})}


class Experiments:
    """Bounded, sequential live checks for reading the pool beyond 400 players."""

    def __init__(self, kona, owned):
        self.kona, self.owned, self.requests, self.stopped = kona, owned, 0, None

    def fetch(self, filter_text):
        if self.stopped or self.requests >= MAX_EXPERIMENT_REQUESTS:
            self.stopped = self.stopped or 'request budget reached'
            return None
        if self.requests:
            time.sleep(REQUEST_GAP_SECONDS)
        self.requests += 1
        try:
            status, headers, body = get(self.kona, {'X-Fantasy-Filter': filter_text}, MAX_EXPERIMENT_BYTES)
        except HTTPError as error:
            if error.code == 429:
                self.stopped = f'429 Retry-After={error.headers.get("Retry-After")}'
            return {'status': error.code}
        except Exception as error:  # recorded, never fatal: the main scan above is the CI gate
            return {'error': type(error).__name__ + ': ' + str(error)[:200]}
        players = json.loads(body).get('players')
        if not isinstance(players, list):
            return {'status': status, 'error': 'unexpected shape'}
        return {**summarize(status, headers, body, players), '_players': players}

    @staticmethod
    def public(result):
        return None if result is None else {k: v for k, v in result.items() if k != '_players'}

    def run(self, sample_ids):
        out = {'requestGapSeconds': REQUEST_GAP_SECONDS, 'maxRequests': MAX_EXPERIMENT_REQUESTS}
        # 1. Larger pages: does ESPN honour limit 100/200, and how big are they?
        out['pageSizes'] = {str(n): self.public(self.fetch(pool_filter(0, n, trim=False))) for n in (100, 200)}
        # 2. Payload trimming: candidate filters that may drop the stats blocks. Each is
        #    judged by bytes and by whether the fields the app needs are still present.
        trims = {
            'topScoringPeriodIds0': {'filterStatsForTopScoringPeriodIds': {'value': 0, 'additionalValue': []}},
            'unknownStatSource': {'filterStatsForSourceIds': {'value': [99]}},
            'unknownSplitType': {'filterStatsForSplitTypeIds': {'value': [99]}},
        }
        out['trim'] = {name: self.public(self.fetch(pool_filter(0, 50, trim=False, **extra))) for name, extra in trims.items()}
        # 3. filterIds: can we ask for exactly the players we can rank?
        ids = self.fetch(pool_filter(0, len(sample_ids), trim=False, filterIds={'value': sample_ids}))
        if ids is not None and '_players' in ids:
            got = {e.get('id') for e in ids['_players']}
            ids = {**self.public(ids), 'requested': len(sample_ids), 'matched': len(got & set(sample_ids)),
                   'unexpected': len(got - set(sample_ids))}
        out['filterIds'] = self.public(ids)
        # 4. Full scan with the largest page size that worked, until a short page.
        size = max([int(n) for n, r in out['pageSizes'].items() if r and r.get('received') == int(n)] or [50])
        seen, statuses, pages, ended, on_team, rostered, dupes = set(), {}, [], False, 0, 0, 0
        offset = 0
        while True:
            result = self.fetch(pool_filter(offset, size, trim=False))
            if result is None or '_players' not in result:
                pages.append(self.public(result))
                break
            for e in result['_players']:
                pid = e.get('id')
                dupes += pid in seen
                seen.add(pid)
                statuses[e.get('status')] = statuses.get(e.get('status'), 0) + 1
                on_team += e.get('onTeamId', 0) not in (0, None)
                rostered += pid in self.owned
            pages.append({k: v for k, v in self.public(result).items() if k != 'playerFields'} | {'offset': offset})
            if result['received'] < size:
                ended = True
                break
            offset += size
        out['fullScan'] = {'pageSize': size, 'pages': pages, 'endObserved': ended, 'uniquePlayers': len(seen),
                           'duplicates': dupes, 'statuses': statuses, 'onTeamIdNonZero': on_team, 'inLeagueRosters': rostered,
                           'totalBytes': sum(p.get('bytes', 0) for p in pages if p)}
        out['requestsUsed'], out['stoppedBy'] = self.requests, self.stopped
        return out


def preflight(url):
    request = Request(url, method='OPTIONS', headers={'Origin': ORIGIN, 'Access-Control-Request-Method': 'GET',
                                                       'Access-Control-Request-Headers': 'x-fantasy-filter'})
    try:
        with urlopen(request, timeout=30) as response:
            status, headers = response.status, response.headers
    except HTTPError as error:
        status, headers = error.code, error.headers
    keep = {k.lower(): v for k, v in headers.items() if k.lower().startswith('access-control-')}
    return {'status': status, 'headers': keep,
            'allowsOrigin': keep.get('access-control-allow-origin') in (ORIGIN, '*'),
            'allowsHeader': 'x-fantasy-filter' in keep.get('access-control-allow-headers', '').lower()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('league', type=int)
    parser.add_argument('season', type=int)
    parser.add_argument('--page-size', type=int, default=200)
    parser.add_argument('--max-pages', type=int, default=10)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--experiments', action='store_true',
                        help='also measure larger pages, payload trimming, filterIds and the real end of the pool')
    args = parser.parse_args()
    base = BASE.format(season=args.season, league=args.league)
    report = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'league': args.league, 'season': args.season,
              'origin': ORIGIN, 'pageSize': args.page_size, 'maxPages': args.max_pages}
    kona = base + '?view=kona_player_info'
    report['preflight'] = preflight(kona)
    status, headers, body = get(base + '?view=mRoster')
    rosters = json.loads(body)
    owned = {e['playerPoolEntry']['player']['id'] for t in rosters.get('teams', []) for e in t.get('roster', {}).get('entries', [])}
    report['leagueSnapshot'] = {'status': status, 'teams': len(rosters.get('teams', [])), 'rosteredPlayers': len(owned),
                        'allowOrigin': headers.get('Access-Control-Allow-Origin') or headers.get('access-control-allow-origin')}
    seen, pages, ended = {}, [], False
    for page in range(args.max_pages):
        status, headers, body = get(kona, {'X-Fantasy-Filter': pool_filter(page * args.page_size, args.page_size)})
        players = json.loads(body).get('players')
        if not isinstance(players, list):
            raise ValueError('unexpected kona_player_info shape')
        statuses, dupes, on_team, rostered = {}, 0, 0, 0
        for entry in players:
            pid = entry.get('id')
            statuses[entry.get('status')] = statuses.get(entry.get('status'), 0) + 1
            on_team += entry.get('onTeamId', 0) not in (0, None)
            rostered += pid in owned
            dupes += pid in seen
            seen.setdefault(pid, entry.get('status'))
        pages.append({'offset': page * args.page_size, 'status': status, 'received': len(players), 'bytes': len(body),
                      'playerCountHeader': header(headers, COUNT_HEADER),
                      'sha256': hashlib.sha256(body).hexdigest(), 'statuses': statuses, 'duplicatesOfEarlierPages': dupes,
                      'onTeamIdNonZero': on_team, 'inLeagueRosters': rostered,
                      'waiverProcessDates': sum(1 for e in players if e.get('waiverProcessDate')),
                      'fields': sorted({k for e in players for k in e}),
                      'allowOrigin': headers.get('Access-Control-Allow-Origin') or headers.get('access-control-allow-origin')})
        if len(players) < args.page_size:
            ended = True
            break
    report['pages'] = pages
    report['pool'] = {'uniquePlayers': len(seen), 'endObserved': ended,
                      'statuses': {s: sum(1 for v in seen.values() if v == s) for s in sorted({str(v) for v in seen.values()})}}
    if args.experiments:
        time.sleep(REQUEST_GAP_SECONDS)
        report['experiments'] = Experiments(kona, owned).run(sorted(seen)[:25])
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + '\n', encoding='utf-8')
    print(text)


if __name__ == '__main__':
    main()
