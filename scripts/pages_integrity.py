"""Content-based release contract: source SHA, every public byte and Vite dependencies."""
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

SCHEMA_VERSION = 2
DATA_FILES = frozenset(('player-stats.json', 'player-projections.json', 'fantasy-positions.json', 'current-rosters.json', 'projection-refresh-status.json', 'analysis-schedule.json', 'projection-scenarios.json'))

BUILD_EXTENSIONS = {'assets': {'.js', '.css', '.svg', '.png', '.jpg', '.webp', '.woff2'},
                    'fonts': {'.woff', '.woff2', '.ttf', '.otf'},
                    'data': {'.json'}, 'legacy': {'.html', '.js', '.css'}}


def allowed_build_file(name):
    parts = Path(name).parts
    return name in {'index.html', 'fonts/OFL-Michroma.txt'} or (
        len(parts) >= 2 and parts[0] in BUILD_EXTENSIONS
        and Path(name).suffix in BUILD_EXTENSIONS[parts[0]]
        and not any(part.startswith('.') for part in parts)
        and (parts[0] != 'data' or len(parts) == 2 and parts[1] in DATA_FILES))


def digest(path):
    return sha256(Path(path).read_bytes()).hexdigest()


def source_manifest(source_sha, files=None):
    if not re.fullmatch(r'[0-9a-f]{40}', source_sha):
        raise ValueError('Expected a full lowercase Git source commit SHA')
    return {'schemaVersion': SCHEMA_VERSION, 'sourceCommit': source_sha, 'files': files or {}}


def safe_path(root, name):
    if not isinstance(name, str) or not name or name.startswith('/') or '\\' in name:
        raise ValueError(f'Unsafe release path: {name!r}')
    path = Path(name)
    if any(p in ('.', '..') or p.startswith('.') and name != '.nojekyll' for p in name.split('/')):
        raise ValueError(f'Unsafe release path: {name!r}')
    resolved = root / path
    if resolved.is_symlink() or any(p.is_symlink() for p in resolved.parents if p != root.parent):
        raise ValueError(f'Symlink forbidden: {name}')
    if not resolved.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Release path escapes root: {name}')
    return resolved


class EntryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []
        self.modules = []
        self.styles = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.references.append(attrs['src'])
            if attrs.get('type') == 'module':
                self.modules.append(attrs['src'])
        if tag == 'link' and set(attrs.get('rel', '').split()) & {'stylesheet', 'modulepreload', 'preload'}:
            if attrs.get('href'):
                self.references.append(attrs['href'])
            if 'stylesheet' in attrs.get('rel', '').split() and attrs.get('href'):
                self.styles.append(attrs['href'])


def reference_path(root, owner, url):
    parsed = urlsplit(url)
    if parsed.scheme == 'data' or url.startswith('#'):
        return None
    if parsed.scheme or parsed.netloc or '\\' in url:
        raise ValueError(f'Non-local build dependency in {owner}: {url}')
    name = unquote(parsed.path)
    if name.startswith('/'):
        candidate = root / name.lstrip('/')
    elif name.startswith('assets/'):
        candidate = root / name
    else:
        candidate = (root / owner).parent / name
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise ValueError(f'Dependency escapes publication: {url}')
    relative = resolved.relative_to(root.resolve()).as_posix()
    path = safe_path(root, relative)
    if not path.is_file():
        raise ValueError(f'Missing dependency: {owner} -> {relative}')
    return relative


def validate_dependencies(root):
    root = Path(root).resolve()
    html = (root / 'index.html').read_text(encoding='utf-8')
    parser = EntryParser()
    parser.feed(html)
    if not parser.modules or not parser.styles:
        raise ValueError('Build index must reference a module script and a stylesheet')
    for refs, suffix in [(parser.modules, '.js'), (parser.styles, '.css')]:
        for ref in refs:
            name = reference_path(root, 'index.html', ref)
            if name is None or Path(name).suffix != suffix:
                raise ValueError(f'Invalid entry dependency: {ref}')
    queue = [('index.html', ref) for ref in parser.references]
    seen = {'index.html'}
    while queue:
        owner, ref = queue.pop()
        name = reference_path(root, owner, ref)
        if name is None or name in seen:
            continue
        seen.add(name)
        path = root / name
        if path.suffix not in {'.js', '.css'}:
            continue
        text = path.read_text(encoding='utf-8')
        if not text.strip() or re.match(r'\s*(?:<!doctype\s+html|<html)', text, re.I):
            raise ValueError(f'Invalid JS/CSS content: {name}')
        if path.suffix == '.css':
            refs = re.findall(r'url\(\s*["\']?([^\s)"\']+)', text)
            refs += re.findall(r'@import\s+["\']([^"\']+)', text)
        else:
            # Vite's relative chunk imports, dynamic imports and preload dependency strings.
            refs = re.findall(r'["\']((?:\./|\.\./|/assets/|assets/)[^"\'\s?]+\.(?:js|css|woff2?|svg|png|webp|jpg))(?:\?[^"\']*)?["\']', text)
            refs += re.findall(r'\bimport\s*\(\s*["\']([^"\']+)["\']', text)
            refs += re.findall(r'\b(?:import|export)\s+(?:[^;\n"\']*?\s+from\s*)?["\']([^"\']+)["\']', text)
        queue.extend((name, ref) for ref in refs)
    return seen


def validate_release(root, expected_sha, allow_retained=False):
    root = Path(root).resolve()
    manifest = json.loads((root / 'deployment-manifest.json').read_text(encoding='utf-8'))
    files = manifest.get('files')
    if not isinstance(files, dict) or not files or manifest != source_manifest(expected_sha, files):
        raise ValueError('Deployment manifest/source SHA/inventory does not match the authorized release')
    if not {'index.html', '.nojekyll', *(f'data/{name}' for name in DATA_FILES)}.issubset(files) or 'deployment-manifest.json' in files:
        raise ValueError('Incomplete release inventory')
    for name, expected in files.items():
        if name != '.nojekyll' and not allowed_build_file(name):
            raise ValueError(f'Forbidden release file: {name}')
        path = safe_path(root, name)
        if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
            raise ValueError(f'Invalid SHA-256: {name}')
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f'Release file missing or SHA-256 mismatch: {name}')
        if name.startswith('data/') and name.endswith('.json'):
            json.loads(path.read_text(encoding='utf-8'))
    for path in root.rglob('*'):
        relative = path.relative_to(root).as_posix()
        if relative == '.git' or relative.startswith('.git/'):
            continue
        if path.is_symlink():
            raise ValueError(f'Symlink forbidden: {relative}')
        if not path.is_file() or relative in files or relative == 'deployment-manifest.json':
            continue
        if not allow_retained or not retained_asset(relative):
            raise ValueError(f'Unlisted publication file: {relative}')
    dependencies = validate_dependencies(root)
    if not dependencies.issubset(files):
        raise ValueError('Current index depends on files outside its release inventory')
    return manifest


def retained_asset(name):
    return name.startswith('assets/') and not any(p.startswith('.') or p == '..' for p in name.split('/')) and '\\' not in name and Path(name).suffix in {'.js', '.css', '.svg', '.png', '.jpg', '.webp', '.woff2'}
