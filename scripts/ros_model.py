"""Chronological minutes/rate shrinkage model. All parameters live in JSON.

Missing starter/3PA are unknown, never fabricated. Shooting requires 3PA.
"""
from collections import defaultdict
import json
import math
from pathlib import Path
from statistics import mean
from parquet_io import read_parquet
from refresh_stats import parse_games
from regular_season import schedule_index, NBA_TEAMS

CONFIG = json.loads(Path(__file__).with_name('projection-config.json').read_text())


def projection_games(content, season, as_of, schedule):
    table = read_parquet(content)
    if 'three_point_field_goals_attempted' not in table.column_names:
        raise ValueError('Projection source schema changed: 3PA column missing')
    games = parse_games(content, season, as_of, schedule)
    raw = {}
    accepted = {(g['id'], g['gameId']) for g in games}
    for row in table.to_pylist():
        key = (str(row['athlete_id']), str(row['game_id']))
        if key not in accepted or row['did_not_play'] is True:
            continue
        if row['minutes'] is None and all(row[field] == 0 for field in ('field_goals_made', 'field_goals_attempted', 'points')):
            continue
        fields = ('minutes', 'starter', 'three_point_field_goals_attempted')
        if key in raw and any(raw[key].get(field) != row.get(field) for field in fields):
            raise ValueError('Conflicting duplicate role/shot record')
        raw[key] = row
    for game in games:
        row = raw[(game['id'], game['gameId'])]
        starter = row.get('starter')
        if starter is not None and starter not in (True, False, 0, 1):
            raise ValueError('Unknown starter value')
        game.update(minutes=row['minutes'], starter=None if starter is None else bool(starter),
                    opponentTeamId=row['opponent_team_id'])
        attempts = row.get('three_point_field_goals_attempted')
        if attempts is not None:
            if not math.isfinite(attempts) or attempts < game['stats']['3PM'] or attempts > game['stats']['FGA']:
                raise ValueError('Invalid 3PA')
            game['stats']['3PA'] = attempts
    volumes = defaultdict(float)
    for game in games: volumes[(game['gameId'], game['teamId'])] += game['stats']['FGA']
    for game in games:
        volume = volumes[(game['gameId'], game['teamId'])]
        game['teamShotShare'] = game['stats']['FGA'] / volume if volume else None
    return games


def summary(games):
    minutes = sum(g['minutes'] for g in games)
    starters = [g['starter'] for g in games if g['starter'] is not None]
    totals = {key: sum(g['stats'].get(key, 0) for g in games) for key in ('FGM', 'FGA', '3PM', '3PA', 'FTM', 'FTA', 'REB', 'AST', 'STL', 'BLK', 'TO')}
    totals['2PA'] = totals['FGA'] - totals['3PA']
    totals['2PM'] = totals['FGM'] - totals['3PM']
    return {'gp': len(games), 'minutes': minutes, 'mpg': minutes / len(games) if games else None,
            'starterRate': mean(starters) if starters else None,
            'rates': {k: v / minutes if minutes else 0 for k, v in totals.items()}, 'totals': totals, 'teamShotShare': mean([g['teamShotShare'] for g in games if g.get('teamShotShare') is not None]) if any(g.get('teamShotShare') is not None for g in games) else None}


