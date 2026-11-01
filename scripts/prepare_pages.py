"""Copy an audited Vite build into a clean publication directory, never the checkout."""
from pathlib import Path
import argparse
import json
import shutil
from pages_integrity import DATA_FILES, allowed_build_file, digest, source_manifest, validate_dependencies, validate_release

def deployment_manifest(source_sha, files=None):
    return source_manifest(source_sha, files)


def prepare(source, destination, source_sha):
    manifest = deployment_manifest(source_sha)
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if destination.exists() or source == destination or source in destination.parents or destination in source.parents:
        raise ValueError('Publication destination must be new and separate from build output')
    files = []
    for path in source.rglob('*'):
        relative = path.relative_to(source)
        if path.is_symlink():
            raise ValueError(f'Symlink forbidden: {relative}')
        if path.is_dir():
            continue
        allowed = allowed_build_file(relative.as_posix())
        if not allowed:
            raise ValueError(f'Unexpected build file: {relative}')
        files.append((path, relative))
    required = [source / 'index.html', *(source / 'data' / name for name in DATA_FILES)]
    if not all(p.is_file() for p in required):
        raise ValueError('Incomplete build: index or required production data missing')
    validate_dependencies(source)
    destination.mkdir(parents=True)
    for path, relative in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    (destination / '.nojekyll').touch()
    # Generated from the authorized checkout, never accepted from public/ or dist/.
    # No timestamp: repeated publication of the same commit stays idempotent.
    manifest = deployment_manifest(source_sha, {
        path.relative_to(destination).as_posix(): digest(path)
        for path in sorted(destination.rglob('*')) if path.is_file()
    })
    (destination / 'deployment-manifest.json').write_text(
        json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n', encoding='utf-8')
    validate_release(destination, source_sha)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    prepare(args.source, args.destination, args.source_sha)
