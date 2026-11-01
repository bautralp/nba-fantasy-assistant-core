"""Evidence-based experience routing and separately calibrated rookie minutes/rates.

No name joins, no implied NCAA crosswalk, no unvalidated parameter defaults.
Historical acquisition/training is offline; daily inference reads versioned artifacts.
"""
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).parent
RATE_KEYS = ('2PA', '3PA', 'FTA', 'REB', 'AST', 'STL', 'BLK', 'TO')
KINDS = ('2P', '3P', 'FT')
CLASSES = ('rookie', 'returning-veteran', 'international-newcomer', 'limited-experience', 'veteran', 'unknown')


def load_artifacts():
    profiles = json.loads((ROOT / 'rookie-profiles.json').read_text())
    model = json.loads((ROOT / 'rookie-parameters.json').read_text())
    if profiles['schemaVersion'] != 1 or model['schemaVersion'] != 1:
        raise ValueError('Unsupported rookie artifacts')
    validate_parameters(model)
    for pid, profile in profiles['profiles'].items():
        if str(profile['id']) != pid: raise ValueError('ESPN profile ID mismatch')
    return profiles, model


def validate_parameters(parameters):
    for value in [parameters['minutesK'], *parameters['rateK'].values(), *parameters['shootingK'].values()]:
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError('Invalid rookie reliability parameter')
    if set(parameters['rateK']) != set(RATE_KEYS) or set(parameters['shootingK']) != set(KINDS):
        raise ValueError('Incomplete rookie reliability groups')
    if not 0 <= parameters['roleWeight'] <= 1: raise ValueError('Invalid rookie role weight')
    if parameters['enabled'] and parameters.get('calibrationStatus') != 'validated':
        raise ValueError('Rookie release gate has not passed')
    if parameters.get('ncaaEnabled') and not parameters.get('ncaaFits'):
        raise ValueError('NCAA assistance lacks calibrated fits')
    for prior in parameters['priors'].values():
        if not 0 < prior['minutes'] <= 40: raise ValueError('Invalid rookie minutes prior')
        if any(not math.isfinite(prior['rates'][k]) or prior['rates'][k] < 0 for k in RATE_KEYS):
            raise ValueError('Invalid rookie rate prior')
        if any(not math.isfinite(prior['percentages'][k]) or not 0 <= prior['percentages'][k] <= 1 for k in KINDS):
            raise ValueError('Invalid rookie shooting prior')


def verified_identity_date(profile):
    if not profile or not profile.get('identityVerified'): return None
    return profile.get('draftIdentity', {}).get('retrievedAt') or profile.get('retrievedAt')


def classify(profile, previous, current, ending_year=2027):
    """Positive NBA history beats stale ESPN 'Rookie' labels. Absence is not rookie evidence."""
    ids = {g['id'] for g in previous + current}
    if len(ids) > 1 or profile and ids and str(profile['id']) not in ids:
        raise ValueError('ESPN athlete ID mismatch')
    seasons = [s for s in (profile or {}).get('seasons', []) if s['year'] < ending_year and s['gp'] > 0]
    historical = (profile or {}).get('nbaHistory', {})
    older = {int(y): gp for y, gp in historical.items() if int(y) < ending_year and gp > 0}
    # ESPN may include both team stints and a combined season total. Count each year once.
    season_gp = {s['year']: max(t['gp'] for t in seasons if t['year'] == s['year']) for s in seasons}
    gp = max(sum(season_gp.values()), sum(older.values()), len(previous))
    first = min([s['year'] for s in seasons] + list(older) + ([ending_year - 1] if previous else []), default=None)
    last_year = bool(previous or any(s['year'] == ending_year - 1 for s in seasons) or older.get(ending_year - 1))
    if gp:
        if not last_year: return 'returning-veteran'
        career_start_verified = bool(profile and profile.get('identityVerified') and profile.get('careerSchemaVerified') and seasons)
        if career_start_verified and first >= ending_year - 2 and gp < 82: return 'limited-experience'
        return 'veteran'
    if not profile or not profile.get('identityVerified'): return 'unknown'
    draft_evidence = profile.get('draftIdentity', {})
    if draft_evidence.get('verified') and draft_evidence.get('year') == ending_year - 1:
        if draft_evidence.get('playerId') != str(profile['id']):
            raise ValueError('Official draft/profile ESPN ID mismatch')
        if not profile.get('nbaEntryVerified'):
            return 'unknown'  # Drafted overseas/stashed is not proof of NBA entry.
        if profile.get('preNBALeague') == 'international-pro' and profile.get('preNBALeagueSource'):
            return 'international-newcomer'
        return 'rookie'
    career = profile.get('careerSchemaVerified') and all(s['year'] >= ending_year for s in profile.get('seasons', []))
    explicit = profile.get('displayExperience') in ('Rookie', '1st Season')
    roster=profile.get('currentRosterEvidence',{})
    verified_undrafted_entry=bool(explicit and career and not profile.get('seasons')
        and profile.get('nbaEntryVerified') and roster.get('experienceYears')==0
        and roster.get('uid')=='s:40~l:46~a:'+str(profile['id'])
        and set(range(ending_year-4,ending_year)).issubset(set(profile.get('historyCoverage',[]))))
    draft = re.match(r'(\d{4}):', profile.get('displayDraft') or '')
    # Before debut, require explicit rookie metadata AND this draft year plus checked history.
    debut_verified = verified_undrafted_entry or career and bool(profile.get('seasons')) or (
        explicit and draft and int(draft[1]) == ending_year - 1 and set(range(ending_year-4, ending_year)).issubset(set(profile.get('historyCoverage', []))))
    if not debut_verified: return 'unknown'
    if profile.get('preNBALeague') == 'international-pro' and profile.get('preNBALeagueSource'):
        return 'international-newcomer'
    return 'rookie'


