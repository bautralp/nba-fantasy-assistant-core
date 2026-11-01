"""Restore exact pinned raw observations and audit probes; no network required."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
from returning_veteran_data import build,write_gzip


def restore(fixture,legacy,output):
    root=Path(fixture);dest=Path(output);dest.mkdir(parents=True,exist_ok=True);(dest/'probes').mkdir(exist_ok=True)
    archive=json.loads(gzip.decompress((root/'historical-sources.json.gz').read_bytes()))
    corpus=json.loads(gzip.decompress((root/'corpus.json.gz').read_bytes()))
    manifest={s['file']:s['sha256'] for r in corpus['manifest'] for s in r.get('sources',[])}
    for name,expected in manifest.items():
        if not re.fullmatch(r'(player_box|nba_schedule)_\d{4}\.parquet',name):raise ValueError('Unsafe source filename')
        raw=base64.b64decode(archive[name],validate=True) if name in archive else (Path(legacy)/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=expected:raise ValueError('Raw source revision mismatch: '+name)
        (dest/name).write_bytes(raw)
    probes=json.loads(gzip.decompress((root/'score-probes.json.gz').read_bytes()))
    for gid,raw in probes['responses'].items():
        if not gid.isdigit():raise ValueError('Unsafe game identity')
        (dest/'probes'/f'{gid}.json').write_text(raw)
    return dest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--fixture',default='tests/fixtures/returning-veteran');p.add_argument('--legacy',default='tests/fixtures/ros-history');p.add_argument('--output-dir',required=True);p.add_argument('--corpus-output',required=True);a=p.parse_args()
    dest=restore(a.fixture,a.legacy,a.output_dir);write_gzip(a.corpus_output,build(dest,dest/'probes'))
    if Path(a.corpus_output).read_bytes()!=(Path(a.fixture)/'corpus.json.gz').read_bytes():raise ValueError('Replayed corpus differs')
    print('Raw hashes, 25 season audits and corpus replay match exactly')
