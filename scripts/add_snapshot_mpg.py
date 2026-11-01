"""Add only MPG, replaying the exact published source bytes and timestamps.

Reject any non-MPG difference. Not a general snapshot migration or GP override.
"""
import argparse
from copy import deepcopy
from datetime import date
import hashlib
import json
from pathlib import Path
from refresh_stats import SEASONS, build_snapshot, atomic_write


def without_mpg(snapshot):
    result = deepcopy(snapshot)
    for period in result['periods'].values():
        for player in period['players']:
            player.pop('mpg', None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('public/data/player-stats.json'))
    args = parser.parse_args()
    old = json.loads(args.output.read_bytes())
    for source in old['sources']:
        content = (args.input_dir / source['url'].split('/')[-1]).read_bytes()
        if hashlib.sha256(content).hexdigest() != source['sha256']:
            raise ValueError('Published source SHA-256 mismatch')
    boxes = {s: (args.input_dir / f'player_box_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
    schedules = {s: (args.input_dir / f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
    candidate = build_snapshot(boxes, date.fromisoformat(old['asOf']), old['refreshedAt'], schedules)
    if without_mpg(candidate) != without_mpg(old):
        raise ValueError('Refusing non-MPG changes')
    atomic_write(candidate, args.output)
    print('Only MPG added; all source hashes, dates, GP and statistics preserved.')


if __name__ == '__main__':
    main()
