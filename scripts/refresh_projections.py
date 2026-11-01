"""Daily projection orchestration; failed components retain last verified bytes."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
from fantasy_positions import refresh, DEFAULT_MAPPING
from refresh_stats import atomic_write


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input-dir', type=Path, required=True)
    p.add_argument('--mapping', type=Path, default=DEFAULT_MAPPING)
    p.add_argument('--manual-catalog', type=Path)
    args = p.parse_args()
    errors = []
    try:
        refresh('public/data/fantasy-positions.json', args.manual_catalog, args.mapping)
    except Exception as error:
        errors.append('Fantasy catalog retained: ' + str(error))
    result = subprocess.run([sys.executable, 'scripts/generate_projections.py', '--input-dir', str(args.input_dir)])
    if result.returncode: errors.append('Projection refresh failed; previous valid projection retained')
    atomic_write({'schemaVersion': 1, 'attemptedAt': datetime.now(timezone.utc).isoformat(),
                  'status': 'degraded' if errors else 'ok', 'errors': errors}, 'public/data/projection-refresh-status.json')
    for error in errors: print(error, file=sys.stderr)
    if result.returncode: raise SystemExit(result.returncode)
    # Explicit degraded status for catalog failure; stats/projection remain usable.
    if errors: print('::warning::Fantasy catalog refresh incomplete; see projection-refresh-status.json')


if __name__ == '__main__': main()
