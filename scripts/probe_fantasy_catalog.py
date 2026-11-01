"""Probe public ESPN FBA responses without cookies; retain transport evidence.

A failed HTTP CONNECT is a proxy failure, not an ESPN origin response.
"""
import argparse
from datetime import datetime, timezone
import json
import hashlib
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from refresh_stats import atomic_write
from fantasy_positions import URL, MAX_CATALOG_BYTES


def probe(url):
    try:
        headers = {'User-Agent': 'nba-fantasy-assistant',
                   'X-Fantasy-Filter': json.dumps({'players': {'limit': 5000, 'offset': 0}})}
        with urlopen(Request(url, headers=headers), timeout=60) as response:
            body = response.read(MAX_CATALOG_BYTES + 1)
            if len(body) > MAX_CATALOG_BYTES: raise ValueError('Probe response exceeds size limit')
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeDecodeError):
                payload = None
            records = payload if isinstance(payload, list) else payload.get('players', []) if isinstance(payload, dict) else []
            rows = [r.get('player', r) for r in records]
            anchors = {3112335, 4432166, 4871145}
            return {'url': url, 'status': response.status, 'transport': 'origin-response', 'count': len(rows),
                    'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body),
                    'observedSlots': sorted({s for row in rows for s in row.get('eligibleSlots', [])}),
                    'topLevelType': type(payload).__name__, 'fields': sorted(rows[0]) if rows else [],
                    'anchors': [{k: row.get(k) for k in ('id', 'fullName', 'eligibleSlots', 'defaultPositionId', 'proTeamId', 'injuryStatus')} for row in rows if row.get('id') in anchors]}
    except HTTPError as error:
        return {'url': url, 'status': error.code, 'transport': 'http-response', 'server': error.headers.get('Server'), 'error': str(error)}
    except URLError as error:
        text = str(error.reason)
        return {'url': url, 'status': None, 'transport': 'proxy-connect-failure' if 'Tunnel connection failed' in text else 'transport-failure', 'error': text}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, default=Path('docs/stage-14-espn-probe.json'))
    args = p.parse_args()
    urls = [URL + view for view in ('kona_player_info', 'players_wl')] + [
        'https://fantasy.espn.com/basketball/players/projections',
        'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams',
        'https://nba-fantasy-assistant.netlify.app/data/player-stats.json']
    result = {'probedAt': datetime.now(timezone.utc).isoformat(), 'requests': [probe(url) for url in urls]}
    atomic_write(result, args.output)
    print(json.dumps(result, indent=2))