def role_model(previous, current, config=CONFIG):
    p, c = summary(previous), summary(current)
    team_change = bool(current and previous and current[-1]['teamId'] != previous[-1]['teamId']) or len({g['teamId'] for g in current}) > 1
    stint = []
    for game in reversed(current):
        if game['teamId'] != current[-1]['teamId']:
            break
        stint.append(game)
    recent = list(reversed(stint))[-10:]
    r, five = summary(recent), summary(recent[-5:])
    # Compare recent role against history preceding the recent window (or last year).
    prior = summary(current[:-len(recent)]) if len(current) > len(recent) else p
    cfg = config['role']
    baseline = prior['mpg']
    delta = r['mpg'] - baseline if baseline is not None and r['mpg'] is not None else 0
    persistence = mean([(g['minutes'] - baseline) * (1 if delta >= 0 else -1) >= cfg['minutesDelta'] * cfg['persistenceDeltaFraction'] for g in recent]) if recent and baseline is not None else 0
    eligible = len(recent) >= cfg['minimumGames'] and persistence >= cfg['persistence']
    minute_signal = max(-1, min(1, delta / cfg['minutesDelta'])) if eligible and abs(delta) >= cfg['minutesDelta'] else 0
    starter_delta = r['starterRate'] - prior['starterRate'] if r['starterRate'] is not None and prior['starterRate'] is not None else 0
    starter_values = [g['starter'] for g in recent if g['starter'] is not None]
    starter_persistent = bool(starter_values) and mean([x == (starter_delta > 0) for x in starter_values]) >= cfg['persistence']
    starter_signal = max(-1, min(1, starter_delta / cfg['starterDelta'])) if len(recent) >= cfg['minimumGames'] and starter_persistent and abs(starter_delta) >= cfg['starterDelta'] else 0
    # Offensive proxies are FGA/min, FTA/min, AST/min, TO/min, never USG%.
    usage = lambda s: s['rates']['FGA'] + cfg['freeThrowProxyWeight'] * s['rates']['FTA'] + s['rates']['TO']
    offense_delta = usage(r) / usage(prior) - 1 if usage(prior) else 0
    offense_persistent = mean([((g['stats']['FGA'] + cfg['freeThrowProxyWeight'] * g['stats']['FTA'] + g['stats']['TO']) / g['minutes'] - usage(prior)) * (1 if offense_delta > 0 else -1) > 0 for g in recent if g['minutes'] > 0]) if any(g['minutes'] > 0 for g in recent) else 0
    offense_signal = max(-1, min(1, offense_delta / cfg['offenseDelta'])) if len(recent) >= cfg['minimumGames'] and offense_persistent >= cfg['persistence'] and abs(offense_delta) >= cfg['offenseDelta'] else 0
    strength = min(1, len(recent) / cfg['sampleGames'])
    weights = cfg['scoreWeights']
    score = strength * (weights['minutes'] * minute_signal + weights['starter'] * starter_signal + weights['offense'] * offense_signal)
    labels = []
    if minute_signal: labels.append('Dakika artışı' if minute_signal > 0 else 'Rol daralması')
    if starter_signal: labels.append('İlk beşe yükselme' if starter_signal > 0 else 'İlk beşten çıkma')
    if offense_signal: labels.append('Hücum sorumluluğu artışı' if offense_signal > 0 else 'Hücum sorumluluğu azalışı')
    if team_change: labels.append('Yeni takım' + (' / yetersiz örneklem' if len(stint) < cfg['sampleGames'] else ''))
    return {'score': score, 'strength': strength if any((minute_signal, starter_signal, offense_signal)) else 0, 'labels': labels or ['Belirgin değişim yok'],
            'teamChange': team_change, 'newTeamGames': len(stint), 'persistence': persistence,
            'minutesDelta': delta, 'starterDelta': starter_delta, 'offenseProxyDelta': offense_delta,
            'previous': p, 'current': c, 'last5': five, 'last10': r}


