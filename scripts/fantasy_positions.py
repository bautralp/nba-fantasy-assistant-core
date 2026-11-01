"""Explicit, evidence-bearing fantasy eligibility. Never expand NBA G/F labels.

No FBA slot mapping is assumed. API slot IDs require a reviewed mapping manifest
with source evidence; manual fallback accepts specific positions and its own provider.
"""
import argparse
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
from urllib.request import Request, urlopen
from refresh_stats import atomic_write
import hashlib

URL = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/2027/players?view='
POSITIONS = {'PG', 'SG', 'SF', 'PF', 'C'}
DEFAULT_MAPPING = Path(__file__).with_name('fba-slot-mapping-2027.json')
MAX_CATALOG_BYTES = 50_000_000


def fetch_api():
    # Unfiltered ESPN requests return only 50 alphabetically ordered players.
    # Request the full pool and filter active records locally: the service may
    # ignore filterActive and returns legacy records without eligibility fields.
    headers = {'User-Agent': 'nba-fantasy-assistant',
               'X-Fantasy-Filter': json.dumps({'players': {'limit': 5000, 'offset': 0}})}
    with urlopen(Request(URL + 'kona_player_info', headers=headers), timeout=60) as response:
        body = response.read(MAX_CATALOG_BYTES + 1)
    if len(body) > MAX_CATALOG_BYTES:
        raise ValueError('Catalog exceeds size limit')
    payload = json.loads(body)
    if not isinstance(payload, list) or len(payload) < 500 or len(payload) >= 5000:
        raise ValueError('Incomplete or truncated ESPN catalog')
    return payload, hashlib.sha256(body).hexdigest()


def validate_catalog(data):
    if data.get('schemaVersion') != 1 or data.get('season') != '2026-27' or not isinstance(data.get('players'), list):
        raise ValueError('Invalid fantasy catalog')
    seen = set()
    for row in data['players']:
        if (not isinstance(row.get('playerId'), str) or not row['playerId'].isdigit()
                or row['playerId'] in seen or row.get('season') != data['season']
                or row.get('status') not in ('verified', 'unresolved')
                or not all(isinstance(row.get(k), str) and row[k].strip() for k in ('provider', 'source', 'name'))
                or not isinstance(row.get('positions'), list)
                or len(set(row['positions'])) != len(row['positions'])
                or not set(row['positions']) <= POSITIONS):
            raise ValueError('Invalid player eligibility; only specific fantasy positions accepted')
        retrieved = datetime.fromisoformat(row['retrievedAt'].replace('Z', '+00:00'))
        if retrieved.utcoffset() != timedelta(0):
            raise ValueError('Catalog retrievedAt must be UTC')
        if (row['status'] == 'verified') != bool(row['positions']):
            raise ValueError('Verified requires positions; unresolved requires empty positions')
        seen.add(row['playerId'])
    return data


def parse_api(payload, mapping, retrieved_at):
    # Slot meanings must be independently evidenced using FBA, never football/baseball.
    if mapping.get('sport') != 'fba' or mapping.get('season') != 2027 or not mapping.get('evidence'):
        raise ValueError('Reviewed FBA mapping evidence required')
    slots = mapping['slots']
    if not all(isinstance(v, str) and v in POSITIONS | {'G', 'F', 'SG/SF', 'G/F', 'PF/C', 'F/C', 'UTIL', 'BENCH', 'IR', 'ROOKIE'} for v in slots.values()):
        raise ValueError('Unknown slot meaning')
    if not isinstance(payload, list) or not payload:
        raise ValueError('API schema not verified: expected nonempty player array')
    rows = []
    for item in payload:
        row = item.get('player', item)
        if row.get('active') is False:
            continue
        if not all(k in row for k in ('id', 'fullName', 'defaultPositionId', 'eligibleSlots', 'proTeamId')):
            raise ValueError('API player schema changed')
        if not isinstance(row['eligibleSlots'], list) or not isinstance(row['id'], int) or not isinstance(row['proTeamId'], int) or not isinstance(row['defaultPositionId'], int):
            raise ValueError('Invalid ESPN identity/slot schema')
        if any(str(slot) not in slots for slot in row['eligibleSlots']):
            raise ValueError('Unmapped FBA slot')
        positions = sorted({slots[str(slot)] for slot in row['eligibleSlots']} & POSITIONS)
        rows.append({'playerId': str(row['id']), 'name': row['fullName'], 'season': '2026-27',
                     'positions': positions, 'provider': 'ESPN Fantasy FBA', 'source': URL + 'kona_player_info',
                     'retrievedAt': retrieved_at, 'status': 'verified' if positions else 'unresolved',
                     'proTeamId': row['proTeamId'], 'injuryStatus': row.get('injuryStatus')})
    # Require real known-ID anchors. Names never establish a join.
    anchors = {'3112335': 'Nikola Jokic', '4432166': 'Cade Cunningham', '4871145': 'Josh Giddey'}
    names = {r['playerId']: r['name'] for r in rows}
    if any(names.get(k) != name for k, name in anchors.items()):
        raise ValueError('ESPN ID anchor validation failed')
    return validate_catalog({'schemaVersion': 1, 'season': '2026-27', 'refreshedAt': retrieved_at,
                             'mappingEvidence': mapping['evidence'], 'players': rows})


def refresh(output, manual=None, mapping=DEFAULT_MAPPING):
    if manual:
        candidate = validate_catalog(json.loads(Path(manual).read_text()))
    else:
        if not mapping:
            raise ValueError('No verified FBA slot mapping: use evidence-bearing manual catalog')
        payload, source_hash = fetch_api()
        candidate = parse_api(payload, json.loads(Path(mapping).read_text()), datetime.now(timezone.utc).isoformat())
        candidate['sourceSha256'] = source_hash
        candidate['sourcePlayerCount'] = len(payload)
    if Path(output).exists():
        old = validate_catalog(json.loads(Path(output).read_text()))
        old_rows = {r['playerId']: r for r in old['players'] if r['status'] == 'verified'}
        for row in candidate['players']:
            if row['status'] == 'verified' and row['playerId'] in old_rows:
                if row['retrievedAt'] < old_rows[row['playerId']]['retrievedAt']:
                    raise ValueError('Catalog timestamp regressed')
                old_rows.pop(row['playerId'])
        candidate = {**candidate, 'players': [old_rows.get(row['playerId'], row) if row['status'] == 'unresolved' else row for row in candidate['players']] + [r for k, r in old_rows.items()
                      if k not in {p['playerId'] for p in candidate['players']}]}
        validate_catalog(candidate)
    atomic_write(candidate, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manual', type=Path)
    parser.add_argument('--mapping', type=Path, default=DEFAULT_MAPPING)
    parser.add_argument('--output', type=Path, default=Path('public/data/fantasy-positions.json'))
    args = parser.parse_args()
    refresh(args.output, args.manual, args.mapping)
