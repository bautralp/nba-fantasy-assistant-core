"""Pinned October 25 replay inputs, independent of the changing production files."""
import gzip
from migration_baselines import read_private_data
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMMIT = '0648a691a1c9fa938b5fb29cb479b2d2178cfb1d'
NAMES = {'player-projections.json', 'projection-scenarios.json', 'analysis-schedule.json', 'fantasy-positions.json'}
ARCHIVE = ROOT / 'docs/season/unified-ros/replay-inputs.json.gz'


def load_inputs():
    bundle = json.loads(gzip.decompress(read_private_data(ARCHIVE.relative_to(ROOT).as_posix())))
    if bundle['sourceCommit'] != COMMIT or set(bundle['files']) != NAMES or set(bundle['sha256']) != NAMES:
        raise ValueError('Unexpected archived projection input identity')
    for name, text in bundle['files'].items():
        if hashlib.sha256(text.encode()).hexdigest() != bundle['sha256'][name]:
            raise ValueError('Archived projection input SHA mismatch: ' + name)
    return bundle
