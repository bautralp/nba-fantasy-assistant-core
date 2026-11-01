"""Run the reviewed historical generator without rewriting frozen evidence.

Old reports must be reproduced by their original code, not regenerated to match
new product metadata. Current production is covered separately by transfer tests.
"""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
from migration_baselines import read_historical
import sys
import types

BASELINE='542a01f0bc6f36d8c707d743e169c1fba7559bd0'
ROOT=Path(__file__).resolve().parents[1]


def source(path, commit=BASELINE):
    return read_historical(commit, path)


def reviewed_generator():
    archived=types.ModuleType('ros_availability')
    archived.__file__=str(ROOT/'scripts/ros_availability.py')
    exec(compile(source('scripts/ros_availability.py'),'<reviewed-availability>','exec'),archived.__dict__)
    old=sys.modules.get('ros_availability')
    try:
        sys.modules['ros_availability']=archived
        namespace={'__file__':str(ROOT/'scripts/generate_projections.py'),'__name__':'reviewed_generator'}
        exec(compile(source('scripts/generate_projections.py'),'<reviewed-generator>','exec'),namespace)
        return namespace
    finally:
        if old is None:sys.modules.pop('ros_availability',None)
        else:sys.modules['ros_availability']=old


if __name__=='__main__':
    from migration_baselines import private_root
    private_root()
    p=argparse.ArgumentParser();p.add_argument('--input-dir');p.add_argument('--catalog');p.add_argument('--output');p.add_argument('--verify-archived-availability',action='store_true');a=p.parse_args()
    if a.verify_archived_availability:
        reviewed=source('scripts/ros_availability.py')
        assert reviewed==source('scripts/ros_availability.py','6c12a470c971f14527e560716ed84bc2a8b4c13b')
        print('Original availability source unchanged in historical replay:',hashlib.sha256(reviewed).hexdigest())
    else:
        if not all((a.input_dir,a.catalog,a.output)):p.error('Replay input-dir/catalog/output required')
        g=reviewed_generator();r=Path(a.input_dir)
        contents={s:(r/f'player_box_{y}.parquet').read_bytes() for s,y in g['SEASONS'].items()}
        schedules={s:(r/f'nba_schedule_{y}.parquet').read_bytes() for s,y in g['SEASONS'].items()}
        # Fixed original cut; never masquerades as a newly refreshed public file.
        candidate=g['build'](contents,schedules,date(2026,10,25),datetime.now(timezone.utc).isoformat(),json.loads(Path(a.catalog).read_text()))
        g['publish'](candidate,a.output)
        print('Historical ROS candidate replayed with exact reviewed generator/availability',BASELINE)
