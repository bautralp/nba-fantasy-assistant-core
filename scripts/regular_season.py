"""Join ESPN schedule metadata before aggregating player box scores."""
from collections import Counter
import re
from parquet_io import read_parquet

SCHEDULE_SOURCE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_schedules'
NBA_TEAMS = frozenset(range(1, 31))  # ESPN franchise IDs, including Philadelphia (20).
REQUIRED = {'game_id', 'season', 'season_type', 'game_date', 'type_id',
            'type_abbreviation', 'notes_headline', 'home_id', 'away_id', 'status_type_completed'}


def schedule_index(content, ending_year, as_of, historical_exhibitions=False):
    table = read_parquet(content)
    if not REQUIRED <= set(table.column_names):
        raise ValueError('Schedule schema changed: required columns missing')
    index = {}
    for row in table.select(sorted(REQUIRED)).to_pylist():
        if row['season'] != ending_year:
            raise ValueError('Unexpected schedule season')
        if row['season_type'] != 2 or row['game_date'] > as_of:
            continue
        notes = (row['notes_headline'] or '').lower()
        kind = (row['type_id'], row['type_abbreviation'])
        if kind == (4, 'ALLSTAR') or 'all-star' in notes or 'all star' in notes:
            reason = 'allStar'
        elif historical_exhibitions and notes.strip() == 'rising stars' and row['home_id'] not in NBA_TEAMS and row['away_id'] not in NBA_TEAMS:
            reason = 'risingStars'
        elif kind == (39, 'CC') or re.search(r'\bcup\b.*\b(championship|final)\b', notes):
            reason = 'cupFinal'
        elif kind != (1, 'STD'):
            raise ValueError(f"Unrecognized competition type for game {row['game_id']}: {kind}")
        elif row['status_type_completed'] is not True:
            reason = 'unplayed'
        else:
            if row['home_id'] not in NBA_TEAMS or row['away_id'] not in NBA_TEAMS or row['home_id'] == row['away_id']:
                raise ValueError('Standard competition has unknown NBA teams')
            reason = None  # Group play, quarterfinals and semifinals count normally.
        game = {'date': row['game_date'].isoformat(), 'teams': sorted([row['home_id'], row['away_id']]), 'excluded': reason}
        key = str(row['game_id'])
        if key in index and index[key] != game:
            raise ValueError('Conflicting duplicate schedule game')
        index[key] = game
    return index


def coverage(games, index, ending_year, as_of):
    observed = {g['gameId'] for g in games}
    expected = {key for key, game in index.items() if game['excluded'] is None}
    if observed != expected:
        raise ValueError(f'Schedule/box coverage mismatch: missing={len(expected-observed)}, extra={len(observed-expected)}')
    pairs = {(g['gameId'], g['teamId']) for g in games}
    expected_pairs = {(key, team) for key in expected for team in index[key]['teams']}
    if pairs != expected_pairs:
        raise ValueError('Missing team side in player box scores')
    teams = Counter(team for key in observed for team in index[key]['teams'])
    if len(observed) > 1230 or any(count > 82 for count in teams.values()):
        raise ValueError('Regular-season schedule exceeds 1230 games / 82 per team')
    # Completed seasons must have full NBA coverage, including every franchise.
    complete = as_of.isoformat() >= f'{ending_year}-07-01'
    if complete and (len(observed) != 1230 or set(teams) != NBA_TEAMS or set(teams.values()) != {82}):
        raise ValueError('Completed NBA season must contain 1230 games and 30 teams with 82 games each')
    return {'games': len(observed), 'teamGames': {str(team): teams[team] for team in sorted(teams)},
            'complete': complete,
            'excludedGames': {key: g['excluded'] for key, g in sorted(index.items()) if g['excluded'] in ('allStar', 'cupFinal')}}
