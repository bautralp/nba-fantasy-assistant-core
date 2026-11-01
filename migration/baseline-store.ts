/** Identity/hash metadata may be public; the historical data pack remains private. */
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
type Entry = { sha256: string; git_blob_sha1: string };
export class PrivateValidationRequired extends Error {}
export function validateBytes(raw: Buffer, expected: Entry): Buffer {
  if (createHash('sha256').update(raw).digest('hex') !== expected.sha256) throw new Error('Historical SHA-256 mismatch');
  const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw])).digest('hex');
  if (blob !== expected.git_blob_sha1) throw new Error('Historical blob identity mismatch');
  return raw;
}
export function readHistorical(commit: string, path: string): Buffer {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Full historical commit identity required');
  const index = JSON.parse(readFileSync(new URL('./baseline-index.json', import.meta.url), 'utf8'));
  const expected: Entry | undefined = index.files[`${commit}:${path}`];
  if (!expected || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unknown or unsafe historical identity/path');
  if (process.env.NFA_VALIDATION_PROFILE !== 'private') throw new PrivateValidationRequired('PRIVATE_VALIDATION_REQUIRED: historical data is outside public validation');
  if (!process.env.NFA_PRIVATE_BASELINE_ROOT) throw new PrivateValidationRequired('PRIVATE_BASELINE_PACK_MISSING');
  const root = realpathSync(process.env.NFA_PRIVATE_BASELINE_ROOT), exportRoot = resolve(import.meta.dirname, '..');
  const fromExport = relative(exportRoot, root);
  if (!fromExport || (!fromExport.startsWith('..') && !isAbsolute(fromExport))) throw new Error('Private pack must remain outside the public source tree');
  const file = resolve(root, commit, path), fromRoot = relative(root, file);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || lstatSync(file).isSymbolicLink()) throw new Error('Unsafe private pack path');
  const realFile = realpathSync(file), realRelative = relative(root, realFile);
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error('Private pack symlink escape');
  return validateBytes(readFileSync(realFile), expected);
}

/** Approved original bytes may be mounted privately; never copy them into the public tree. */
export function readPrivateData(path: string): Buffer {
  if(process.env.NFA_VALIDATION_PROFILE!=='private') throw new PrivateValidationRequired('PRIVATE_VALIDATION_REQUIRED');
  const index=JSON.parse(readFileSync(new URL('./baseline-index.json',import.meta.url),'utf8'));
  const expected: Entry|undefined=index.current_files[path];
  if(!expected || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unknown private data path');
  if(!process.env.NFA_PRIVATE_DATA_ROOT) throw new PrivateValidationRequired('PRIVATE_DATA_RESOURCE_MISSING');
  const root=realpathSync(process.env.NFA_PRIVATE_DATA_ROOT),exportRoot=resolve(import.meta.dirname,'..');
  const rel=relative(exportRoot,root);
  if(!rel || (!rel.startsWith('..')&&!isAbsolute(rel))) throw new Error('Private data must remain outside public export');
  const file=resolve(root,path),real=realpathSync(file),within=relative(root,real);
  if(within.startsWith('..') || isAbsolute(within) || lstatSync(file).isSymbolicLink()) throw new Error('Unsafe private resource path');
  return validateBytes(readFileSync(real),expected);
}
