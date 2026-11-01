"""Reviewed ESPN NBA franchise-ID labels; no inference from player history."""
import json
from pathlib import Path
import re

from regular_season import NBA_TEAMS
from fantasy_positions import URL


def load_teams():
    manifest = json.loads(Path(__file__).with_name('espn-nba-teams.json').read_text())
    teams = manifest['teams']
    if (manifest['schemaVersion'] != 1 or len(teams) != 30 or
            any(type(t['id']) is not int or t['id'] not in NBA_TEAMS or not re.fullmatch('[A-Z]{2,4}', t['abbreviation']) for t in teams) or
            len({t['id'] for t in teams}) != 30 or len({t['abbreviation'] for t in teams}) != 30):
        raise ValueError('Invalid reviewed ESPN NBA team map')
    return {t['id']: t['abbreviation'] for t in teams}


ESPN_TEAM_ABBREVIATIONS = load_teams()


def catalog_team_name(player_id, eligibility):
    """Display only: callers retain their existing GP/availability calculations.

    Eligibility has already passed the generator's existing ID/name guard.
    Manual position sources cannot establish ESPN current-team identity.
    """
    if not eligibility or eligibility.get('playerId') != player_id or eligibility.get('status') != 'verified':
        return 'Unknown'
    if (eligibility.get('provider') != 'ESPN Fantasy FBA' or eligibility.get('season') != '2026-27' or
            eligibility.get('source') != URL+'kona_player_info'):
        return 'Unknown'
    team_id = eligibility.get('proTeamId')
    return ESPN_TEAM_ABBREVIATIONS.get(team_id, 'Unknown') if type(team_id) is int else 'Unknown'


def resolve_team_assignment(player_id, eligibility, current_games, as_of):
    """Latest dated identity evidence; catalog zero is unassigned, never unknown.

    Position verification alone and a manual catalog cannot establish NBA teams.
    A past-game team is an observation, not a permanent roster assignment.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    observed = max(current_games, key=lambda g: (g['date'], g['gameId'])) if current_games else None
    eligible = bool(eligibility and eligibility.get('playerId') == player_id
                    and eligibility.get('status') == 'verified'
                    and eligibility.get('provider') == 'ESPN Fantasy FBA'
                    and eligibility.get('season') == '2026-27'
                    and eligibility.get('source') == URL+'kona_player_info')
    retrieved = eligibility.get('retrievedAt', '') if eligible else ''
    try:
        observed_at = datetime.fromisoformat(retrieved.replace('Z', '+00:00'))
        eligible = eligible and observed_at.tzinfo is not None and observed_at.date() <= as_of
        catalog_day = observed_at.astimezone(ZoneInfo('America/New_York')).date().isoformat()
    except (ValueError, TypeError):
        eligible = False
        catalog_day = ''
    value = eligibility.get('proTeamId') if eligible else None
    valid = type(value) is int and (value == 0 or value in ESPN_TEAM_ABBREVIATIONS)
    ambiguous = bool(eligible and observed and catalog_day == observed['date'] and value != observed['teamId'])
    if eligible and (not observed or catalog_day >= observed['date']) and (not valid or ambiguous):
        return {'status': 'unknown', 'teamId': None, 'source': eligibility['source'], 'observedAt': retrieved,
                'lastGameTeamId': observed['teamId'] if observed else None, 'changedSinceLastGame': False}
    if valid and (not observed or catalog_day >= observed['date']):
        return {'status': 'unassigned' if value == 0 else 'assigned', 'teamId': value,
                'source': eligibility['source'], 'observedAt': retrieved,
                'lastGameTeamId': observed['teamId'] if observed else None,
                'changedSinceLastGame': bool(observed and value != observed['teamId'])}
    if observed and observed['date'] <= as_of.isoformat():
        return {'status': 'assigned', 'teamId': observed['teamId'], 'source': 'observed-NBA-game',
                'observedAt': observed['date'], 'lastGameTeamId': observed['teamId'], 'changedSinceLastGame': False}
    return {'status': 'unknown', 'teamId': None, 'source': None, 'observedAt': None,
            'lastGameTeamId': None, 'changedSinceLastGame': False}
