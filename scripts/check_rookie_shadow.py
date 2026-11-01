"""Check production isolation and an append-only prospective ledger against a base."""
import argparse
from pathlib import Path
import subprocess
from rookie_shadow import ROOT, verify_ledger

PROTECTED = ['public/data', 'src', 'tests/fixtures', 'scripts/rookie-parameters.json',
             'scripts/rookie-profiles.json', 'scripts/rookie-acceptance-criteria.json',
             'scripts/rookie_model.py', 'scripts/generate_projections.py',
             'scripts/refresh_projections.py', '.github/workflows/refresh-stats.yml',
             '.github/workflows/ci.yml', 'docs/stage-14-1-revision-frozen-parameters.json',
             'docs/stage-14-1-revision-backtest.json']


def check_ledger_history(base, root=ROOT):
    # A main-relative diff alone misses changes to origins first added in this
    # Draft PR. Inspect every intervening commit, including merge resolutions.
    commits = subprocess.check_output(['git', 'rev-list', base+'..HEAD'], cwd=root, text=True).splitlines()
    for commit in commits:
        changes = subprocess.check_output(['git', 'diff-tree', '-m', '--no-commit-id', '--name-status',
                                           '--no-renames', '-r', commit, '--', 'research/rookie-shadow/records'],
                                          cwd=root, text=True)
        if any(line.split('\t')[0] != 'A' for line in changes.splitlines()):
            raise ValueError('Prospective record history changed in commit ' + commit)


def check(base):
    subprocess.run(['git', 'diff', '--exit-code', base, '--', *PROTECTED], cwd=ROOT, check=True)
    check_ledger_history(base)
    changes = subprocess.check_output(['git', 'diff', '--name-status', '--no-renames', base, '--',
                                      'research/rookie-shadow/records'], cwd=ROOT, text=True)
    if any(line.split('\t')[0] != 'A' for line in changes.splitlines()):
        raise ValueError('Existing prospective records may not be changed or removed')
    count = len(verify_ledger(ROOT/'research/rookie-shadow/records'))
    print('Production/golden/legacy bytes unchanged; verified prospective records:', count)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True)
    check(parser.parse_args().base)
