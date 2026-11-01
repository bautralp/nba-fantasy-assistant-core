"""Read-only position/record schema probe; output aggregates, never identities or payloads."""
import argparse
from collections import Counter
import json
from urllib.request import urlopen
from urllib.error import HTTPError


def probe(league_id, season):
    if league_id <= 0 or not 2018 <= season <= 2100:
        raise ValueError('Invalid league/season')
    url = f'https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/{season}/segments/0/leagues/{league_id}?view=mSettings&view=mTeam&view=mRoster&view=mStandings&view=mStatus'
    with urlopen(url, timeout=30) as response:
        body = response.read(5 * 1024 * 1024 + 1)
    if len(body) > 5 * 1024 * 1024:
        raise ValueError('Response exceeds probe size limit')
    league = json.loads(body)
    if league.get('id') != league_id or league.get('seasonId') != season or league.get('settings', {}).get('isPublic') is not True:
        raise ValueError('Expected anonymous public league response')
    players = [entry['playerPoolEntry']['player'] for team in league['teams'] for entry in team.get('roster', {}).get('entries', [])]
    def primary(player):
        value = player.get('defaultPositionId')
        return value if type(value) is int and 1 <= value <= 5 else None
    defaults = Counter(str(primary(player)) if primary(player) is not None else 'unknown' for player in players)
    return {
        'season': season, 'teams': len(league['teams']), 'rosterEntries': len(players),
        'defaultPositionIdCounts': dict(defaults),
        'primaryMatchesSpecificSlot': sum(primary(player) is not None and primary(player) - 1 in (player.get('eligibleSlots') or []) for player in players),
        'multipleSpecificEligibilities': sum(sum(slot in (player.get('eligibleSlots') or []) for slot in range(5)) > 1 for player in players),
        'recordOverallFields': sorted(set().union(*(team.get('record', {}).get('overall', {}) for team in league['teams']))),
        'rankFieldNames': sorted({key for team in league['teams'] for key in team if 'rank' in key.lower() or 'seed' in key.lower()}),
        'allRecordsZero': all(all(team.get('record', {}).get('overall', {}).get(key) == 0 for key in ['wins', 'losses', 'ties']) for team in league['teams']),
        'privatePayloadWritten': False,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('league_id', type=int)
    parser.add_argument('season', type=int)
    args = parser.parse_args()
    try:
        print(json.dumps(probe(args.league_id, args.season), indent=2, sort_keys=True))
    except HTTPError as error:
        raise SystemExit(f'Anonymous ESPN read failed: HTTP {error.code}') from None
