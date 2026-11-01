"""Convert SportsDataverse ESPN NBA regular-season box scores to a static snapshot.

No dependency on the draft/import engine. A failed run never replaces the snapshot.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from parquet_io import read_parquet
from urllib.request import Request, urlopen
from regular_season import SCHEDULE_SOURCE, schedule_index, coverage

SOURCE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_player_boxscores'
SEASONS = {'2026-27': 2027, '2025-26': 2026}  # Provider uses ENDING years.
FIELDS = {
    'FGM': 'field_goals_made', 'FGA': 'field_goals_attempted',
    'FTM': 'free_throws_made', 'FTA': 'free_throws_attempted',
    '3PM': 'three_point_field_goals_made', 'PTS': 'points', 'REB': 'rebounds',
    'AST': 'assists', 'STL': 'steals', 'BLK': 'blocks', 'TO': 'turnovers',
}
REQUIRED = set(FIELDS.values()) | {'game_id', 'season', 'season_type', 'game_date',
    'athlete_id', 'athlete_display_name', 'did_not_play', 'team_abbreviation',
    'athlete_position_abbreviation', 'minutes', 'team_id', 'opponent_team_id'}


def parse_games(content, season, as_of, schedule):
    table = read_parquet(content)
    if not REQUIRED.issubset(table.column_names):
        raise ValueError('Source schema changed: required columns missing')
    games = {}
    start = date(SEASONS[season] - 1, 7, 1)
    end = date(SEASONS[season], 7, 1)
    for record in table.to_pylist():
        row = {key: '' if value is None else str(value) for key, value in record.items()}
        if row['season'] != str(SEASONS[season]):
            raise ValueError('Unexpected source season')
        if row['season_type'] != '2':  # Exclude preseason, postseason and play-in.
            continue
        played_on = date.fromisoformat(row['game_date'])
        if not start <= played_on < end:
            raise ValueError('Game date outside source season')
        if played_on > as_of:
            continue
        event = schedule.get(row['game_id'])
        if event is None:
            raise ValueError('Box score game missing from schedule')
        if event['excluded']:
            continue
        if event['date'] != played_on.isoformat() or sorted([int(row['team_id']), int(row['opponent_team_id'])]) != event['teams']:
            raise ValueError('Box score does not match schedule date/teams')
        if row['did_not_play'].lower() not in ('true', 'false'):
            raise ValueError('Unknown did_not_play flag')
        if row['did_not_play'].lower() == 'true':
            continue
        # ESPN occasionally emits blank placeholders (even with did_not_play=false).
        # No recorded minutes and all-zero stats is not evidence of a game played.
        if not row['minutes'].strip() and all(row[k] == '0' for k in FIELDS.values()):
            continue
        minutes = float(row['minutes'])
        if not math.isfinite(minutes) or minutes < 0:
            raise ValueError('Invalid minutes')
        if not all(row[k].strip() for k in ('athlete_id', 'athlete_display_name', 'game_id', 'team_abbreviation')):
            raise ValueError('Missing player/game identity')
        stats = {}
        for key, field in FIELDS.items():
            value = float(row[field])  # Missing stats are never silently converted to zero.
            if not math.isfinite(value) or value < 0 or not value.is_integer():
                raise ValueError(f'Invalid {field}')
            stats[key] = int(value)
        if stats['FGM'] > stats['FGA'] or stats['FTM'] > stats['FTA'] or stats['3PM'] > stats['FGM']:
            raise ValueError('Impossible shooting totals')
        game = {'id': row['athlete_id'], 'name': row['athlete_display_name'].strip(),
                'date': played_on.isoformat(), 'gameId': row['game_id'], 'teamId': int(row['team_id']),
                'team': row['team_abbreviation'], 'position': row['athlete_position_abbreviation'], 'minutes': minutes, 'stats': stats}
        key = (game['id'], game['gameId'])
        if key in games and games[key] != game:
            raise ValueError('Conflicting duplicate player/game')
        games[key] = game
    if not games:
        raise ValueError(f'No completed regular-season player games for {season}')
    return sorted(games.values(), key=lambda g: (g['date'], g['gameId'], g['id']))


def calendar_window(games, start, end):
    return [g for g in games if start.isoformat() <= g['date'] <= end.isoformat()]


def aggregate(games):
    players = {}
    for game in games:
        player = players.setdefault(game['id'], {'id': game['id'], 'gp': 0,
            'totals': dict.fromkeys(FIELDS, 0), 'minutes': 0})
        player.update(name=game['name'], team=game['team'], position=game['position'])
        player['gp'] += 1
        player['minutes'] += game['minutes']
        for key in FIELDS:
            player['totals'][key] += game['stats'][key]
    for player in players.values():
        player['mpg'] = player.pop('minutes') / player['gp'] if player['gp'] else 0
        totals = player['totals']
        player['stats'] = {key: value / player['gp'] for key, value in totals.items()}
        player['stats']['FG%'] = totals['FGM'] / totals['FGA'] * 100 if totals['FGA'] else None
        player['stats']['FT%'] = totals['FTM'] / totals['FTA'] * 100 if totals['FTA'] else None
    return sorted(players.values(), key=lambda p: (p['name'].casefold(), p['id']))


def build_snapshot(contents, as_of, refreshed_at, schedule_contents):
    indexes = {season: schedule_index(schedule_contents[season], year, as_of) for season, year in SEASONS.items()}
    seasons = {season: parse_games(contents[season], season, as_of, indexes[season]) for season in SEASONS}
    reports = {season: coverage(seasons[season], indexes[season], year, as_of) for season, year in SEASONS.items()}
    periods = {}
    for key, season, days in [('season', '2026-27', None), ('last7', '2026-27', 7),
                              ('last14', '2026-27', 14), ('last30', '2026-27', 30),
                              ('lastSeason', '2025-26', None)]:
        start = (as_of - timedelta(days=days - 1)) if days else date(SEASONS[season] - 1, 7, 1)
        games = calendar_window(seasons[season], start, as_of)
        periods[key] = {'season': season, 'from': start.isoformat(), 'to': (as_of if days else min(as_of, date(SEASONS[season], 6, 30))).isoformat(),
            'dataThrough': max((g['date'] for g in games), default=None), 'players': aggregate(games)}
    return {'schemaVersion': 1, 'provider': 'SportsDataverse', 'refreshedAt': refreshed_at,
            'asOf': as_of.isoformat(), 'filterVersion': 2, 'coverage': reports, 'unit': 'perGame', 'seasonType': 'regular',
            'sources': [{'season': season, 'url': f'{SOURCE}/player_box_{year}.parquet',
                         'sha256': hashlib.sha256(contents[season]).hexdigest()}
                        for season, year in SEASONS.items()] + [
                {'season': season, 'url': f'{SCHEDULE_SOURCE}/nba_schedule_{year}.parquet',
                 'sha256': hashlib.sha256(schedule_contents[season]).hexdigest()} for season, year in SEASONS.items()], 'periods': periods}


def publish(snapshot, output):
    """Validate regressions before a single atomic replacement; preserve bytes on error."""
    output = Path(output)
    if output.exists():
        old = json.loads(output.read_text())
        if snapshot['asOf'] < old['asOf']:
            raise ValueError('Refusing to replace a newer snapshot')
        for key, period in snapshot['periods'].items():
            previous = old['periods'][key]
            # Rolling windows naturally expire; season coverage must never go backwards.
            if key in ('season', 'lastSeason') and previous['dataThrough']:
                if not period['dataThrough'] or period['dataThrough'] < previous['dataThrough']:
                    raise ValueError('Source coverage regressed')
                counts = {p['id']: p['gp'] for p in period['players']}
                if any(counts.get(p['id'], 0) < p['gp'] for p in previous['players']):
                    raise ValueError('Source lost previously published player games')
    atomic_write(snapshot, output)


def atomic_write(snapshot, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=output.parent, delete=False) as file:
            temporary = file.name
            json.dump(snapshot, file, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, help='Use previously downloaded provider Parquet files')
    parser.add_argument('--cache-dir', type=Path, help='Save validated source bytes for the projection stage')
    parser.add_argument('--as-of', type=date.fromisoformat, help='Pinned calendar date for offline fixture replay only')
    parser.add_argument('--output', type=Path, default=Path('public/data/player-stats.json'))
    args = parser.parse_args()
    if args.as_of is not None and args.input_dir is None:
        parser.error('--as-of requires --input-dir; live downloads always use the current UTC date')
    now = datetime.now(timezone.utc)
    contents = {}
    schedules = {}
    for season, year in SEASONS.items():
        if args.input_dir:
            contents[season] = (args.input_dir / f'player_box_{year}.parquet').read_bytes()
        else:
            request = Request(f'{SOURCE}/player_box_{year}.parquet', headers={'User-Agent': 'nba-fantasy-assistant'})
            with urlopen(request, timeout=120) as response:
                contents[season] = response.read(50_000_001)
                if len(contents[season]) > 50_000_000:
                    raise ValueError('Source exceeds size limit')
    for season, year in SEASONS.items():
        if args.input_dir:
            schedules[season] = (args.input_dir / f'nba_schedule_{year}.parquet').read_bytes()
        else:
            with urlopen(Request(f'{SCHEDULE_SOURCE}/nba_schedule_{year}.parquet', headers={'User-Agent': 'nba-fantasy-assistant'}), timeout=120) as response:
                schedules[season] = response.read(50_000_001)
                if len(schedules[season]) > 50_000_000:
                    raise ValueError('Schedule exceeds size limit')
    snapshot = build_snapshot(contents, args.as_of or now.date(), now.isoformat(), schedules)
    if args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        for season, year in SEASONS.items():
            (args.cache_dir / f'player_box_{year}.parquet').write_bytes(contents[season])
            (args.cache_dir / f'nba_schedule_{year}.parquet').write_bytes(schedules[season])
    publish(snapshot, args.output)
    print('Published:', {key: len(period['players']) for key, period in snapshot['periods'].items()})


if __name__ == '__main__':
    main()
