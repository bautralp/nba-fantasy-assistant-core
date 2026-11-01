"""Prove product artifacts are copies/observations, not hand-written player forecasts."""
from projection_replay_inputs import load_inputs
import gzip
import json
import subprocess
from migration_baselines import read_historical
from pathlib import Path
from generate_projection_scenarios import rookie_attendance
from ros_history_research import load_season

if __name__=='__main__':
    from migration_baselines import private_root
    private_root()
    pinned=load_inputs()
    for name,value in pinned['files'].items():
        assert value.encode()==read_historical(pinned['sourceCommit'], 'public/data/' + name),name
    a=json.loads(Path('scripts/scenario-model-artifacts.json').read_text())
    assert a['rookie']==json.loads(Path(a['sources']['rookie']['file']).read_text())
    e=json.loads(Path(a['sources']['returning']['file']).read_text())
    assert a['returning']==next(f['parameters'] for f in e['folds'] if f['year']==2027)
    c=json.loads(gzip.decompress(Path('research/rookie-shadow/14.2-shadow-v1/cohorts.json.gz').read_bytes()))
    assert a['rookieAttendancePriors']==rookie_attendance(c)
    comparison=json.loads(Path('docs/season/ros-model-audit/attendance-prior-comparison.json').read_text())
    reviewed=json.loads(read_historical('542a01f0bc6f36d8c707d743e169c1fba7559bd0', 'scripts/scenario-model-artifacts.json'))
    assert comparison['previous']==reviewed['rookieAttendancePriors']
    assert comparison['corrected']==a['rookieAttendancePriors']
    assert comparison['excludedMultiTeamEpisodesByYear']=={str(y):sum(len({g['teamId'] for g in row['games']})>1 for row in c['cohorts'][str(y)]) for y in range(2013,2019)}
    h=json.loads(gzip.decompress(Path('scripts/scenario-history.json.gz').read_bytes()))
    for year in (2024,2025):assert h['games'][str(year)]==load_season('tests/fixtures/ros-history',year)[0]
    print('Frozen model copies, training-only GP priors and real historical observations match')
