"""Walk-forward 2025-26 evaluation; no invented 2024-25 history.

First half of training simulates historical evidence, second half current role.
This is a within-season diagnostic, not a true two-season holdout evaluation.
"""
import argparse
import hashlib
from collections import defaultdict
from datetime import date, datetime, timezone, timedelta
import json
from pathlib import Path
from statistics import mean
from refresh_stats import atomic_write
from regular_season import schedule_index
from ros_model import CONFIG, projection_games, project, summary

CUTS = ['2025-12-01', '2026-01-15', '2026-03-01']
METRICS = ['MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO']


def evaluate(games, cuts=CUTS):
    report = []
    by_id = defaultdict(list)
    for g in games: by_id[g['id']].append(g)
    for cutoff in cuts:
        end = (date.fromisoformat(cutoff) + timedelta(days=30)).isoformat()
        errors = {name: {key: [] for key in METRICS} for name in ('seasonAverage', 'twoWindowWeighted', 'minutesBased', 'minutesAndRole')}
        players = 0
        for rows in by_id.values():
            rows = sorted(rows, key=lambda g: (g['date'], g['gameId']))
            train = [g for g in rows if g['date'] <= cutoff]
            future = [g for g in rows if cutoff < g['date'] <= end]
            if len(train) < 10 or len(future) < 5: continue
            split = len(train) // 2
            previous, current = train[:split], train[split:]
            base, target = summary(train), summary(future)
            minutes = project(previous, current, use_role=False)
            role = project(previous, current, use_role=True)
            if minutes['status'] != 'available' or role['status'] != 'available': continue
            players += 1
            w = sum(g['minutes'] for g in current) / (sum(g['minutes'] for g in current) + 500)
            predictions = {
                'seasonAverage': {'MIN': base['mpg'], **{k: sum(g['stats'][k] for g in train) / len(train) for k in METRICS if k != 'MIN'}},
                'twoWindowWeighted': {'MIN': w * summary(current)['mpg'] + (1-w) * summary(previous)['mpg'], **{
                    k: w * mean(g['stats'][k] for g in current) + (1-w) * mean(g['stats'][k] for g in previous) for k in METRICS if k != 'MIN'}},
                'minutesBased': {'MIN': minutes['minutes'], **minutes['stats']},
                'minutesAndRole': {'MIN': role['minutes'], **role['stats']},
            }
            truth = {'MIN': target['mpg'], **{k: mean(g['stats'][k] for g in future) for k in METRICS if k != 'MIN'}}
            for name, values in predictions.items():
                for key in METRICS: errors[name][key].append(abs(values[key] - truth[key]))
        report.append({'cutoff': cutoff, 'testThrough': end, 'players': players,
                       'mae': {name: {k: mean(v) if v else None for k, v in metrics.items()} for name, metrics in errors.items()}})
    return {'schemaVersion': 1, 'method': '2025-26 within-season chronological pseudo-history; future 30 calendar days; >=10 training and >=5 held-out games',
            'limitation': 'No 2024-25 data. twoWindowWeighted is a proxy, not a validated two-season model. Parameters are initial choices, not tuned on holdouts. No claim of improvement.',
            'results': report}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input-dir', type=Path, required=True)
    p.add_argument('--output', type=Path, default=Path('docs/stage-14-backtest.json'))
    args = p.parse_args()
    as_of = date(2026, 10, 22)
    schedule = schedule_index((args.input_dir / 'nba_schedule_2026.parquet').read_bytes(), 2026, as_of)
    games = projection_games((args.input_dir / 'player_box_2026.parquet').read_bytes(), '2025-26', as_of, schedule)
    result = evaluate(games)
    result['parameters'] = CONFIG
    result['inputSha256'] = {name: hashlib.sha256((args.input_dir / name).read_bytes()).hexdigest() for name in ('player_box_2026.parquet', 'nba_schedule_2026.parquet')}
    atomic_write(result, args.output)
    print(json.dumps(result, indent=2))
