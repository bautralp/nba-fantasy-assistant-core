"""Audit a TEAM-only projection change, including all metadata and numeric fields."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from refresh_projection_team_labels import update_labels, without_teams


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def audit(before, after, catalog):
    if without_teams(before) != without_teams(after):
        raise ValueError('Non-team projection fields changed')
    if update_labels(before, catalog) != after:
        raise ValueError('Team changes do not match verified current catalog resolver')
    zero = [p for p in after['players'] if p['role']['current']['gp'] == 0]
    eligibility = {p['playerId']: p for p in catalog['players']}
    changes = [{'id': a['id'], 'name': a['name'], 'before': a['team'], 'after': b['team'], 'proTeamId': eligibility[a['id']]['proTeamId']}
               for a, b in zip(before['players'], after['players']) if a['team'] != b['team']]
    unknown = []
    for p in zero:
        if p['team'] != 'Unknown': continue
        cat = eligibility.get(p['id'])
        reason = ('missing-catalog-player' if cat is None else 'proTeamId-zero' if cat.get('proTeamId') == 0
                  else 'name-mismatch' if cat['name'].casefold() != p['name'].casefold()
                  else 'unverified-or-invalid-current-team')
        unknown.append({'id': p['id'], 'name': p['name'], 'reason': reason})
    return {'schemaVersion': 1, 'asOf': before['asOf'], 'players': len(after['players']),
            'zeroGP': len(zero), 'changedTeams': len(changes), 'stillUnknown': len(unknown),
            'unknownReasons': dict(Counter(p['reason'] for p in unknown)),
            'statuses': dict(Counter(p['status'] for p in after['players'])),
            'unchangedExceptTeamSha256': fingerprint(without_teams(before)),
            'afterExceptTeamSha256': fingerprint(without_teams(after)),
            'changes': changes, 'unknownPlayers': unknown}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, default=Path('public/data/player-projections.json'))
    parser.add_argument('--catalog', type=Path, default=Path('public/data/fantasy-positions.json'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(*(json.loads(p.read_text()) for p in (args.before, args.after, args.catalog)))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k not in ('changes', 'unknownPlayers')}))
