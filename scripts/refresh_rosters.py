"""Independent display-only ESPN roster evidence; never modifies stats or projections.

An ESPN Fantasy proTeamId association is NOT roster evidence. Require all 30
current-season roster responses; failures retain the last snapshot unchanged.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen
from espn_teams import ESPN_TEAM_ABBREVIATIONS
from refresh_stats import atomic_write

BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams'


def build_rosters(contents, retrieved_at):
    if set(contents) != set(ESPN_TEAM_ABBREVIATIONS):
        raise ValueError('All 30 roster responses required')
    players, sources = {}, []
    for team_id, content in sorted(contents.items()):
        body = json.loads(content)
        if (body.get('status') != 'success' or body.get('season', {}).get('year') != 2027
                or body.get('season', {}).get('type') != 2
                or body.get('team', {}).get('id') != str(team_id)
                or body.get('team', {}).get('abbreviation') != ESPN_TEAM_ABBREVIATIONS[team_id]
                or not isinstance(body.get('athletes'), list) or not body['athletes']):
            raise ValueError('Wrong season/team or missing roster evidence')
        source_time = datetime.fromisoformat(body.get('timestamp', '').replace('Z', '+00:00'))
        fetched_time = datetime.fromisoformat(retrieved_at.replace('Z', '+00:00'))
        if source_time.tzinfo is None or not -300 <= (fetched_time - source_time).total_seconds() <= 36 * 3600:
            raise ValueError('Stale or future roster evidence')
        source = f'{BASE}/{team_id}/roster?season=2027'
        sources.append({'url': source, 'sha256': hashlib.sha256(content).hexdigest()})
        for athlete in body['athletes']:
            player_id = athlete.get('id')
            if not isinstance(player_id, str) or not player_id.isdigit() or int(player_id) <= 0 or not athlete.get('displayName'):
                raise ValueError('Invalid ESPN roster identity')
            if player_id in players:
                raise ValueError('Ambiguous membership across rosters')
            # Roster membership includes injured players; no injury/availability inference.
            if athlete.get('status', {}).get('type') in ('retired', 'released'):
                continue
            players[player_id] = {'id': player_id, 'name': athlete['displayName'],
                'team': ESPN_TEAM_ABBREVIATIONS[team_id], 'teamId': team_id, 'source': source}
    return {'schemaVersion': 1, 'season': '2026-27', 'provider': 'ESPN NBA rosters',
            'retrievedAt': retrieved_at, 'sources': sources, 'players': list(players.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path)
    parser.add_argument('--output', type=Path, default=Path('public/data/current-rosters.json'))
    args = parser.parse_args()
    def read(team_id):
        if args.input_dir:
            return team_id, (args.input_dir / f'roster-{team_id}.json').read_bytes()
        with urlopen(Request(f'{BASE}/{team_id}/roster?season=2027', headers={'User-Agent': 'nba-fantasy-assistant'}), timeout=30) as response:
            content = response.read(2_000_001)
            if len(content) > 2_000_000:
                raise ValueError('Roster response too large')
            return team_id, content
    with ThreadPoolExecutor(max_workers=4) as pool:
        contents = dict(pool.map(read, ESPN_TEAM_ABBREVIATIONS))
    snapshot = build_rosters(contents, datetime.now(timezone.utc).isoformat())
    atomic_write(snapshot, args.output)
    print('Published display-only roster evidence:', len(snapshot['players']))


if __name__ == '__main__':
    main()
