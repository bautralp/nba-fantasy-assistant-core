"""Match observed normal-season games to dated NBA assignments, never future schedule.

Dates are NBA calendar days; periods are [start, end). A roster observation is
not a transaction date. Detected transfers without dated periods fail closed.
"""
from datetime import date

VERSION = 'dated-team-opportunities/1'


def validate_period_map(periods, player_ids):
    if periods is None:
        return
    if not isinstance(periods, dict):
        raise ValueError('Assignment periods must be exact-ID keyed')
    for pid, entries in periods.items():
        if not isinstance(pid, str) or not pid.isdigit() or pid not in player_ids or not isinstance(entries, list) or any(str(p.get('playerId')) != pid for p in entries):
            raise ValueError('Unknown/mismatched assignment period player ID')


def matched_appearances(appearances, scope):
    """Use the same deduplicated/asOf numerator as the opportunity report."""
    accepted = set(scope['appearanceGameIds'])
    unique = {str(g['gameId']): g for g in appearances if str(g['gameId']) in accepted}
    if len(unique) != scope['observedGP']:
        raise ValueError('Appearance numerator/opportunity scope mismatch')
    return list(unique.values())


def observed_team_games(rows):
    """Deduplicate player/team sides of actually published, normalized NBA games."""
    events = {}
    for g in rows:
        if g.get('seasonType', 2) != 2:
            continue
        gid = str(g['gameId'])
        item = events.setdefault(gid, {'id': gid, 'date': g['date'], 'teamIds': set()})
        if item['date'] != g['date']:
            raise ValueError('Conflicting observed game date')
        item['teamIds'].add(g['teamId'])
        if g.get('opponentTeamId') is not None:
            item['teamIds'].add(g['opponentTeamId'])
        if len(item['teamIds']) > 2:
            raise ValueError('Conflicting NBA game team sides')
    return [{**g, 'teamIds': sorted(g['teamIds'])} for g in events.values()]


