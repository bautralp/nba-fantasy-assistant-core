"""One-time, checksum-bounded repair of PR #14's exact initial snapshot.

This is intentionally NOT an option of the daily refresh command. Both the old
bytes and the full corrected payload (except refresh time) must match reviewed
checksums. No other source regression can use this repair.
"""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
from refresh_stats import SEASONS, build_snapshot, atomic_write

INITIAL_SHA256 = 'b74dab731304c3846b0c92c71a7e6b1ea78ad00b5c1c5b5940274518247e37a2'
CORRECTED_SHA256 = 'b32c4bb1c191634ee487e1b5fe1c466ab557663071641b1f1d4573aaacce6d9f'


def correct_initial_snapshot(snapshot, output):
    output = Path(output)
    original = output.read_bytes()
    if hashlib.sha256(original).hexdigest() != INITIAL_SHA256:
        raise ValueError('Repair only accepts the exact initial PR #14 snapshot')
    old = json.loads(original)
    candidate = {**snapshot, 'refreshedAt': old['refreshedAt']}
    digest = hashlib.sha256(json.dumps(candidate, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    if digest != CORRECTED_SHA256:
        raise ValueError('Repair candidate differs from the reviewed correction')
    if datetime.fromisoformat(snapshot['refreshedAt']) < datetime.fromisoformat(old['refreshedAt']):
        raise ValueError('Repair timestamp must not regress')
    atomic_write(snapshot, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=Path('public/data/player-stats.json'))
    args = parser.parse_args()
    old = json.loads(args.output.read_bytes())
    boxes = {s: (args.input_dir / f'player_box_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
    schedules = {s: (args.input_dir / f'nba_schedule_{y}.parquet').read_bytes() for s, y in SEASONS.items()}
    snapshot = build_snapshot(boxes, date.fromisoformat(old['asOf']), datetime.now(timezone.utc).isoformat(), schedules)
    correct_initial_snapshot(snapshot, args.output)
    print('Corrected initial snapshot; normal daily GP regression checks remain enabled.')


if __name__ == '__main__':
    main()