def project(previous, current, config=CONFIG, use_role=True, profile=None, rookie_parameters=None):
    previous, current = sorted(previous, key=lambda g: (g['date'], g['gameId'])), sorted(current, key=lambda g: (g['date'], g['gameId']))
    role = role_model(previous, current, config)
    if profile is not None or rookie_parameters is not None:
        from rookie_model import rookie_project
        result, provenance = rookie_project(profile, previous, current, rookie_parameters or {'enabled': False}, role, use_role)
        if result is not None: return result
    p, c = summary(previous), summary(current)
    if p['gp'] + c['gp'] < config['minimumGames'] or p['minutes'] + c['minutes'] < config['minimumMinutes']:
        return {'status': 'unavailable', 'reason': 'Yetersiz bireysel NBA örneklemi', 'role': role, 'confidence': 'low', 'stats': None, 'minutes': None}
    if any('3PA' not in g['stats'] for g in previous + current):
        return {'status': 'unavailable', 'reason': 'Kaynakta 3PA yok', 'role': role, 'confidence': 'low', 'stats': None, 'minutes': None}
    # No previous season: individual current-season evidence only, explicitly low confidence.
    prior_reliability = min(1, p['minutes'] / config['minutesK'])
    w = c['minutes'] / (c['minutes'] + config['minutesK'] * prior_reliability) if c['minutes'] else 0
    mpg = w * (c['mpg'] or 0) + (1 - w) * (p['mpg'] or 0)
    strength = role['strength'] if use_role and abs(role['score']) > 0 else 0
    recent = role['last10']
    rw = config['role']['recentMinutesWeight'] * strength
    mpg = min(config['role']['maxMinutes'], max(0, (1 - rw) * mpg + rw * (recent['mpg'] or mpg)))
    rates = {}
    for key, k in config['rateK'].items():
        reliability = min(1, p['minutes'] / k)
        weight = c['minutes'] / (c['minutes'] + k * reliability) if c['minutes'] else 0
        rate = weight * c['rates'][key] + (1 - weight) * p['rates'][key]
        # Offensive rate adjustment only; defensive rates/rebounds are not multiplied.
        rr = config['role']['recentRateWeight'] * strength if key in ('2PA', '3PA', 'FTA', 'AST', 'TO') else 0
        rates[key] = (1 - rr) * rate + rr * recent['rates'][key]
    shots = {}
    for kind, k in config['shootingAttemptsK'].items():
        made, attempted = ('FTM', 'FTA') if kind == 'FT' else (kind + 'M', kind + 'A')
        pa, ca = p['totals'][attempted], c['totals'][attempted]
        prior = p['totals'][made] / pa if pa else c['totals'][made] / ca if ca else 0
        weight = ca / (ca + min(k, pa)) if ca else 0
        probability = (1 - weight) * prior + weight * (c['totals'][made] / ca if ca else 0)
        shots[kind] = {'attempts': rates[attempted] * mpg, 'percentage': probability}
    fga = shots['2P']['attempts'] + shots['3P']['attempts']
    threes = shots['3P']['attempts'] * shots['3P']['percentage']
    fgm = shots['2P']['attempts'] * shots['2P']['percentage'] + threes
    fta, ftm = shots['FT']['attempts'], shots['FT']['attempts'] * shots['FT']['percentage']
    stats = {'FGA': fga, 'FGM': fgm, '3PM': threes, 'FTM': ftm, 'FTA': fta,
             'PTS': 2 * fgm + threes + ftm, **{key: rates[key] * mpg for key in ('REB', 'AST', 'STL', 'BLK', 'TO')}}
    validate_stats(stats, shots)
    confidence_config = config['confidence']
    confidence = 'medium' if p['gp'] >= confidence_config['mediumPreviousGames'] and c['gp'] >= confidence_config['mediumCurrentGames'] else 'low'
    if p['gp'] >= confidence_config['highPreviousGames'] and c['gp'] >= confidence_config['highCurrentGames']: confidence = 'high'
    if role['teamChange'] and role['newTeamGames'] < config['role']['sampleGames']: confidence = 'low'
    return {'status': 'available', 'reason': None, 'role': role, 'confidence': confidence, 'minutes': mpg, 'stats': stats, 'shooting': shots}


def validate_stats(stats, shots):
    if any(not math.isfinite(v) or v < 0 for v in stats.values()): raise ValueError('Invalid projected statistic')
    if (stats['FGM'] > stats['FGA'] + 1e-10 or stats['3PM'] > shots['3P']['attempts'] + 1e-10
            or stats['3PM'] > stats['FGM'] + 1e-10 or stats['FTM'] > stats['FTA'] + 1e-10
            or not math.isclose(stats['PTS'], 2 * stats['FGM'] + stats['3PM'] + stats['FTM'])):
        raise ValueError('Inconsistent projected shooting')


def remaining_schedule(content, year, as_of):
    # schedule_index deliberately hides future games for actuals; inspect future with same classifier.
    from datetime import date
    index = schedule_index(content, year, date(year, 6, 30))
    counts = dict.fromkeys(NBA_TEAMS, 0)
    for key, event in index.items():
        if event['date'] > as_of.isoformat() and event['excluded'] in (None, 'unplayed') and set(event['teams']) <= NBA_TEAMS:
            for team in event['teams']: counts[team] += 1
    if any(n > 82 for n in counts.values()): raise ValueError('Future schedule exceeds regular season')
    # Report observed schedule only, never invent unscheduled Cup fixtures.
    return counts


def expected_gp(previous, current, team_remaining, elapsed_current, config=CONFIG):
    cfg = config['availability']
    past_rate = min(1, len(previous) / cfg['historicalSeasonGames']) if previous else cfg['leaguePrior']
    opportunities = max(len(current), elapsed_current)
    attendance = (len(current) + cfg['priorGames'] * past_rate) / (opportunities + cfg['priorGames'])
    return team_remaining * min(1, max(0, attendance))
