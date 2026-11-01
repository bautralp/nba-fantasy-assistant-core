"""Read historical raw files from an explicit PRIVATE pack, never Git or the network.

The public export intentionally contains identity/hash metadata only. Missing data
is a blocked validation, not a successful replay or a generated substitute.
"""
from pathlib import Path
import hashlib
import json
import os
import re

ROOT = Path(__file__).resolve().parents[1]

class PrivateValidationRequired(RuntimeError):
    pass

def catalog():
    return json.loads((ROOT / 'migration/baseline-index.json').read_text())

def private_root():
    if os.environ.get('NFA_VALIDATION_PROFILE') != 'private':
        raise PrivateValidationRequired('PRIVATE_VALIDATION_REQUIRED: historical data is excluded from public validation')
    value = os.environ.get('NFA_PRIVATE_BASELINE_ROOT')
    if not value:
        raise PrivateValidationRequired('PRIVATE_BASELINE_PACK_MISSING: explicitly configure an external private pack')
    root = Path(value).resolve()
    if root == ROOT or root.is_relative_to(ROOT):
        raise PrivateValidationRequired('PRIVATE_PACK_INSIDE_EXPORT: keep private data outside the public source tree')
    return root

def validate_bytes(raw, expected):
    if hashlib.sha256(raw).hexdigest() != expected['sha256']:
        raise ValueError('Historical SHA-256 mismatch')
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + bytes([0]) + raw).hexdigest()
    if blob != expected['git_blob_sha1']:
        raise ValueError('Historical Git blob identity mismatch')
    return raw

def read_historical(commit, path):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Full historical commit identity required')
    data = catalog()
    expected = data['files'].get(commit + ':' + path)
    if expected is None or path.startswith('/') or '..' in Path(path).parts:
        raise ValueError('Unknown or unsafe historical identity/path')
    root = private_root()
    file = root / commit / path
    if file.is_symlink() or not file.resolve().is_relative_to(root):
        raise ValueError('Unsafe historical pack path')
    if not file.is_file():
        raise PrivateValidationRequired('PRIVATE_BASELINE_FILE_MISSING: ' + commit + ':' + path)
    return validate_bytes(file.read_bytes(), expected)

def read_private_data(path):
    private_root()  # explicit private profile; no public-mode fallback
    expected = catalog().get('current_files', {}).get(path)
    value = os.environ.get('NFA_PRIVATE_DATA_ROOT')
    if expected is None or not value or path.startswith('/') or '..' in Path(path).parts:
        raise PrivateValidationRequired('PRIVATE_DATA_RESOURCE_MISSING: ' + path)
    root = Path(value).resolve()
    if root == ROOT or root.is_relative_to(ROOT):
        raise ValueError('Private data must remain outside the export')
    file = root / path
    if file.is_symlink() or not file.resolve().is_relative_to(root):
        raise ValueError('Unsafe private data path')
    return validate_bytes(file.read_bytes(), expected)

def check_identity(commit):
    if commit not in catalog()['identities']:
        raise ValueError('Unknown historical identity')
    private_root()
    paths = [k.split(':', 1)[1] for k in catalog()['files'] if k.startswith(commit + ':')]
    if not paths:
        raise PrivateValidationRequired('PRIVATE_SCOPE_PACK_MISSING: no raw file pack is available for this identity')
    for path in paths:
        read_historical(commit, path)
    return len(paths)

def check_scope(commit, paths, current_root):
    private_root()
    scope = next((x for x in catalog()['scopes'] if x['commit'] == commit and x['paths'] == paths), None)
    if scope is None:
        raise ValueError('Unknown historical path scope')
    root = Path(current_root).resolve()
    expected = {x['path']: x for x in scope['files']}
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()
              and '.git' not in p.relative_to(root).parts and 'node_modules' not in p.relative_to(root).parts
              and any(p.relative_to(root).as_posix() == z or p.relative_to(root).as_posix().startswith(z.rstrip('/') + '/') for z in paths)}
    if actual != set(expected):
        raise ValueError('Historical scope membership mismatch (added, deleted or renamed file)')
    for path, meta in expected.items():
        file = root / path
        if file.is_symlink():
            raise ValueError('Historical scope symlink')
        validate_bytes(file.read_bytes(), meta)
        if bool(file.stat().st_mode & 0o111) != (meta['mode'] == '100755'):
            raise ValueError('Historical executable mode mismatch')
    return len(expected)

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--identity', required=True)
    parser.add_argument('--scope-json')
    args = parser.parse_args()
    try:
        count = check_scope(args.identity, json.loads(args.scope_json), ROOT) if args.scope_json else check_identity(args.identity)
    except (PrivateValidationRequired, ValueError) as error:
        print(json.dumps({'status': 'blocked', 'scope': 'private-only', 'reason': str(error)}))
        raise SystemExit(2)
    print(json.dumps({'status': 'verified', 'scope': 'private-only', 'files': count}))