def draft_group(profile):
    match = re.search(r'Rd (\d+), Pk (\d+)', profile.get('displayDraft') or '')
    if not match: return 'undrafted-or-unknown'
    round_, pick = map(int, match.groups())
    return 'lottery' if round_ == 1 and pick <= 14 else 'first-round' if round_ == 1 else 'second-round'


def prior_for(profile, parameters):
    if not profile or not profile.get('identityVerified'): return None
    group = draft_group(profile)
    # A verified draft or college profile is required; unknown identity/profile is not a league average.
    if group == 'undrafted-or-unknown' and not profile.get('ncaa'): return None
    position = profile.get('priorPosition') or 'unknown'
    cells = parameters['priors']
    prior = dict(cells.get(group + ':' + position, cells.get(group, cells['all'])))
    prior['rates'] = dict(prior['rates']); prior['percentages'] = dict(prior['percentages'])
    basis = 'Rookie prior'
    ncaa = profile.get('ncaa')
    if parameters.get('ncaaEnabled') and parameters.get('ncaaFits') and ncaa:
        if str(ncaa['id']) != str(profile.get('collegeAthlete', {}).get('id')):
            raise ValueError('Unverified NCAA athlete ID crosswalk')
        for key, fit in parameters['ncaaFits'].items():
            prior['rates'][key] = max(0, fit['intercept'] + fit['slope'] * ncaa['rates'][key])
        basis = 'NCAA-assisted'
    return {**prior, 'basis': basis}


def infer(prior, current, parameters, use_role=True):
    """Rates use NBA minutes; shooting uses attempts; minutes use played games."""
    # Local import avoids changing the experienced-player implementation.
    from ros_model import summary, validate_stats
    c = summary(current)
    weights = {'minutes': c['gp'] / (c['gp'] + parameters['minutesK'])}
    mpg = (1 - weights['minutes']) * prior['minutes'] + weights['minutes'] * (c['mpg'] or 0)
    rates = {}
    for key in RATE_KEYS:
        w = c['minutes'] / (c['minutes'] + parameters['rateK'][key])
        weights[key] = w
        rates[key] = (1 - w) * prior['rates'][key] + w * c['rates'][key]
    # First-game signals are exposed immediately, but only calibrated weight can alter inference.
    recent = summary(current[-5:])
    role_weight = parameters['roleWeight'] * min(1, c['gp'] / parameters['minutesK']) if use_role else 0
    mpg = min(40, max(0, (1 - role_weight) * mpg + role_weight * (recent['mpg'] or mpg)))
    shots = {}
    for kind in KINDS:
        made, attempted = ('FTM', 'FTA') if kind == 'FT' else (kind + 'M', kind + 'A')
        n = c['totals'][attempted]
        w = n / (n + parameters['shootingK'][kind])
        weights[kind + '%'] = w
        probability = (1 - w) * prior['percentages'][kind] + w * (c['totals'][made] / n if n else 0)
        shots[kind] = {'attempts': rates[attempted] * mpg, 'percentage': min(1, max(0, probability))}
    threes = shots['3P']['attempts'] * shots['3P']['percentage']
    fgm = shots['2P']['attempts'] * shots['2P']['percentage'] + threes
    ftm = shots['FT']['attempts'] * shots['FT']['percentage']
    stats = {'FGM': fgm, 'FGA': shots['2P']['attempts'] + shots['3P']['attempts'], '3PM': threes,
             'FTM': ftm, 'FTA': shots['FT']['attempts'], 'PTS': 2 * fgm + threes + ftm,
             **{key: rates[key] * mpg for key in ('REB', 'AST', 'STL', 'BLK', 'TO')}}
    validate_stats(stats, shots)
    return {'status': 'available', 'reason': None, 'confidence': 'low', 'minutes': mpg,
            'stats': stats, 'shooting': shots, 'rookieWeights': weights,
            'rookieRole': {'observedGames': c['gp'], 'recentMinutes': recent['mpg'],
                           'starterRate': recent['starterRate'], 'appliedWeight': role_weight},
            'projectionBasis': prior['basis']}


def rookie_project(profile, previous, current, parameters, role, use_role=True):
    experience = classify(profile, previous, current)
    provenance = {'experience': experience, 'projectionBasis': 'NBA history' if previous else 'Current NBA sample' if current else None,
                  'verifiedSourceDate': verified_identity_date(profile),
                  'experienceReason': (profile or {}).get('missingReason')}
    if experience not in ('rookie', 'international-newcomer'): return None, provenance
    prior = prior_for(profile, parameters) if parameters.get('enabled') else None
    if not prior:
        return {'status': 'unavailable', 'reason': 'Doğrulanmış ve valide edilmiş rookie öncülü yok',
                'role': role, 'confidence': 'low', 'stats': None, 'minutes': None, **provenance}, provenance
    if any('3PA' not in g['stats'] for g in current): raise ValueError('Rookie sample lacks 3PA')
    result = infer(prior, current, parameters, use_role)
    return {**provenance, **result, 'role': role}, provenance
