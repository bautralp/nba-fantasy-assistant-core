"""Offline product replay. No external projections or mutation of frozen research."""
import argparse
import base64
import gzip
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from projection_replay_inputs import load_inputs
from projection_role_evidence import build
from refresh_stats import atomic_write

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output-dir',required=True);a=p.parse_args();out=Path(a.output_dir);out.mkdir(parents=True,exist_ok=True)
    fixture=json.loads(gzip.decompress(Path('tests/fixtures/final-projections/observations.json.gz').read_bytes()))
    pinned=load_inputs()['files']
    expected=json.loads(pinned['projection-scenarios.json'])
    for name,value in pinned.items():(out/name).write_text(value)
    with tempfile.TemporaryDirectory() as temporary:
        root=Path(temporary)
        for name,value in fixture['files'].items():
            if not re.fullmatch(r'(?:roster-\d+|depth-\d+|preseason-(?:summary|board)-\d+)\.json|(?:player_box|nba_schedule)_2027\.parquet',name):raise ValueError('Unsafe fixture path')
            (root/name).write_bytes(base64.b64decode(value,validate=True) if name.endswith('.parquet') else value.encode())
        for stem in ('player_box','nba_schedule'):shutil.copyfile(f'tests/fixtures/ros-history/{stem}_2026.parquet',root/f'{stem}_2026.parquet')
        roles=build(root,fixture['observedAt']);atomic_write(roles,root/'roles.json')
        subprocess.run([sys.executable,'scripts/generate_projection_scenarios.py','--input-dir',str(root),'--roles',str(root/'roles.json'),'--computed-at',expected['computedAt'],'--standard',str(out/'player-projections.json'),'--schedule',str(out/'analysis-schedule.json'),'--output',str(out/'projection-scenarios.json')],check=True)
        subprocess.run([sys.executable,'scripts/report_attendance_fix.py','--input-dir',str(root),'--output',str(out/'attendance-fix-results.json')],check=True)
        if (out/'attendance-fix-results.json').read_bytes()!=Path('docs/season/ros-model-audit/attendance-fix-results.json').read_bytes():raise ValueError('Transfer opportunity/GP evidence differs')
    unified=json.loads((out/'projection-scenarios.json').read_text())
    if unified['modelVersion']!='unified-ros/2':raise ValueError('Unified contract required')
    if (out/'projection-scenarios.json').read_bytes()!=gzip.decompress(Path('docs/season/unified-ros/candidate.json.gz').read_bytes()):raise ValueError('Unified candidate replay differs')
    subprocess.run(['node','--experimental-strip-types','scripts/report_final_projections.ts',str(out/'final-projection-results.json'),str(out/'projection-scenarios.json'),str(out/'player-projections.json'),str(out/'analysis-schedule.json')],check=True)
    subprocess.run([sys.executable,'scripts/verify_final_rankings.py','--report',str(out/'final-projection-results.json'),'--source',str(out/'projection-scenarios.json')],check=True)
    print('Exact source/model/real-league replay verified; scientific gates remain disabled')
