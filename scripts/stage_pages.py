"""Stage a complete release by bytes; retain immutable public assets for cached HTML.

No mtime/size quick-check, no force push, no deletion of prior content-addressed
assets. Recover deleted assets from the public branch's history on the first fix.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tempfile
from pages_integrity import retained_asset, safe_path, validate_release


def git(target, *args):
    return subprocess.check_output(['git', '-C', str(target), *args])


def retained_history(target, candidate):
    commits = git(target, 'rev-list', 'HEAD').decode().splitlines()
    blobs = {}
    for commit in commits:
        for row in git(target, 'ls-tree', '-rz', commit, '--', 'assets/').split(b'\0'):
            if not row:
                continue
            metadata, raw_name = row.split(b'\t', 1)
            mode, kind, blob = metadata.decode().split()
            name = raw_name.decode('utf-8')
            if kind != 'blob' or mode not in {'100644', '100755'} or not retained_asset(name):
                raise ValueError(f'Unsafe historical asset: {name}')
            if name in blobs and blobs[name] != blob:
                raise ValueError(f'Asset path was reused for different contents: {name}')
            if name not in blobs:
                destination = safe_path(candidate, name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(git(target, 'cat-file', 'blob', blob))
                blobs[name] = blob


def verify_index(target, expected_sha):
    manifest = validate_release(target, expected_sha, allow_retained=True)
    expected_manifest = (target / 'deployment-manifest.json').read_bytes()
    if git(target, 'show', ':deployment-manifest.json') != expected_manifest:
        raise ValueError('Staged manifest differs from the validated release')
    expected_paths = set(manifest['files']) | {'deployment-manifest.json'}
    for raw_name in git(target, 'ls-files', '-z').split(b'\0'):
        if not raw_name:
            continue
        name = raw_name.decode('utf-8')
        if name not in expected_paths and not retained_asset(name):
            raise ValueError(f'Unexpected staged publication file: {name}')
        actual = git(target, 'show', ':' + name)
        if actual != safe_path(target, name).read_bytes():
            raise ValueError(f'Staged bytes differ from working publication: {name}')
    for name, expected in manifest['files'].items():
        if hashlib.sha256(git(target, 'show', ':' + name)).hexdigest() != expected:
            raise ValueError(f'Staged release SHA-256 mismatch: {name}')


def stage(source, target, expected_sha):
    source, target = Path(source).resolve(), Path(target).resolve()
    validate_release(source, expected_sha)
    if source == target or source in target.parents or target in source.parents or not (target / '.git').is_dir():
        raise ValueError('Expected a separate public Git clone as publication target')
    origin = git(target, 'remote', 'get-url', 'origin').decode().strip()
    if origin not in {'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io.git', 'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io'}:
        raise ValueError('Refusing to modify a clone outside the verified public publishing repository')
    if git(target, 'status', '--porcelain').strip():
        raise ValueError('Publication clone must be clean before staging')
    with tempfile.TemporaryDirectory(prefix='pages-candidate-') as directory:
        candidate = Path(directory)
        retained_history(target, candidate)
        for path in source.rglob('*'):
            if not path.is_file():
                continue
            name = path.relative_to(source).as_posix()
            destination = safe_path(candidate, name)
            if retained_asset(name) and destination.exists() and destination.read_bytes() != path.read_bytes():
                raise ValueError(f'Immutable asset collision: {name}')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)  # Always copy contents, even if size and mtime match.
        validate_release(candidate, expected_sha, allow_retained=True)
        for path in target.iterdir():
            if path.name == '.git':
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        for path in candidate.rglob('*'):
            if path.is_file():
                destination = target / path.relative_to(candidate)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
    validate_release(target, expected_sha, allow_retained=True)
    git(target, 'add', '--all')
    verify_index(target, expected_sha)
    print(f'Staged publication verified by SHA-256 and Git index: sourceCommit={expected_sha}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    stage(args.source, args.target, args.source_sha)
