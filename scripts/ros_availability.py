"""Separate auditable empirical attendance from conditional on-playing performance.

No injury-return probabilities, rookie debut estimates or calibrated claims are
manufactured. The established attendance estimator is retained for supported
performance rows, with its evidence and limitations exposed.
"""
from ros_model import expected_gp
from attendance_opportunities import matched_appearances


def availability_component(previous, current, assignment, remaining, elapsed, performance_available, data_through):
    evidence = elapsed if isinstance(elapsed, dict) else None
    if evidence is not None: current = matched_appearances(current, evidence)
    elapsed = evidence['count'] if evidence is not None else elapsed
    common = {'estimator': 'empirical-attendance-v1', 'sourceDataThrough': data_through,
              'previousAppearances': len(previous), 'currentAppearances': len(current),
              'observedOpportunities': elapsed, 'injuryReturnModelled': False,
              'appearanceProbability': None}
    if evidence is not None: common['opportunityEvidence'] = evidence
    if assignment['status'] == 'unassigned':
        return {**common, 'status': 'zero-current-assignment', 'confidence': 'verified-scope',
                'expectedGames': 0, 'diagnosticEstimate': None, 'usableForTotals': True,
                'reason': 'Verified ESPN unassigned team: zero games under the current assignment, not zero player ability.'}
    if assignment['status'] != 'assigned' or remaining is None:
        return {**common, 'status': 'unknown-team', 'confidence': 'unknown', 'expectedGames': None,
                'diagnosticEstimate': None, 'usableForTotals': False, 'reason': 'NBA team/schedule identity is unknown.'}
    if elapsed is None:
        return {**common, 'status': 'unknown-opportunities', 'confidence': 'unknown', 'expectedGames': None,
                'diagnosticEstimate': None, 'usableForTotals': False, 'reason': 'Dated transfer/assignment opportunities are not known.'}
    estimate = expected_gp(previous, current, remaining, elapsed)
    if not performance_available:
        return {**common, 'status': 'unvalidated-performance', 'confidence': 'uncalibrated',
                'expectedGames': None, 'diagnosticEstimate': estimate, 'usableForTotals': False,
                'reason': 'Empirical attendance is not an independently validated ROS total without conditional performance.'}
    return {**common, 'status': 'empirical', 'confidence': 'uncalibrated', 'expectedGames': estimate,
            'diagnosticEstimate': estimate, 'usableForTotals': True,
            'reason': 'Historical attendance proxy; unknown DNP/injury/contract causes and unpublished games are not diagnosed.'}
