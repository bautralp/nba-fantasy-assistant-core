"""Compare a research candidate to an independently trusted base without Git history.

Preserves the complete original path scope, membership, bytes and executable mode.
A new trusted base is an explicit private review artifact, never inferred from HEAD.
Historical SHA checks remain separate and blocked where previously mismatched.
"""
from pathlib import Path
import hashlib,json,os
ROOT=Path(__file__).resolve().parents[1]
def policy(name):
 if name not in ('rookie-selection','rookie-source-impact'):raise ValueError('Unknown isolation policy')
 return json.loads((ROOT/'migration/isolation'/f'{name}.json').read_text())
def protected(path, paths):return any(path==s or path.startswith(s.rstrip('/')+'/') for s in paths)
def snapshot(root, paths):
 root=Path(root).resolve();out={}
 for path in root.rglob('*'):
  name=path.relative_to(root).as_posix()
  if not protected(name,paths):continue
  if path.is_symlink():raise ValueError('Protected symlink forbidden: '+name)
  if path.is_file():out[name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'executable':bool(path.stat().st_mode&0o111)}
 return out
def compare(expected, actual):
 if set(expected)!=set(actual):raise ValueError('Isolation membership violation (added/deleted/renamed file)')
 for name,meta in expected.items():
  if actual[name]!=meta:raise ValueError('Isolation bytes/mode violation: '+name)
 return len(expected)
def check(base, candidate, name):
 p=policy(name);return compare(snapshot(base,p['protectedPaths']),snapshot(candidate,p['protectedPaths']))
def verify_private_manifest(file, expected_digest, candidate, name):
 if os.environ.get('NFA_VALIDATION_PROFILE')!='private':raise RuntimeError('PRIVATE_VALIDATION_REQUIRED: no historical/research full PASS in public CI')
 path=Path(file).resolve()
 if path==ROOT or path.is_relative_to(ROOT):raise ValueError('Trusted private manifest must be outside public export')
 raw=path.read_bytes()
 if len(expected_digest)!=64 or hashlib.sha256(raw).hexdigest()!=expected_digest:raise ValueError('Trusted manifest digest mismatch')
 p=policy(name);m=json.loads(raw)
 if m.get('policy')!=name or m.get('historicalCommit')!=p['historicalCommit'] or m.get('protectedPaths')!=p['protectedPaths'] or not m.get('approvedSourceIdentity'):raise ValueError('Unreviewed/incompatible trusted manifest')
 expected=m['files']
 if any(not protected(n,p['protectedPaths']) or n.startswith('/') or '..' in Path(n).parts for n in expected):raise ValueError('Unsafe trusted manifest membership')
 return compare(expected,snapshot(candidate,p['protectedPaths']))
if __name__=='__main__':
 import argparse
 a=argparse.ArgumentParser();a.add_argument('--policy',required=True);a.add_argument('--trusted-manifest',required=True);a.add_argument('--trusted-sha256',required=True);a.add_argument('--candidate-root',required=True);args=a.parse_args()
 try:n=verify_private_manifest(args.trusted_manifest,args.trusted_sha256,args.candidate_root,args.policy)
 except (ValueError,RuntimeError,OSError,KeyError) as e:print(json.dumps({'status':'BLOCKED','reason':str(e)}));raise SystemExit(2)
 print(json.dumps({'status':'RESEARCH_CHANGE_ISOLATED','files':n,'scope':'private reviewed change only; historical origin equivalence remains separate'}))
