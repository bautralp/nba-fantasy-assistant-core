"""Freshness-gated daily refresh. Exit 42 means confirmed provider lag (retry once).

Offline refresh_stats.py remains the pinned replay path. This entrypoint requires
independent ESPN evidence before changing Actual data or feeding ROS/shadow.
"""
import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from refresh_stats import SEASONS, SOURCE, build_snapshot, publish, atomic_write, parse_games
from regular_season import NBA_TEAMS, SCHEDULE_SOURCE, schedule_index

SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
LOOKBACK = 7


def download(url):
    with urlopen(Request(url, headers={'User-Agent': 'nba-fantasy-assistant'}), timeout=120) as response:
        content = response.read(50_000_001)
    if len(content) > 50_000_000:
        raise ValueError('Source exceeds size limit')
    return content


def board_days(now):
    # ESPN dates follow the US NBA calendar, including games after UTC midnight.
    end = now.astimezone(ZoneInfo('America/New_York')).date() - timedelta(days=1)
    return [end - timedelta(days=i) for i in reversed(range(LOOKBACK))]


def completed_games(board, day, ending_year):
    if not isinstance(board.get('events'), list) or len(board['events']) > 30:
        raise ValueError('Invalid or truncated ESPN scoreboard')
    result = {}
    for event in board['events']:
        season = event['season']
        if type(season['year']) is not int or type(season['type']) is not int:
            raise ValueError('Invalid ESPN season schema')
        if season['year'] != ending_year or season['type'] != 2:
            continue
        competition, = event['competitions']
        kind = (str(competition['type']['id']), competition['type']['abbreviation'])
        if kind in {('4', 'ALLSTAR'), ('39', 'CC')}:
            continue
        if kind != ('1', 'STD'):
            raise ValueError('Unknown ESPN competition type')
        teams = sorted(int(c['id']) for c in competition['competitors'])
        if len(teams) != 2 or len(set(teams)) != 2 or not set(teams) <= NBA_TEAMS:
            raise ValueError('Invalid ESPN NBA teams')
        played_on = datetime.fromisoformat(event['date'].replace('Z', '+00:00')).astimezone(ZoneInfo('America/New_York')).date()
        if played_on != day:
            raise ValueError('ESPN returned the wrong calendar day')
        state = event['status']['type']
        if type(state['completed']) is not bool:
            raise ValueError('Invalid ESPN completion schema')
        if state['completed'] is True:
            result[str(event['id'])] = {'date': day.isoformat(), 'teams': teams}
        elif state['name'] not in {'STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED'}:
            # A past-day game still scheduled/live is uncertain, never proof of lag.
            raise ValueError(f"Unsettled ESPN game {event['id']}: {state['name']}")
    return result


from projection_phase import before_regular_season, empty_regular_games


def inventory(content, ending_year, as_of, schedule):
    index = schedule_index(schedule, ending_year, as_of)
    season = next(s for s, y in SEASONS.items() if y == ending_year)
    rows = ([] if content is None else empty_regular_games(content, ending_year, as_of)) if ending_year == 2027 and before_regular_season(schedule, ending_year, as_of, index_reader=schedule_index) else parse_games(content, season, as_of, index)
    games = {g['gameId']: g['date'] for g in rows}
    counts = Counter(games.values())
    return {'sha256': hashlib.sha256(content).hexdigest() if content is not None else None, 'observationSource': 'not-published-no-expected-games' if content is None else 'published', 'games': len(games),
            'dataThrough': max(games.values(), default=None),
            'gamesByDate': dict(sorted(counts.items())), 'gameIds': sorted(games)}


def freshness(observed, index, boards, days, ending_year):
    expected = {}
    for day in days:
        expected.update(completed_games(boards[day.isoformat()], day, ending_year))
    # Union provider completions with independent finals, including older games.
    for key, game in index.items():
        if game['excluded'] is None and game['date'] <= days[-1].isoformat():
            expected.setdefault(key, {'date': game['date'], 'teams': game['teams']})
    for key, event in expected.items():
        if key in index and (index[key]['date'] != event['date'] or index[key]['teams'] != event['teams']):
            raise ValueError('Independent schedule date/team disagreement')
    missing = sorted(set(expected) - set(observed))
    # An old unplayed schedule entry outside our live window cannot be certified.
    unresolved = sorted(key for key, g in index.items()
                        if g['excluded'] == 'unplayed' and g['date'] < days[0].isoformat())
    return {'status': 'source-lag' if missing else ('unknown' if unresolved else 'verified'),
            'checkedFrom': days[0].isoformat(), 'checkedThrough': days[-1].isoformat(),
            'expectedCompletedGames': len(expected), 'missingGameIds': missing,
            'missingGamesByDate': dict(sorted(Counter(expected[k]['date'] for k in missing).items())),
            'unresolvedOlderGameIds': unresolved,
            'expectedDataThrough': max((g['date'] for g in expected.values()), default=None)}


