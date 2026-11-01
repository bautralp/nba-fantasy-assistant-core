"""Release integrity, exact production bytes and both publication triggers; no network."""
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlparse
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from prepare_pages import prepare, DATA_FILES
from pages_integrity import validate_release, validate_dependencies, digest
from stage_pages import stage, verify_index
from verify_pages import verify_pages, ORIGIN


class PagesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sha = 'a' * 40
        self.dist = self.root / 'dist'
        (self.dist / 'data').mkdir(parents=True)
        (self.dist / 'assets').mkdir()
        (self.dist / 'fonts').mkdir()
        (self.dist / 'index.html').write_text('<div id="root"></div><script type="module" src="/assets/index-aaaa.js"></script><link rel="stylesheet" href="/assets/index-aaaa.css">')
        (self.dist / 'assets/index-aaaa.js').write_text('import "./chunk-aaaa.js"; document.title="release-a";')
        (self.dist / 'assets/chunk-aaaa.js').write_text('export const ready=true;')
        (self.dist / 'assets/index-aaaa.css').write_text('@font-face{src:url(/fonts/a.woff2)}')
        (self.dist / 'fonts/a.woff2').write_bytes(b'font')
        for name in DATA_FILES:
            (self.dist / 'data' / name).write_bytes(b'{"revision":"a"}\n')
        self.output = self.root / 'output'
        prepare(self.dist, self.output, self.sha)

    def git(self, target, *args):
        return subprocess.check_output(['git', '-C', str(target), *args], stderr=subprocess.DEVNULL)

    def repository(self):
        target = self.root / 'target'
        shutil.copytree(self.output, target)
        self.git(target, 'init', '-q')
        self.git(target, 'remote', 'add', 'origin', 'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io.git')
        self.git(target, 'config', 'user.name', 'Synthetic publication')
        self.git(target, 'config', 'user.email', 'tests@example.invalid')
        self.commit(target)
        return target

    def commit(self, target):
        self.git(target, 'add', '--all')
        self.git(target, 'commit', '-qm', 'Synthetic publication')

    def response(self, request, **kwargs):
        name = urlparse(request.full_url).path.lstrip('/') or 'index.html'
        return io.BytesIO((self.output / name).read_bytes())

    def verify(self, timeout=0):
        verify_pages(self.output, ORIGIN, self.sha, timeout)

    def test_inventory_binds_authorized_sha_html_js_css_fonts_and_all_data(self):
        manifest = validate_release(self.output, self.sha)
        self.assertEqual(manifest['schemaVersion'], 2)
        self.assertEqual(manifest['sourceCommit'], self.sha)
        self.assertIn('assets/chunk-aaaa.js', manifest['files'])
        for name, checksum in manifest['files'].items():
            self.assertEqual(digest(self.output / name), checksum)
        with patch('verify_pages.urlopen', side_effect=self.response) as fetch:
            self.verify()
        paths = {urlparse(c.args[0].full_url).path for c in fetch.call_args_list}
        self.assertTrue({'/', '/index.html', '/assets/index-aaaa.js', '/assets/index-aaaa.css', '/assets/chunk-aaaa.js', '/deployment-manifest.json'}.issubset(paths))
        self.assertTrue(all(c.args[0].get_header('Cache-control') == 'no-cache' for c in fetch.call_args_list))

    def test_source_private_files_maps_and_symlinks_are_rejected_before_copy(self):
        for name in ['.env', '.git/config', '.github/workflows/leak.yml', 'src/main.tsx', 'deployment-manifest.json', 'research/model.json', 'data/credentials.json', 'assets/index.js.map']:
            with self.subTest(name=name):
                path = self.dist / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('private')
                with self.assertRaises(ValueError): prepare(self.dist, self.root / 'bad', self.sha)
                self.assertFalse((self.root / 'bad').exists())
                path.unlink()
        (self.dist / 'assets/link.js').symlink_to(self.dist / 'index.html')
        with self.assertRaises(ValueError): prepare(self.dist, self.root / 'bad', self.sha)

    def test_missing_entry_css_chunk_font_and_html_masquerading_as_js_fail(self):
        for name in ['assets/index-aaaa.js', 'assets/index-aaaa.css', 'assets/chunk-aaaa.js', 'fonts/a.woff2']:
            path = self.dist / name
            content = path.read_bytes()
            with self.subTest(name=name):
                path.unlink()
                with self.assertRaises(ValueError): prepare(self.dist, self.root / 'missing', self.sha)
                self.assertFalse((self.root / 'missing').exists())
                path.write_bytes(content)
        (self.dist / 'assets/index-aaaa.js').write_text('<!doctype html><html>fallback</html>')
        with self.assertRaises(ValueError): validate_dependencies(self.dist)

    def test_production_missing_or_wrong_html_css_js_or_data_is_not_success(self):
        for name in ['index.html', 'deployment-manifest.json', 'assets/index-aaaa.js', 'assets/index-aaaa.css', *('data/' + n for n in DATA_FILES)]:
            def response(request, **kwargs):
                current = urlparse(request.full_url).path.lstrip('/') or 'index.html'
                if current == name:
                    if name.endswith('.js'): raise HTTPError(request.full_url, 404, 'missing', {}, None)
                    return io.BytesIO(b'old bytes')
                return self.response(request, **kwargs)
            with self.subTest(name=name), patch('verify_pages.urlopen', side_effect=response), self.assertRaises(RuntimeError): self.verify()

    def test_good_query_probe_cannot_hide_stale_canonical_html(self):
        def response(request, **kwargs):
            parsed = urlparse(request.full_url)
            if parsed.path in {'/', '/index.html'} and not parsed.query:
                return io.BytesIO(b'old HTML')
            return self.response(request, **kwargs)
        with patch('verify_pages.urlopen', side_effect=response), self.assertRaises(RuntimeError): self.verify()

    def test_correct_bytes_with_html_mime_for_js_is_rejected(self):
        from email.message import Message
        def response(request, **kwargs):
            result = self.response(request, **kwargs)
            result.headers = Message()
            result.headers['Content-Type'] = 'text/html' if request.full_url.endswith('.js') else ({'.css':'text/css','.html':'text/html'}.get(Path(urlparse(request.full_url).path.lstrip('/') or 'index.html').suffix, 'application/octet-stream'))
            return result
        with patch('verify_pages.urlopen', side_effect=response), self.assertRaises(RuntimeError): self.verify()

    def test_wrong_source_tampering_and_manifest_cannot_pass_before_network(self):
        with patch('verify_pages.urlopen') as fetch, self.assertRaises(ValueError): verify_pages(self.output, ORIGIN, 'b'*40, 0)
        fetch.assert_not_called()
        for name in ['index.html', 'assets/index-aaaa.js', 'assets/index-aaaa.css']:
            path = self.output / name
            old = path.read_bytes()
            path.write_bytes(old + b' ')
            with self.subTest(name=name), self.assertRaises(ValueError): validate_release(self.output, self.sha)
            path.write_bytes(old)
        with self.assertRaises(ValueError): verify_pages(self.output, 'http://nba-fantasy-assistant.github.io', self.sha, 0)

    def test_manifest_cannot_authorize_private_files_or_missing_transitive_import(self):
        secret = self.output / 'src/private.js'
        secret.parent.mkdir()
        secret.write_text('private')
        manifest = json.loads((self.output / 'deployment-manifest.json').read_text())
        manifest['files']['src/private.js'] = digest(secret)
        (self.output / 'deployment-manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(ValueError): validate_release(self.output, self.sha)
        (self.dist / 'assets/index-aaaa.js').write_text('import("./missing.js");')
        with self.assertRaises(ValueError): validate_dependencies(self.dist)

    def test_missing_retained_asset_in_production_is_not_success(self):
        (self.output / 'assets/previous.js').write_text('export const cached=true;')
        def response(request, **kwargs):
            if urlparse(request.full_url).path == '/assets/previous.js':
                raise HTTPError(request.full_url, 404, 'cached asset unavailable', {}, None)
            return self.response(request, **kwargs)
        with patch('verify_pages.urlopen', side_effect=response), self.assertRaises(RuntimeError):
            verify_pages(self.output, ORIGIN, self.sha, timeout=0, allow_retained=True)

    def test_delayed_publication_retries_whole_release(self):
        failed = False
        def response(request, **kwargs):
            nonlocal failed
            if request.full_url == ORIGIN + '/' and not failed:
                failed = True
                return io.BytesIO(b'old HTML')
            return self.response(request, **kwargs)
        with patch('verify_pages.urlopen', side_effect=response), patch('verify_pages.time.sleep') as sleep:
            self.verify(timeout=60)
        sleep.assert_called_once()

    def test_code_push_and_daily_data_refresh_ignore_equal_size_and_mtime(self):
        for trigger in ['code-push', 'daily-refresh']:
            with self.subTest(trigger=trigger), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'target'
                shutil.copytree(self.output, target)
                self.git(target, 'init', '-q'); self.git(target, 'remote', 'add', 'origin', 'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io.git'); self.git(target, 'config', 'user.name', 'test'); self.git(target, 'config', 'user.email', 'test@example.invalid'); self.commit(target)
                changed = Path(directory) / 'build'
                shutil.copytree(self.dist, changed)
                if trigger == 'code-push':
                    (changed / 'index.html').write_text((changed / 'index.html').read_text().replace('index-aaaa', 'index-bbbb'))
                    for extension in ['js', 'css']:
                        (changed / f'assets/index-aaaa.{extension}').rename(changed / f'assets/index-bbbb.{extension}')
                else:
                    for name in DATA_FILES:
                        path = changed / 'data' / name
                        path.write_bytes(path.read_bytes().replace(b'"a"', b'"b"'))
                output = Path(directory) / 'release'
                prepare(changed, output, 'b'*40)
                for root in [target, output]:
                    for path in root.rglob('*'):
                        if path.is_file(): os.utime(path, (1700000000, 1700000000))
                self.assertEqual((output / 'index.html').stat().st_size, (target / 'index.html').stat().st_size)
                stage(output, target, 'b'*40)
                self.assertEqual((target / 'index.html').read_bytes(), (output / 'index.html').read_bytes())
                self.assertEqual((target / 'deployment-manifest.json').read_bytes(), (output / 'deployment-manifest.json').read_bytes())
                for name in DATA_FILES: self.assertEqual((target / 'data' / name).read_bytes(), (output / 'data' / name).read_bytes())
                self.assertTrue((target / 'assets/index-aaaa.js').exists())
                verify_index(target, 'b'*40)

    def test_recovers_assets_deleted_by_bad_publication_from_public_history(self):
        target = self.repository()
        (target / 'assets/index-aaaa.js').unlink()
        self.commit(target)
        stage(self.output, target, self.sha)
        self.assertTrue((target / 'assets/index-aaaa.js').exists())
        verify_index(target, self.sha)

    def test_immutable_asset_reuse_and_dirty_clone_are_rejected(self):
        target = self.repository()
        (target / 'index.html').write_text('dirty')
        with self.assertRaises(ValueError): stage(self.output, target, self.sha)
        self.git(target, 'reset', '--hard', '-q', 'HEAD')
        (self.dist / 'assets/index-aaaa.js').write_text('different valid JavaScript;')
        release = self.root / 'collision'
        prepare(self.dist, release, 'b'*40)
        with self.assertRaises(ValueError): stage(release, target, 'b'*40)

    def test_wrong_repository_is_rejected_without_modifying_files(self):
        target = self.repository()
        self.git(target, 'remote', 'set-url', 'origin', 'https://github.com/bautralp/nba-fantasy-assistant.git')
        before = (target / 'index.html').read_bytes()
        with self.assertRaises(ValueError): stage(self.output, target, self.sha)
        self.assertEqual((target / 'index.html').read_bytes(), before)
        self.assertFalse(self.git(target, 'status', '--porcelain').strip())

    def test_git_index_must_match_validated_worktree(self):
        target = self.repository()
        self.git(target, 'update-index', '--assume-unchanged', 'index.html')
        (self.dist / 'index.html').write_text((self.dist / 'index.html').read_text() + ' ')
        release = self.root / 'updated'
        prepare(self.dist, release, 'b'*40)
        shutil.copytree(release, target, dirs_exist_ok=True)
        self.git(target, 'add', '--all')
        validate_release(target, 'b'*40)
        with self.assertRaises(ValueError): verify_index(target, 'b'*40)

    @unittest.skipUnless(shutil.which('rsync'), 'Optional forensic reproduction requires rsync; content-copy regressions run everywhere')
    def test_legacy_rsync_reproduces_mixed_release_then_new_stager_repairs_it(self):
        target = self.repository()
        (self.dist / 'index.html').write_text((self.dist / 'index.html').read_text().replace('index-aaaa', 'index-bbbb'))
        for extension in ['js', 'css']:
            (self.dist / f'assets/index-aaaa.{extension}').rename(self.dist / f'assets/index-bbbb.{extension}')
        release = self.root / 'new'
        prepare(self.dist, release, 'b'*40)
        for root in [target, release]:
            for path in root.rglob('*'):
                if path.is_file(): os.utime(path, (1700000000, 1700000000))
        self.assertEqual((target / 'index.html').stat().st_size, (release / 'index.html').stat().st_size)
        self.assertEqual((target / 'deployment-manifest.json').stat().st_size, (release / 'deployment-manifest.json').stat().st_size)
        subprocess.run(['rsync', '-a', '--delete', '--exclude=.git/', str(release) + '/', str(target) + '/'], check=True)
        self.assertEqual((target / 'index.html').read_bytes(), (self.output / 'index.html').read_bytes())
        self.assertEqual(json.loads((target / 'deployment-manifest.json').read_text())['sourceCommit'], self.sha)
        self.assertFalse((target / 'assets/index-aaaa.js').exists())
        self.commit(target)
        stage(release, target, 'b'*40)
        self.assertTrue((target / 'assets/index-aaaa.js').exists())
        self.assertEqual((target / 'index.html').read_bytes(), (release / 'index.html').read_bytes())

    def test_same_commit_is_deterministic_and_invalid_sha_destination_fail(self):
        other = self.root / 'repeat'; prepare(self.dist, other, self.sha)
        self.assertEqual((other / 'deployment-manifest.json').read_bytes(), (self.output / 'deployment-manifest.json').read_bytes())
        for sha in ['', 'main', 'A'*40, 'a'*39, '../secret']:
            with self.subTest(sha=sha), self.assertRaises(ValueError): prepare(self.dist, self.root / 'bad', sha)
        with self.assertRaises(ValueError): prepare(self.dist, self.output, self.sha)
        (self.dist / 'data/player-stats.json').unlink()
        with self.assertRaises(ValueError): prepare(self.dist, self.root / 'missing-data', self.sha)
