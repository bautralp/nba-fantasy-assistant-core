import { replayInputBytes, legacyScenario } from '../helpers/unifiedScenario.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { verifyProjectionPublication } from '../../scripts/verify_projection_publication.ts';

const standardBytes = replayInputBytes('player-projections.json');
const candidateBytes = gunzipSync(readFileSync('docs/season/unified-ros/candidate.json.gz'));
const candidate = JSON.parse(candidateBytes.toString());
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const dataFiles = ['player-stats.json', 'player-projections.json', 'projection-scenarios.json', 'analysis-schedule.json', 'fantasy-positions.json', 'current-rosters.json', 'projection-refresh-status.json'];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'projection-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = join(root, 'build');
  mkdirSync(join(build, 'data'), { recursive: true });
  writeFileSync(join(build, 'data/player-projections.json'), standardBytes);
  writeFileSync(join(build, 'data/projection-scenarios.json'), candidateBytes);
  return { root, build };
}

test('publication accepts the independently replayed v2 pair without changing either file', t => {
  const { build } = fixture(t);
  const result = verifyProjectionPublication(build);
  assert.deepEqual(result, { modelVersion: 'unified-ros/2', asOf: candidate.asOf, standardGeneratedAt: candidate.standardGeneratedAt, standardSHA256: hash(standardBytes) });
  assert.deepEqual(readFileSync(join(build, 'data/player-projections.json')), standardBytes);
  assert.deepEqual(readFileSync(join(build, 'data/projection-scenarios.json')), candidateBytes);
});

test('publication refuses real legacy data, a version-only relabel, unknown versions and scientific-gate changes', t => {
  const { build } = fixture(t);
  const legacy = structuredClone(legacyScenario);
  for (const invalid of [legacy, { ...legacy, modelVersion: 'unified-ros/2' }, { ...candidate, modelVersion: 'unified-ros/3' }, { ...candidate, scientificGatesEnabled: true }, { ...candidate, modelVersion: undefined }]) {
    writeFileSync(join(build, 'data/projection-scenarios.json'), JSON.stringify(invalid));
    assert.throws(() => verifyProjectionPublication(build));
  }
});

test('publication rejects internally consistent scenario dates or sources belonging to another Standard snapshot', t => {
  const { build } = fixture(t);
  for (const field of ['asOf', 'generatedAt', 'sources']) {
    const value = structuredClone(candidate);
    if (field === 'asOf') {
      value.asOf = value.projection.asOf = '2026-10-26';
      value.projection.players.forEach((p: { asOf: string }) => { p.asOf = value.asOf; });
    } else if (field === 'generatedAt') {
      value.standardGeneratedAt = value.projection.generatedAt = value.projection.refreshedAt = '2026-10-25T23:59:00Z';
      value.projection.players.forEach((p: { generatedAt: string }) => { p.generatedAt = value.standardGeneratedAt; });
    } else {
      value.standardSources[0].sha256 = 'b'.repeat(64);
      value.projection.sources[0].sha256 = 'b'.repeat(64);
    }
    writeFileSync(join(build, 'data/projection-scenarios.json'), JSON.stringify(value));
    assert.throws(() => verifyProjectionPublication(build), /kaynağı veya revizyonu/);
  }
});

test('publication binds the actual Standard file bytes, not just matching dates/source metadata', t => {
  const { build } = fixture(t);
  // Valid JSON and identical parsed values, but a different file revision.
  writeFileSync(join(build, 'data/player-projections.json'), Buffer.concat([standardBytes, Buffer.from(' ')]));
  assert.throws(() => verifyProjectionPublication(build), /SHA-256 mismatch/);
  writeFileSync(join(build, 'data/player-projections.json'), standardBytes);
  writeFileSync(join(build, 'data/projection-scenarios.json'), JSON.stringify({ ...candidate, inputRevision: { ...candidate.inputRevision, standardSHA256: 'b'.repeat(64) } }));
  assert.throws(() => verifyProjectionPublication(build), /SHA-256 mismatch/);
});

test('missing/malformed files and missing CLI directory stop publication with a nonzero exit', t => {
  const { build } = fixture(t);
  const script = resolve('scripts/verify_projection_publication.ts');
  assert.notEqual(spawnSync(process.execPath, ['--experimental-strip-types', script], { encoding: 'utf8' }).status, 0);
  for (const name of ['player-projections.json', 'projection-scenarios.json']) {
    const path = join(build, 'data', name), bytes = readFileSync(path);
    for (const body of [null, Buffer.from('{invalid')]) {
      if (body === null) rmSync(path); else writeFileSync(path, body);
      const result = spawnSync(process.execPath, ['--experimental-strip-types', script, build], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Production publication blocked/);
      writeFileSync(path, bytes);
    }
  }
});

