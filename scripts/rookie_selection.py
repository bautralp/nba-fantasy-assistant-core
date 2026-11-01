"""Individual season admissibility; no network, fitting, team or draft-team censoring."""
from collections import Counter
from math import isfinite
import re

POLICY = {'version': 'individual-gp-v1', 'methodologyChangedAfterHoldout': True,
          'productionEnabled': False, 'evaluationStatus': 'requires-new-evaluation-protocol'}

def valid_stats(game, pid):
    if (str(game.get('id')) != pid or not str(game.get('gameId', '')).isdigit()
            or game.get('teamId') not in range(1,31)):
        return False
    minutes = game.get('minutes')
    if not isinstance(minutes, (int, float)) or not isfinite(minutes) or minutes <= 0:
        return False
    stats = game.get('stats', {})
    keys = ('FGM', 'FGA', '3PM', '3PA', 'FTM', 'FTA', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO')
    if any(not isinstance(stats.get(k), (int, float)) or not isfinite(stats[k]) or stats[k] < 0 for k in keys):
        return False
    return (stats['3PM'] <= stats['FGM'] <= stats['FGA'] and stats['FTM'] <= stats['FTA']
            and stats['3PM'] <= stats['3PA'] <= stats['FGA']
            and stats['FGM'] - stats['3PM'] <= stats['FGA'] - stats['3PA']
            and abs(stats['PTS'] - (2 * stats['FGM'] + stats['3PM'] + stats['FTM'])) < 1e-8)

def season_gp(profile, year, games):
    """Use an explicit source GP, never infer zero or synthesize a season total.

    The cached verified career projection retains per-team and total GP rows.
    For heterogeneous rows, accept the recorded total only when all remaining
    rows sum to it AND match the independently observed franchise GP multiset.
    Merely taking max(), or summing team rows into an absent total, is forbidden.
    """
    values = [s.get('gp') for s in profile.get('seasons', []) if s.get('year') == year]
    if not values:
        return None, 'missing-season-gp'
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not isfinite(v)
           or v != int(v) or v < 0 for v in values):
        return None, 'invalid-career-gp'
    values = [int(v) for v in values]
    if len(set(values)) == 1:
        return values[0], 'explicit-season-gp'
    total = max(values)
    parts = list(values)
    parts.remove(total)
    observed = Counter(g['teamId'] for g in games)
    if sum(parts) != total or sorted(parts) != sorted(observed.values()):
        return None, 'unreconciled-career-team-splits'
    return total, 'explicit-total-reconciled-with-team-splits'

def select_season(pid, year, profile, games, draft=None, unusable=False):
    proof = {'accepted': False, 'reason': None, 'observedGP': len(games), 'verifiedGP': None}
    def reject(reason):
        return {**proof, 'reason': reason}
    if (not pid.isdigit() or profile.get('identityVerified') is not True or str(profile.get('id')) != pid
            or profile.get('uid') != 's:40~l:46~a:' + pid):
        return reject('unverified-nba-identity')
    if (profile.get('careerSchemaVerified') is not True
            or not re.fullmatch('[0-9a-f]{64}', profile.get('careerSha256') or '')):
        return reject('unverified-career-metadata')
    if any(int(y) < year and gp > 0 for y, gp in profile.get('nbaHistory', {}).items()):
        return reject('earlier-nba-appearance')
    if unusable or any(not valid_stats(g, pid) for g in games):
        return reject('inconsistent-individual-statistics')
    if len({g['gameId'] for g in games}) != len(games):
        return reject('duplicate-player-game')
    gp, basis = season_gp(profile, year, games)
    proof.update(verifiedGP=gp, gpProof=basis, careerSha256=profile['careerSha256'],
                 sourceGPValues=[s.get('gp') for s in profile.get('seasons',[]) if s.get('year')==year],
                 observedTeamGP={str(t):n for t,n in sorted(Counter(g['teamId'] for g in games).items())})
    if gp is None:
        return reject(basis)
    if gp != len(games):
        return reject('individual-gp-mismatch')
    positive = [s['year'] for s in profile.get('seasons', []) if s.get('gp', 0) > 0]
    if games and (not positive or min(positive) != year):
        return reject('unverified-career-start')
    if not games and (not draft or draft.get('verified') is not True
                      or draft.get('draftYear') != year - 1
                      or any(y < year for y in positive)):
        return reject('unverified-zero-debut-season')
    match = re.match(r'(\d{4}): Rd', profile.get('displayDraft') or '')
    if match and int(match[1]) >= year:
        return reject('draft-debut-conflict')
    return {**proof, 'accepted': True, 'reason': 'individual-season-reconciled',
            'debutProof': 'verified-career-start' if games else 'explicit-verified-zero-gp'}
