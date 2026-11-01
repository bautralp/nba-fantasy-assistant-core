"""Observed NBA-only returning-player research; never read by daily production.

Weights are explicit sufficient statistics, not extra fabricated observations.
No rookie inference and no relaxation of the production sample thresholds.
"""
from collections import defaultdict
from datetime import date
import copy
import hashlib
import json
import math
from pathlib import Path
from statistics import mean
from ros_model import CONFIG, projection_games, summary, validate_stats, expected_gp
from regular_season import schedule_index, coverage
from refresh_stats import SEASONS


def load_season(directory, year):
    # The legacy parser's season dictionary is a publication window, not a data
    # schema. Isolate the older-season selector to this offline research process.
    season = f'{year-1}-{str(year)[2:]}'
    box = (Path(directory)/f'player_box_{year}.parquet').read_bytes()
    schedule = (Path(directory)/f'nba_schedule_{year}.parquet').read_bytes()
    index = schedule_index(schedule, year, date(year, 6, 30), historical_exhibitions=True)
    prior = SEASONS.get(season)
    try:
        SEASONS[season] = year
        games = projection_games(box, season, date(year, 6, 30), index)
    finally:
        if prior is None: SEASONS.pop(season, None)
        else: SEASONS[season] = prior
    report = coverage(games, index, year, date(year, 6, 30))
    expected = (1080, 72) if year == 2021 else (1230, 82)
    if report['games'] != expected[0] or len(report['teamGames']) != 30 or set(report['teamGames'].values()) != {expected[1]}:
        raise ValueError('Historical season does not reconcile to documented NBA season length')
    report['historicalComplete'] = True
    return games, index, {'year': year, 'boxSHA256': hashlib.sha256(box).hexdigest(), 'scheduleSHA256': hashlib.sha256(schedule).hexdigest(), 'coverage': report}


def weighted_summary(history, current_year, decay):
    rows = [(g, decay**(current_year-year-1)) for year, games in history.items() for g in games]
    if any(year >= current_year for year in history): raise ValueError('Future history leakage')
    n = sum(w for _,w in rows); minutes = sum(g['minutes']*w for g,w in rows)
    totals = {k: sum(g['stats'][k]*w for g,w in rows) for k in ('FGM','FGA','FTM','FTA','3PM','3PA','REB','AST','STL','BLK','TO')}
    totals['2PM']=totals['FGM']-totals['3PM']; totals['2PA']=totals['FGA']-totals['3PA']
    return {'effectiveGP':n,'minutes':minutes,'mpg':minutes/n if n else None,'totals':totals,'rates':{k:v/minutes if minutes else None for k,v in totals.items()}}


def project_history(history, current, year, decay, gap_retention, as_of):
    if any(y >= year for y in history): raise ValueError('Future history leakage')
    if not history or history.get(year-1): return None
    if any(g['date'] > as_of for g in current) or any(g['date'] > as_of for gs in history.values() for g in gs): raise ValueError('Future observation leakage')
    if len({g['id'] for gs in [*history.values(), current] for g in gs}) > 1: raise ValueError('Mixed ESPN identities')
    p=weighted_summary(history,year,decay); c=summary(current)
    raw=[g for gs in history.values() for g in gs]
    if len(raw)+len(current)<CONFIG['minimumGames'] or sum(g['minutes'] for g in raw+current)<CONFIG['minimumMinutes']: return None
    if p['effectiveGP']<CONFIG['minimumGames'] or p['minutes']<CONFIG['minimumMinutes']: return None
    last=max(y for y,gs in history.items() if gs); gap=year-last-1
    w=c['minutes']/(c['minutes']+min(CONFIG['minutesK'],p['minutes'])) if c['minutes'] else 0
    mpg=(1-w)*p['mpg']*gap_retention**gap+w*(c['mpg'] or 0)
    mpg=min(CONFIG['role']['maxMinutes'],max(0,mpg))
    rates={}
    for key,k in CONFIG['rateK'].items():
        w=c['minutes']/(c['minutes']+min(k,p['minutes'])) if c['minutes'] else 0
        rates[key]=(1-w)*p['rates'][key]+w*c['rates'][key]
    shots={}
    for kind,k in CONFIG['shootingAttemptsK'].items():
        made,att=('FTM','FTA') if kind=='FT' else (kind+'M',kind+'A')
        pa,ca=p['totals'][att],c['totals'][att]
        if pa+ca==0: probability=0  # No projected attempts, never a published 0%.
        else:
            prior=p['totals'][made]/pa if pa else c['totals'][made]/ca
            w=ca/(ca+min(k,pa)) if ca else 0
            probability=(1-w)*prior+w*(c['totals'][made]/ca if ca else 0)
        shots[kind]={'attempts':rates[att]*mpg,'percentage':probability}
    three=shots['3P']['attempts']*shots['3P']['percentage'];fgm=shots['2P']['attempts']*shots['2P']['percentage']+three;ftm=shots['FT']['attempts']*shots['FT']['percentage']
    stats={'FGM':fgm,'FGA':shots['2P']['attempts']+shots['3P']['attempts'],'FTM':ftm,'FTA':shots['FT']['attempts'],'3PM':three,'PTS':2*fgm+three+ftm,**{k:rates[k]*mpg for k in ('REB','AST','STL','BLK','TO')}}
    validate_stats(stats,shots)
    return {'minutes':mpg,'stats':stats,'historyYears':sorted(history),'effectiveGP':p['effectiveGP'],'confidence':'research-only'}


def attendance_history(history, schedules, year, decay):
    # A missed season is zero attendance only when the whole NBA source was
    # independently reconciled, and positive earlier NBA history exists.
    active_years=[y for y,gs in history.items() if gs]
    if not active_years: return None
    numerator=denominator=0
    for y in range(min(active_years),year):
        if y not in schedules: return None
        counts=defaultdict(int)
        for event in schedules[y].values():
            if event['excluded'] is None:
                for team in event['teams']:counts[team]+=1
        rows=history.get(y,[])
        # Without roster history this is only a schedule-normalized attendance
        # proxy, not an injury diagnosis. Trades/contract absences stay caveats.
        opportunities=max(counts.values(),default=0)
        if not opportunities:return None
        w=decay**(year-y-1);numerator+=w*min(1,len(rows)/opportunities);denominator+=w
    return numerator/denominator if denominator else None
