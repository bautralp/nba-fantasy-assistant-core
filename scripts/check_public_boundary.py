"""Verify reviewed source membership, rights boundary and generated output, no network."""
from pathlib import Path
import hashlib,json,re,sys,os
ROOT=Path(__file__).resolve().parents[1]
# VCS metadata belongs to an Actions checkout, never to the distributed source pack.
GENERATED={'node_modules','dist','artifacts','__pycache__','.git'}
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def source_files(root):
 out={}
 for p in root.rglob('*'):
  if set(p.relative_to(root).parts)&GENERATED:continue
  if p.is_symlink():raise ValueError('Source symlink forbidden')
  if p.is_file():out[p.relative_to(root).as_posix()]=p
 return out
def check(root=ROOT):
 root=Path(root)
 if (root/'.git').exists() and os.environ.get('GITHUB_ACTIONS')!='true':raise ValueError('Git metadata is not part of a local source export')
 if (root/'public').exists():
  for p in (root/'public').rglob('*'):
   if p.is_symlink() or any(x in {'.git','node_modules','research','.research-cache'} or x.startswith('.env') for x in p.relative_to(root/'public').parts):raise ValueError('Private/cache metadata under public assets')
 policy=json.loads((root/'migration/data-boundary-policy.json').read_text());manifest=json.loads((root/'migration/public-files.json').read_text())
 actual=source_files(root);expected=manifest['files']
 if set(actual)-{'migration/public-files.json'}!=set(expected):raise ValueError('Unreviewed source membership (new/missing file)')
 banned=set(policy['forbidden_original_sha256'])
 for name,path in actual.items():
  if path.is_symlink():raise ValueError('Source symlink: '+name)
  digest=sha(path)
  if digest in banned:raise ValueError('Excluded original bytes: '+name)
  if any(name.startswith(prefix) for prefix in policy['forbidden_prefixes']):raise ValueError('Private/production source path: '+name)
  if name in policy['forbidden_original_paths']:raise ValueError('Excluded source path: '+name)
  if path.suffix in ['.gz','.parquet','.zip','.tar','.png','.jpg','.jpeg','.webp','.pdf'] or path.suffix=='.xlsx' and name not in policy['allowed_binary_fixtures']:raise ValueError('Unreviewed data/binary: '+name)
  if name in expected and digest!=expected[name]['sha256']:raise ValueError('Source digest differs from reviewed manifest: '+name)
 for directory in ['public/demo','dist/demo']:
  demo=root/directory
  if not demo.exists():continue
  for path in demo.rglob('*.json'):
   data=json.loads(path.read_text())
   if data.get('provenance',{}).get('kind')!='synthetic':raise ValueError('Missing explicit synthetic provenance: '+str(path))
   for player in data.get('players',[]) if isinstance(data.get('players'),list) else []:
    row=player.get('player',player)
    name=row.get('name',row.get('fullName'))
    if name and not name.startswith('Synthetic Player '):raise ValueError('Unreviewed demo identity')
 if (root/'dist').exists():
  for path in (root/'dist').rglob('*'):
   if path.is_symlink() or any(x in {'.git','node_modules','research','.research-cache'} or x.startswith('.env') for x in path.relative_to(root/'dist').parts):raise ValueError('Generated private/cache metadata forbidden')
   if not path.is_file():continue
   if path.is_symlink() or sha(path) in banned or path.suffix in ['.map','.gz','.parquet','.xlsx','.zip'] or 'data' in path.relative_to(root/'dist').parts and 'demo' not in path.relative_to(root/'dist').parts:raise ValueError('Forbidden generated build content')
   if path.suffix=='.json' and not path.is_relative_to(root/'dist/demo'):raise ValueError('Unreviewed build JSON')
 # No external caches/artifacts are imported. Test output must stay in the ignored output tree.
 if (root/'.research-cache').exists():raise ValueError('Private cache directory present')
 text=(root/'.github/workflows/public-core.yml').read_text()
 if sorted(p.name for p in (root/'.github/workflows').glob('*'))!=['public-core.yml']:raise ValueError('Unexpected active workflow')
 for term in ['pull_request_target','workflow_run:','workflow_dispatch:','schedule:','secrets.','github.token','contents: write','id-token:','environment:','git push','actions/cache','upload-artifact']:
  if term in text:raise ValueError('Privileged public CI path: '+term)
 if 'persist-credentials: false' not in text or 'contents: read' not in text:raise ValueError('Checkout/token boundary missing')
 if not all(re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}',x) for x in re.findall(r'uses: (\S+)',text)):raise ValueError('Unpinned public action')
 for name in ['espn-api-MIT.txt','sportsdataverse-MIT.txt','nodable-entities-MIT.txt']:
  if 'Permission is hereby granted' not in (root/'LICENSES'/name).read_text():raise ValueError('Required license notice missing')
 return {'status':'PUBLIC_BOUNDARY_PASS','source_files':len(actual),'generated_build_checked':(root/'dist').exists(),'private_production_validation':'NOT_CLAIMED'}
if __name__=='__main__':
 try:print(json.dumps(check()))
 except (ValueError,KeyError,OSError) as e:print(json.dumps({'status':'BLOCKED','reason':str(e)}));raise SystemExit(1)
