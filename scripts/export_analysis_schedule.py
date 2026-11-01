"""Export only the NBA schedule bytes used by the current ROS snapshot.

This does not regenerate Actual/ROS. A failed export preserves the prior file;
the consumer rejects it if its SHA/date no longer match ROS.
"""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
from regular_season import schedule_index, SCHEDULE_SOURCE, NBA_TEAMS
from refresh_stats import atomic_write


def build(content, projections, retrieved_at):
    year = int(projections['season'][:4]) + 1
    url = f'{SCHEDULE_SOURCE}/nba_schedule_{year}.parquet'
    sha = hashlib.sha256(content).hexdigest()
    if not any(s['url'] == url and s['sha256'] == sha for s in projections['sources']):
        raise ValueError('Schedule SHA does not match ROS source; existing output retained')
    index = schedule_index(content, year, date(year, 6, 30))
    games = [dict(id=key, date=g['date'], teamIds=g['teams']) for key, g in index.items()
             if g['date'] > projections['asOf'] and g['excluded'] in (None, 'unplayed') and set(g['teams']) <= NBA_TEAMS]
    if not games:
        raise ValueError('No observed remaining schedule; no season total can be established')
    counts = {str(t): sum(t in g['teamIds'] for g in games) for t in range(1, 31)}
    if counts != projections['scheduleRemaining']:
        raise ValueError('Schedule counts do not match ROS')
    return dict(schemaVersion=1, seasonId=year, asOf=projections['asOf'],
                through=max(g['date'] for g in games), retrievedAt=retrieved_at,
                source=dict(url=url, sha256=sha), scope='observed-regular-season',
                games=sorted(games, key=lambda g: (g['date'], g['id'])))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--projections', type=Path, default=Path('public/data/player-projections.json'))
    p.add_argument('--output', type=Path, default=Path('public/data/analysis-schedule.json'))
    args = p.parse_args()
    result = build(args.input.read_bytes(), json.loads(args.projections.read_text()), datetime.now(timezone.utc).isoformat())
    atomic_write(result, args.output)
    print('Analysis schedule:', len(result['games']), 'observed games; through', result['through'])


if __name__ == '__main__':
    main()
