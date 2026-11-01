"""Observe the exact committed snapshot at the public URL; do not assume a deploy.

A push or deployment preview alone is not production evidence. A mismatch/timeout
fails the workflow even if the data commit itself succeeded. No deploy is forced.
Pages uses strict byte hashing; legacy callers retain JSON normalization.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def payload_hash(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def verify_published(snapshot, url, timeout=600, interval=15, exact_bytes=False):
    expected_bytes = Path(snapshot).read_bytes()
    expected = json.loads(expected_bytes)
    expected_hash = hashlib.sha256(expected_bytes).hexdigest() if exact_bytes else payload_hash(expected)
    separator = '&' if '?' in url else '?'
    deadline = time.monotonic() + timeout
    while True:
        try:
            # A fresh probe also escapes a cached stale response for this expected hash.
            probe_url = url + separator + urlencode({'snapshot_sha256': expected_hash,
                                                     'probe': time.time_ns()})
            request = Request(probe_url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'nba-fantasy-assistant-verifier'})
            with urlopen(request, timeout=max(0.1, min(20, deadline - time.monotonic()))) as response:
                if hasattr(response, "geturl") and response.geturl() != probe_url:
                    raise ValueError("Unexpected publication redirect")
                body = response.read(5_000_001)
                actual = json.loads(body)
            actual_hash = hashlib.sha256(body).hexdigest() if exact_bytes else payload_hash(actual)
            if actual_hash == expected_hash:
                print(f'Public snapshot verified: {url}, sha256={expected_hash}, refreshedAt={actual.get("refreshedAt", actual.get("attemptedAt"))}', flush=True)
                return
        except (URLError, OSError, ValueError):
            # A build can still be pending; only the exact matching payload is success.
            print('Public snapshot unavailable or invalid; awaiting publication.', flush=True)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Production publication not verified: the public JSON does not match the committed snapshot')
        time.sleep(min(interval, remaining))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--timeout', type=float, default=600)
    args = parser.parse_args()
    if args.timeout < 0:
        parser.error('timeout must not be negative')
    verify_published(args.snapshot, args.url, args.timeout)


if __name__ == '__main__':
    main()