function git(target: string, ...args: string[]) {
  return execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function publication(t: TestContext) {
  const { root, build } = fixture(t);
  for (const name of dataFiles) cpSync(join('public/data', name), join(build, 'data', name));
  writeFileSync(join(build, 'data/player-projections.json'), standardBytes);
  writeFileSync(join(build, 'data/projection-scenarios.json'), replayInputBytes('projection-scenarios.json'));
  mkdirSync(join(build, 'assets'));
  writeFileSync(join(build, 'index.html'), '<div id="root">old release</div><script type="module" src="/assets/index-a.js"></script><link rel="stylesheet" href="/assets/index-a.css">');
  writeFileSync(join(build, 'assets/index-a.js'), 'export const release = true;');
  writeFileSync(join(build, 'assets/index-a.css'), 'body { color: black; }');
  const previous = join(root, 'previous'), target = join(root, 'public');
  execFileSync('python3', ['scripts/prepare_pages.py', build, previous, '--source-sha', 'a'.repeat(40)]);
  cpSync(previous, target, { recursive: true });
  git(target, 'init', '-q');
  git(target, 'remote', 'add', 'origin', 'https://github.com/nba-fantasy-assistant/nba-fantasy-assistant.github.io.git');
  git(target, 'config', 'user.name', 'Synthetic publication');
  git(target, 'config', 'user.email', 'tests@example.invalid');
  git(target, 'add', '--all'); git(target, 'commit', '-qm', 'Existing live release');
  writeFileSync(join(build, 'index.html'), '<div id="root">new release</div><script type="module" src="/assets/index-a.js"></script><link rel="stylesheet" href="/assets/index-a.css">');
  return { root, build, target };
}

function guardedStage(release: string, target: string) {
  // Execute the real gate and real existing stager, with the workflow's stop-on-error order.
  return spawnSync('sh', ['-c', '"$1" --experimental-strip-types scripts/verify_projection_publication.ts "$2" && python3 scripts/stage_pages.py "$2" "$3" --source-sha "$4"', 'publication', process.execPath, release, target, 'b'.repeat(40)], { encoding: 'utf8' });
}

test('code push or failed daily sidecar cannot change the existing public files, commit or Git index', t => {
  const { root, build, target } = publication(t);
  const before = { commit: git(target, 'rev-parse', 'HEAD'), index: git(target, 'write-tree'), manifest: readFileSync(join(target, 'deployment-manifest.json')), html: readFileSync(join(target, 'index.html')) };
  for (const mode of ['legacy-v1-retained', 'stale-v2-after-standard-refresh']) {
    if (mode === 'stale-v2-after-standard-refresh') {
      writeFileSync(join(build, 'data/projection-scenarios.json'), candidateBytes);
      writeFileSync(join(build, 'data/player-projections.json'), Buffer.concat([standardBytes, Buffer.from(' ')]));
    }
    const release = join(root, mode);
    execFileSync('python3', ['scripts/prepare_pages.py', build, release, '--source-sha', 'b'.repeat(40)]);
    const result = guardedStage(release, target);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Production publication blocked/);
    assert.equal(git(target, 'rev-parse', 'HEAD'), before.commit);
    assert.equal(git(target, 'write-tree'), before.index);
    assert.equal(git(target, 'status', '--porcelain'), '');
    assert.deepEqual(readFileSync(join(target, 'deployment-manifest.json')), before.manifest);
    assert.deepEqual(readFileSync(join(target, 'index.html')), before.html);
  }
});

test('a compatible v2 release passes the gate and the unchanged real publication stager', t => {
  const { root, build, target } = publication(t);
  writeFileSync(join(build, 'data/projection-scenarios.json'), candidateBytes);
  const release = join(root, 'valid');
  execFileSync('python3', ['scripts/prepare_pages.py', build, release, '--source-sha', 'b'.repeat(40)]);
  const result = guardedStage(release, target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Staged publication verified by SHA-256 and Git index/);
  assert.equal(JSON.parse(readFileSync(join(target, 'deployment-manifest.json'), 'utf8')).sourceCommit, 'b'.repeat(40));
  assert.deepEqual(readFileSync(join(target, 'data/projection-scenarios.json')), candidateBytes);
});

test('every existing Pages trigger shares a mandatory gate before preparation and public-branch access', () => {
  const workflow = readFileSync('.github/workflows/publish-pages.yml', 'utf8');
  const command = 'run: node --experimental-strip-types scripts/verify_projection_publication.ts dist';
  assert.equal(workflow.split(command).length - 1, 1);
  const gate = workflow.indexOf(command), prepare = workflow.indexOf('run: python scripts/prepare_pages.py');
  assert.ok(workflow.indexOf('- run: npm run build') < gate && gate < prepare);
  assert.ok(prepare < workflow.indexOf('clone --branch gh-pages'));
  const step = workflow.slice(workflow.lastIndexOf('      - name:', gate), workflow.indexOf('      - name:', gate));
  assert.doesNotMatch(step, /continue-on-error:|\bif:|\|\| true/);
  for (const trigger of ['  push:', '  workflow_dispatch:', '  workflow_call:']) assert.ok(workflow.includes(trigger));
  assert.match(readFileSync('.github/workflows/refresh-stats.yml', 'utf8'), /uses: \.\/\.github\/workflows\/publish-pages\.yml/);
});
