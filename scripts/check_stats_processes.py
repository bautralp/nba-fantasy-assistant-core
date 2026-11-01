"""Require real exit code 0 after tests AND the production refresh CLI, repeatedly.

Fresh interpreters catch native teardown aborts occurring after unittest prints
OK. Uses pinned real provider fixtures offline; never modifies the public JSON.
"""
import argparse
from importlib.metadata import version
import platform
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('repetitions must be positive')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repetitions', type=positive, default=5)
    args = parser.parse_args()
    print(f'Runtime: Python {platform.python_version()}, {platform.platform()}, PyArrow {version("pyarrow")}', flush=True)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'player-stats.json'
        for i in range(args.repetitions):
            print(f'Fresh test process {i+1}/{args.repetitions}', flush=True)
            subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/stats', '-v'], cwd=ROOT, check=True)
            print(f'Test process {i+1}: exit code 0', flush=True)
            print(f'Fresh production refresh process {i+1}/{args.repetitions}', flush=True)
            subprocess.run([sys.executable, 'scripts/refresh_stats.py', '--input-dir',
                            'tests/fixtures/stats', '--as-of', '2026-10-22', '--output', str(output)], cwd=ROOT, check=True)
            print(f'Refresh process {i+1}: exit code 0', flush=True)
    print(f'All {args.repetitions} test processes and {args.repetitions} refresh processes exited 0.', flush=True)


if __name__ == '__main__':
    main()
