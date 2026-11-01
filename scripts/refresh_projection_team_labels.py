"""Apply display labels to an existing snapshot without changing any other field.

The daily generator uses the same resolver. This one-time migration avoids
bundling unrelated metadata refreshes into the display correction.
"""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import tempfile

from espn_teams import catalog_team_name
from fantasy_positions import validate_catalog
from generate_projections import publish
from refresh_stats import atomic_write


def without_teams(snapshot):
    result = deepcopy(snapshot)
    for row in result['players']:
        row.pop('team', None)
    return result


def update_labels(snapshot, catalog):
    validate_catalog(catalog)
    eligibility = {p['playerId']: p for p in catalog['players']}
    result = deepcopy(snapshot)
    for row in result['players']:
        if row['role']['current']['gp'] != 0:
            continue
        pos = eligibility.get(row['id'])
        if pos and pos['name'].casefold() != row['name'].casefold():
            pos = None
        row['team'] = catalog_team_name(row['id'], pos)
    return result


def refresh(output, catalog_path):
    output = Path(output)
    before = json.loads(output.read_text())
    candidate = update_labels(before, json.loads(Path(catalog_path).read_text()))
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)/'candidate.json'
        # Normal TS parser/ranking validation still runs. Refuse publication if
        # even one non-team field changes, including metadata and ranking ties.
        publish(candidate, path)
        after = json.loads(path.read_text())
        if without_teams(before) != without_teams(after):
            raise ValueError('Team-only migration changed non-team fields')
        atomic_write(after, output)
    print('Team labels changed:', sum(a['team'] != b['team'] for a, b in zip(before['players'], after['players'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('public/data/player-projections.json'))
    parser.add_argument('--catalog', type=Path, default=Path('public/data/fantasy-positions.json'))
    args = parser.parse_args()
    refresh(args.output, args.catalog)
