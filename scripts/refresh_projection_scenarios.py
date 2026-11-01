"""Optional sidecar AFTER verified daily freshness; failed scenarios retain bytes."""
from datetime import datetime,timezone
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import urlopen
from concurrent.futures import ThreadPoolExecutor
from projection_role_evidence import build
from refresh_stats import atomic_write


def main():
    p=argparse.ArgumentParser();p.add_argument('--input-dir',required=True);a=p.parse_args()
    standard=json.loads(Path('public/data/player-projections.json').read_text())
    if standard['asOf']!=datetime.now(timezone.utc).date().isoformat():raise ValueError('Daily scenario refuses stale standard date')
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp)
        def fetch(item):
            team,kind=item;url=f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team}/{"roster" if kind=="roster" else "depthcharts"}'
            try:
                with urlopen(url,timeout=15) as r:raw=r.read(1024*1024+1)
                if len(raw)>1024*1024:raise ValueError('Role response too large')
                (root/f'{kind}-{team}.json').write_bytes(raw)
            except Exception:pass # Missing evidence stays missing, never numeric news inference.
        with ThreadPoolExecutor(max_workers=5) as pool:list(pool.map(fetch,[(t,k) for t in range(1,31) for k in ('roster','depth')]))
        evidence=build(root,datetime.now(timezone.utc).isoformat());atomic_write(evidence,root/'roles.json')
        subprocess.run([sys.executable,'scripts/generate_projection_scenarios.py','--input-dir',a.input_dir,'--roles',str(root/'roles.json'),'--output','public/data/projection-scenarios.json'],check=True)

if __name__=='__main__':main()