def observed_opportunities(player_id, appearances, events, current_team, as_of, periods=None):
    """Return exact/continuity-proxy count or null, with auditable matched scope.

    Explicit periods require exact player ID, source and knowledge date. Without
    them, the legacy single-team continuity proxy is retained and labelled as
    an assumption. Multiple observed teams or a changed current assignment never
    use the latest team's full-season count. Missing transition dates are unknown.
    """
    date.fromisoformat(as_of)
    games = {}
    for g in events:
        if g.get('seasonType', 2) != 2 or g['date'] > as_of:
            continue
        item = {'id': str(g['id']), 'date': g['date'], 'teamIds': sorted(set(g['teamIds']))}
        if not 1 <= len(item['teamIds']) <= 2 or any(type(t) is not int or not 1 <= t <= 30 for t in item['teamIds']):
            raise ValueError('Unknown observed NBA game team')
        if item['id'] in games and games[item['id']] != item:
            raise ValueError('Conflicting duplicate observed game')
        games[item['id']] = item
    played = {}
    for g in appearances:
        if g.get('seasonType', 2) != 2 or g['date'] > as_of:
            continue
        if str(g['id']) != str(player_id):
            raise ValueError('Attendance player ID mismatch')
        key = str(g['gameId'])
        item = (g['date'], g['teamId'])
        if key in played and played[key] != item:
            raise ValueError('Conflicting duplicate player appearance')
        if key not in games or item[0] != games[key]['date'] or item[1] not in games[key]['teamIds']:
            raise ValueError('Appearance missing from observed regular game scope')
        played[key] = item
    common = {'modelVersion': VERSION, 'observedGP': len(played),
              'appearanceGameIds': sorted(played),
              'sourceDataThrough': max((g['date'] for g in games.values()), default=None),
              'asOf': as_of, 'currentTeamId': current_team, 'uncertainIntervals': []}
    active = []
    for p in periods or []:
        if str(p['playerId']) != str(player_id):
            raise ValueError('Assignment period player ID mismatch')
        if not p.get('source', '').startswith('https://') or not p.get('knownAt'):
            raise ValueError('Assignment period provenance missing')
        date.fromisoformat(p['knownAt'][:10])
        # Later published transactions must not close a historical stint.
        if p['knownAt'][:10] > as_of or p['start'] > as_of:
            continue
        date.fromisoformat(p['start'])
        if p.get('end'):
            date.fromisoformat(p['end'])
            if p['end'] <= p['start']:
                raise ValueError('Invalid assignment period interval')
        if type(p['teamId']) is not int or not 0 <= p['teamId'] <= 30:
            raise ValueError('Unknown period NBA team')
        active.append(p)
    active.sort(key=lambda p: p['start'])
    if any(a.get('end') is None or a['end'] > b['start'] for a,b in zip(active,active[1:])):
        raise ValueError('Overlapping assignment periods')
    today = next((p for p in active if p['start'] <= as_of and (p.get('end') is None or as_of < p['end'])), None)
    if today is not None and current_team is not None and today['teamId'] != current_team:
        raise ValueError('Current NBA assignment conflicts with dated period')
    ids = set()
    unknown = []
    teams = {t for _,t in played.values()}
    if active:
        for key,g in games.items():
            period = next((p for p in active if p['start'] <= g['date'] and (p.get('end') is None or g['date'] < p['end'])), None)
            if period is None:
                unknown.append(g['date'])
            elif period['teamId'] in g['teamIds']:
                ids.add(key)
            if key in played and (period is None or period['teamId'] != played[key][1]):
                raise ValueError('Appearance conflicts with dated assignment')
        basis = 'dated-assignment-periods'
        # Missing periods are not free-agent periods. No medical eligibility is
        # inferred: known injury DNP remains an attendance opportunity on roster.
        confidence = 'verified-scope' if not unknown else 'unknown'
    elif current_team is not None and (not teams or teams == {current_team}):
        ids = {key for key,g in games.items() if current_team in g['teamIds']}
        basis = 'single-team-continuity-proxy'
        confidence = 'assumed-continuity'
    else:
        # Appearance endpoints identify stints, not the intervening contract dates.
        ordered = sorted(played.items(), key=lambda x: (x[1][0],x[0]))
        stints = []
        for key,(day,team) in ordered:
            if not stints or stints[-1]['teamId'] != team:
                stints.append({'teamId':team,'firstAppearance':day,'lastAppearance':day})
            else:
                stints[-1]['lastAppearance'] = day
        for s in stints:
            ids.update(key for key,g in games.items() if s['teamId'] in g['teamIds'] and s['firstAppearance'] <= g['date'] <= s['lastAppearance'])
        common['appearanceStints'] = stints
        common['uncertainIntervals'] = [{'after': a[1][0], 'before': b[1][0], 'fromTeamId': a[1][1], 'toTeamId': b[1][1]}
            for a,b in zip(ordered,ordered[1:]) if a[1][1] != b[1][1]]
        if ordered and ordered[-1][1][1] != current_team:
            common['uncertainIntervals'].append({'after': ordered[-1][1][0], 'before': as_of, 'fromTeamId': ordered[-1][1][1], 'toTeamId': current_team})
        basis = 'missing-transfer-dates' if teams and current_team is not None else 'unknown-team'
        confidence = 'unknown'
    count = None if confidence == 'unknown' else len(ids)
    if count is not None and not set(played) <= ids:
        raise ValueError('Observed GP exceeds matched assignment scope')
    return {**common, 'count': count, 'confirmedCount': len(ids), 'gameIds': sorted(ids),
            'basis': basis, 'confidence': confidence, 'periods': active,
            'uncoveredObservedDates': sorted(set(unknown)),
            'assumptions': ['No transaction history: unchanged single-team affiliation assumed.'] if confidence == 'assumed-continuity' else [],
            'warning': 'Transfer/assignment dates missing; no exact attendance denominator or ROS GP.' if count is None else None}
