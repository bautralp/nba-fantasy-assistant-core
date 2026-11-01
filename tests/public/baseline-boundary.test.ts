import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readHistorical, readPrivateData, validateBytes, PrivateValidationRequired } from '../../migration/baseline-store.ts';
test('all eight historical identities remain metadata; none claims public raw payload availability', () => {
  const index = JSON.parse(readFileSync(new URL('../../migration/baseline-index.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(index.identities).length, 8);
  assert.equal(index.public_raw_payloads, 0);
  assert.throws(() => readPrivateData('public/data/player-projections.json'), PrivateValidationRequired);
  assert.ok(Object.values(index.identities).every((v: any) => v.status === 'private-only'));
  const [key] = Object.keys(index.files), split = key.indexOf(':');
  assert.throws(() => readHistorical(key.slice(0, split), key.slice(split + 1)), PrivateValidationRequired);
});
test('baseline verifier rejects changed bytes and false blob identity', () => {
  const raw = Buffer.from('Synthetic verifier fixture only\n');
  const expected = { sha256: createHash('sha256').update(raw).digest('hex'),
    git_blob_sha1: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw])).digest('hex') };
  assert.equal(validateBytes(raw, expected), raw);
  assert.throws(() => validateBytes(Buffer.concat([raw, Buffer.from('x')]), expected));
  assert.throws(() => validateBytes(raw, { ...expected, git_blob_sha1: '0'.repeat(40) }));
});
test('unknown commit/path and traversal never fall back to Git or a live network source', () => {
  assert.throws(() => readHistorical('0'.repeat(40), 'missing.json'), /Unknown/);
  assert.throws(() => readHistorical('0'.repeat(40), '../outside'), /Unknown/);
});
