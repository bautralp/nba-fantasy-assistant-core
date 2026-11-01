"""Verify canonical production HTML, manifest and every release file by SHA-256."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from urllib.parse import quote
from pages_integrity import validate_release

ORIGIN = 'https://nba-fantasy-assistant.github.io'


def check_file(root, name, url, deadline):
    expected = (root / name).read_bytes()
    request = Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'nba-fantasy-assistant-verifier'})
    with urlopen(request, timeout=max(.1, min(20, deadline - time.monotonic()))) as response:
        if hasattr(response, 'geturl') and response.geturl() != url:
            raise ValueError(f'Unexpected publication redirect: {name}')
        content_type = response.headers.get_content_type() if hasattr(response, 'headers') else None
        if content_type is not None:
            allowed = {'.js': {'text/javascript', 'application/javascript'}, '.css': {'text/css'}, '.html': {'text/html'}}.get(Path(name).suffix)
            if allowed and content_type not in allowed:
                raise ValueError(f'Wrong content type for {name}: {content_type}')
        actual = response.read(len(expected) + 1)
    if hashlib.sha256(actual).digest() != hashlib.sha256(expected).digest():
        raise ValueError(f'Production byte/SHA-256 mismatch: {name}')


def verify_pages(publication_dir, site_url, expected_sha, timeout=900, interval=15, allow_retained=False):
    if site_url != ORIGIN:
        raise ValueError('Expected the verified GitHub Pages HTTPS production origin')
    root = Path(publication_dir).resolve()
    manifest = validate_release(root, expected_sha, allow_retained=allow_retained)
    paths = set(manifest['files']) | {'deployment-manifest.json'}
    if allow_retained:
        paths.update(p.relative_to(root).as_posix() for p in (root / 'assets').rglob('*') if p.is_file())
    paths = sorted(paths)
    deadline = time.monotonic() + timeout
    while True:
        # Canonical URLs MUST match too. A cache-busted success cannot hide stale HTML.
        urls = [(name, site_url + '/' + quote(name)) for name in paths]
        urls += [('index.html', site_url + '/'),
                 ('index.html', site_url + '/?publication_probe=' + str(time.time_ns()))]
        try:
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = [pool.submit(check_file, root, name, url, deadline) for name, url in urls]
                for future in futures:
                    future.result()
            print(f'Production release verified: sourceCommit={expected_sha}; canonical HTML, manifest and {len(manifest["files"])} file hashes match.', flush=True)
            return
        except (URLError, OSError, ValueError) as error:
            print(f'Production not yet verified: {error}', flush=True)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Production publication not verified: HTML/manifest/assets/data do not match the authorized release')
        time.sleep(min(interval, remaining))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication-dir', type=Path, required=True)
    parser.add_argument('--site-url', required=True)
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--allow-retained', action='store_true')
    parser.add_argument('--timeout', type=float, default=900)
    args = parser.parse_args()
    if args.timeout < 0:
        parser.error('timeout must not be negative')
    verify_pages(args.publication_dir, args.site_url, args.expected_sha, args.timeout, allow_retained=args.allow_retained)