def run(args, now):
    report = {'checkedAt': now.isoformat(), 'status': 'unknown', 'published': False,
              'newGames': None, 'sources': {}, 'previous': None}
    try:
        old = json.loads(args.output.read_text()) if args.output.exists() else None
        if old:
            report['previous'] = {'dataThrough': old['periods']['season']['dataThrough'],
                                  'games': old['coverage']['2026-27']['games'],
                                  'refreshedAt': old['refreshedAt']}
        contents, schedules = {}, {}
        for season, year in SEASONS.items():
            name=f'nba_schedule_{year}.parquet'
            schedules[season]=(args.input_dir/name).read_bytes() if args.input_dir else download(f'{SCHEDULE_SOURCE}/{name}')
        for season, year in SEASONS.items():
            name=f'player_box_{year}.parquet'
            try:contents[season]=(args.input_dir/name).read_bytes() if args.input_dir else download(f'{SOURCE}/{name}')
            except (FileNotFoundError, HTTPError) as error:
                if isinstance(error,HTTPError) and error.code!=404:raise
                if season!='2026-27' or not before_regular_season(schedules[season],year,now.date(),index_reader=schedule_index):raise
                contents[season]=None # Unknown/released source remains absent; not fabricated observations.
            report['sources'][season]=inventory(contents[season],year,now.date(),schedules[season])
            report['sources'][season]['scheduleSha256']=hashlib.sha256(schedules[season]).hexdigest()
        report['newGames'] = report['sources']['2026-27']['games'] - report['previous']['games'] if old else report['sources']['2026-27']['games']
        days = board_days(now)
        boards = {}
        for day in days:
            boards[day.isoformat()] = json.loads((args.scoreboard_dir / f'espn-{day:%Y%m%d}.json').read_bytes()
                if args.scoreboard_dir else download(f'{SCOREBOARD}?dates={day:%Y%m%d}'))
        index = schedule_index(schedules['2026-27'], 2027, now.date())
        report['freshness'] = freshness(report['sources']['2026-27']['gameIds'], index, boards, days, 2027)
        report['status'] = report['freshness']['status']
        if report['status'] != 'verified':
            return 42 if report['status'] == 'source-lag' else 1
        if before_regular_season(schedules['2026-27'], 2027, now.date(), index_reader=schedule_index):
            # Independent finals + verified future season opener establish zero
            # EXPECTED games. Keep Actual bytes/date; only cache verified inputs.
            if report['freshness']['expectedCompletedGames'] != 0:
                raise ValueError('Preseason schedule disagrees with independent regular finals')
            if args.cache_dir:
                args.cache_dir.mkdir(parents=True, exist_ok=True)
                for season, year in SEASONS.items():
                    if contents[season] is not None:(args.cache_dir / f'player_box_{year}.parquet').write_bytes(contents[season])
                    (args.cache_dir / f'nba_schedule_{year}.parquet').write_bytes(schedules[season])
            report.update(status='preseason-verified', published=False, newGames=0)
            return 0
        snapshot = build_snapshot(contents, now.date(), now.isoformat(), schedules)
        current = snapshot['coverage']['2026-27']['games']
        report['candidate'] = {'dataThrough': snapshot['periods']['season']['dataThrough'], 'games': current}
        report['newGames'] = current - report['previous']['games'] if old else current
        # publish retains all existing regression/atomic-write checks. No cache on lag.
        publish(snapshot, args.output)
        if args.cache_dir:
            args.cache_dir.mkdir(parents=True, exist_ok=True)
            for season, year in SEASONS.items():
                if contents[season] is not None:(args.cache_dir / f'player_box_{year}.parquet').write_bytes(contents[season])
                (args.cache_dir / f'nba_schedule_{year}.parquet').write_bytes(schedules[season])
        report.update(status='updated' if report['newGames'] > 0 else 'no-new-games', published=True)
        return 0
    except Exception as error:
        report.update(status='unknown', error=f'{type(error).__name__}: {error}')
        return 1
    finally:
        # Report failure/lag separately; never overwrite the last verified public data.
        atomic_write(report, args.report)
        print(json.dumps({k: v for k, v in report.items() if k != 'sources'}, ensure_ascii=False, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('public/data/player-stats.json'))
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--input-dir', type=Path)
    parser.add_argument('--scoreboard-dir', type=Path)
    parser.add_argument('--now', type=datetime.fromisoformat, help='Pinned aware time for offline replay only')
    args = parser.parse_args()
    if args.input_dir is not None or args.scoreboard_dir is not None or args.now is not None:
        if not (args.input_dir and args.scoreboard_dir and args.now and args.now.tzinfo):
            parser.error('Offline replay requires --input-dir, --scoreboard-dir and aware --now together')
    raise SystemExit(run(args, args.now or datetime.now(timezone.utc)))


if __name__ == '__main__':
    main()
