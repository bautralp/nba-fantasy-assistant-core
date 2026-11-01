"""Validate provider games, generate ROS candidate, then rank with shared TS engine.

The public file changes only after Python and TypeScript validation both pass.
"""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from collections import defaultdict
from fantasy_positions import validate_catalog
from espn_teams import resolve_team_assignment, ESPN_TEAM_ABBREVIATIONS
from refresh_stats import SEASONS, SOURCE, atomic_write
from regular_season import SCHEDULE_SOURCE, schedule_index, coverage
from rookie_model import load_artifacts, classify, verified_identity_date
from ros_model import CONFIG, projection_games, project, remaining_schedule
from ros_availability import availability_component
from projection_phase import before_regular_season, empty_regular_games
from attendance_opportunities import observed_opportunities, observed_team_games, validate_period_map, VERSION as OPPORTUNITY_VERSION

ROOT = Path(__file__).resolve().parents[1]


def build(contents, schedules, as_of, generated_at, catalog, rookie_artifacts=None, team_periods=None):
    validate_catalog(catalog)
    profiles, rookie_parameters = rookie_artifacts or load_artifacts()
    all_games, reports = {}, {}
    if contents.get('2026-27') is None and not before_regular_season(schedules['2026-27'],2027,as_of,index_reader=schedule_index):raise ValueError('Current observations unavailable after season opener')
    for season, year in SEASONS.items():
        index = schedule_index(schedules[season], year, as_of)
        all_games[season] = ([] if contents[season] is None else empty_regular_games(contents[season], year, as_of)) if season == '2026-27' and before_regular_season(schedules[season], year, as_of, index_reader=schedule_index) else projection_games(contents[season], season, as_of, index)
        reports[season] = coverage(all_games[season], index, year, as_of)
    previous, current = defaultdict(list), defaultdict(list)
    for g in all_games['2025-26']: previous[g['id']].append(g)
    for g in all_games['2026-27']: current[g['id']].append(g)
    eligibility = {p['playerId']: p for p in catalog['players'] if p['retrievedAt'][:10] <= as_of.isoformat()}
    remaining = remaining_schedule(schedules['2026-27'], 2027, as_of)
    observed_events = observed_team_games(all_games['2026-27'])
    validate_period_map(team_periods, set(previous) | set(current) | set(eligibility))
    players, mismatches = [], []
    for player_id in sorted(set(previous) | set(current) | set(eligibility)):
        past, now = previous[player_id], current[player_id]
        last = (now or past)[-1] if now or past else None
        pos = eligibility.get(player_id)
        # ID is the sole join key; names are checked only to flag suspicious joins.
        if pos and last and pos['name'].casefold() != last['name'].casefold():
            mismatches.append({'playerId': player_id, 'boxName': last['name'], 'catalogName': pos['name']})
            pos = None
        verified = bool(pos and pos['status'] == 'verified')
        profile = profiles['profiles'].get(player_id)
        if profile and (profile.get('retrievedAt', '')[:10] > as_of.isoformat()):
            profile = None  # Pinned replay must not consume later metadata.
        if profile and str(profile['id']) != player_id: raise ValueError('ESPN profile ID mismatch')
        # Disabled research model leaves established production statistics unchanged.
        result = project(past, now, profile=profile, rookie_parameters=rookie_parameters) if rookie_parameters['enabled'] else project(past, now)
        result.setdefault('experience', classify(profile, past, now))
        result.setdefault('projectionBasis', 'NBA history' if past else 'Current NBA sample' if now else None)
        result.setdefault('verifiedSourceDate', verified_identity_date(profile))
        result['draftIdentityVerified'] = bool(profile and profile.get('draftIdentity', {}).get('verified'))
        result['nbaEntryVerified'] = bool(profile and profile.get('nbaEntryVerified'))
        result.setdefault('experienceReason', profile.get('missingReason') if profile else 'Doğrulanmış kariyer metadata kaydı yok')
        assignment = resolve_team_assignment(player_id, pos, now, as_of)
        team_id = assignment['teamId']
        team_remaining = 0 if assignment['status'] == 'unassigned' else remaining.get(team_id)
        opportunities = observed_opportunities(player_id, now, observed_events, team_id, as_of.isoformat(), (team_periods or {}).get(player_id))
        data_through = max((g['date'] for g in all_games['2026-27']), default=None)
        availability = availability_component(past, now, assignment, team_remaining,
                          opportunities, result['status'] == 'available', data_through)
        gp = availability['expectedGames']
        issues = []
        if not verified: issues.append('ESPN fantasy uygunluğu doğrulanamadı')
        if not now: issues.append('Bu sezon oynanmış maç yok; mevcut rol belirsiz')
        if gp is None: issues.append('Güncel takım / ROS GP doğrulanamadı: ' + availability['status'])
        if assignment['changedSinceLastGame']:
            result['confidence'] = 'low'
            issues.append('Güncel NBA ataması son gözlenen maç takımından farklı; yeni rol ve katılım belirsiz')
        if assignment['status'] == 'unassigned': issues.append('ESPN takım ataması yok; mevcut atama altında 0 maç, yetenek tahmini sıfır değildir')
        if data_through and data_through < as_of.isoformat(): issues.append('Kaynak maç kapsamı ' + data_through + '; üretilme tarihi tam güncellik kanıtı değildir')
        if any(g['starter'] is None for g in past + now): issues.append('Starter verisi eksik')
        if result['reason']: issues.append(result['reason'])
        if result['experience'] in ('rookie', 'international-newcomer') and not rookie_parameters['enabled']:
            issues.append('Rookie öncülü araştırma aşamasında; production doğrulama kapısı kapalı')
        if result['experienceReason']: issues.append(result['experienceReason'])
        stats = result['stats']
        if stats:
            stats = {**stats, 'FG%': stats['FGM'] / stats['FGA'] * 100 if stats['FGA'] else None,
                     'FT%': stats['FTM'] / stats['FTA'] * 100 if stats['FTA'] else None}
        players.append({'id': player_id, 'name': last['name'] if last else pos['name'],
                        'team': 'FA' if assignment['status'] == 'unassigned' else ESPN_TEAM_ABBREVIATIONS.get(team_id, 'Unknown'), 'teamId': team_id,
                        'teamIdentity': assignment, 'availability': availability,
                        'positions': pos['positions'] if verified else [],
                        'eligibility': pos if pos else {'playerId': player_id, 'season': '2026-27', 'positions': [],
                            'status': 'unresolved', 'provider': 'unresolved', 'source': 'unresolved', 'retrievedAt': generated_at},
                        **result, 'stats': stats, 'rosGP': gp, 'teamRemaining': team_remaining,
                        'uncertainty': issues, 'injuryStatus': pos.get('injuryStatus') if pos else None,
                        'asOf': as_of.isoformat(), 'generatedAt': generated_at,
                        'rank': None, 'totalZ': None})
    sources = [{'season': season, 'url': f'{SOURCE}/player_box_{year}.parquet', 'sha256': hashlib.sha256(contents[season]).hexdigest()}
               for season, year in SEASONS.items() if contents[season] is not None] + [
        {'season': season, 'url': f'{SCHEDULE_SOURCE}/nba_schedule_{year}.parquet', 'sha256': hashlib.sha256(schedules[season]).hexdigest()}
        for season, year in SEASONS.items()]
    if contents.get('2026-27') is None:
        # A canonical normalized identity catalog is a real input, not an empty
        # boxscore hash. Current observations are explicitly absent in this phase.
        catalog_url=next((p['source'] for p in catalog['players'] if p['source'].startswith('https://')),None)
        if not catalog_url:raise ValueError('Preseason identity source unavailable')
        sources.append({'season':'2026-27','url':catalog_url,'sha256':hashlib.sha256(json.dumps(catalog,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'encoding':'canonical-normalized-identity-catalog','observationSource':'current NBA boxscore not yet published; zero expected regular games independently verified'})
    return {'schemaVersion': 1, 'modelVersion': CONFIG['version'], 'season': '2026-27', 'kind': 'projected-ros',
            'unit': 'perGame', 'asOf': as_of.isoformat(), 'generatedAt': generated_at, 'refreshedAt': generated_at,
            'parameters': CONFIG, 'rookieModel': {'version': rookie_parameters['version'], 'enabled': rookie_parameters['enabled'], 'releaseGate': rookie_parameters.get('releaseGate')}, 'sources': sources, 'coverage': reports,
            'attendanceModel': {'version': OPPORTUNITY_VERSION, 'teamPeriodsSHA256': hashlib.sha256(json.dumps(team_periods,sort_keys=True,separators=(',',':')).encode()).hexdigest() if team_periods is not None else None},
            'scheduleRemaining': {str(k): v for k, v in remaining.items()},
            'scheduleCaveat': 'Observed scheduled games only; unscheduled Cup games are not invented.',
            'positionReport': {'verified': sum(bool(p['positions']) for p in players),
                               'unresolved': sum(not p['positions'] for p in players), 'mismatches': mismatches},
            'players': players}


def publish(candidate, output):
    output = Path(output)
    if output.exists():
        old = json.loads(output.read_text())
        if old['asOf'] > candidate['asOf']: raise ValueError('Projection date regressed')
        if set(p['id'] for p in old['players']) - set(p['id'] for p in candidate['players']):
            raise ValueError('Projection pool lost players')
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'candidate.json'
        atomic_write(candidate, path)
        subprocess.run(['node', '--experimental-strip-types', str(ROOT / 'scripts/rank_projections.ts'), str(path)], check=True, cwd=ROOT)
        validated = json.loads(path.read_text())
        atomic_write(validated, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--as-of', type=date.fromisoformat)
    parser.add_argument('--catalog', type=Path, default=Path('public/data/fantasy-positions.json'))
    parser.add_argument('--output', type=Path, default=Path('public/data/player-projections.json'))
    parser.add_argument('--team-periods', type=Path, help='Exact-ID sourced, dated assignment periods; missing dates remain unknown')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    schedules = {s: (args.input_dir / f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
    contents = {s: (args.input_dir / f'player_box_{y}.parquet').read_bytes() if (args.input_dir / f'player_box_{y}.parquet').exists() else None if s=='2026-27' and before_regular_season(schedules[s],y,args.as_of or now.date()) else (args.input_dir / f'player_box_{y}.parquet').read_bytes() for s,y in SEASONS.items()}
    catalog = json.loads(args.catalog.read_text()) if args.catalog.exists() else {'schemaVersion': 1, 'season': '2026-27', 'players': []}
    snapshot = build(contents, schedules, args.as_of or now.date(), now.isoformat(), catalog, team_periods=json.loads(args.team_periods.read_text()) if args.team_periods else None)
    publish(snapshot, args.output)
    print('Projection publication:', snapshot['positionReport'], 'players=', len(snapshot['players']))
