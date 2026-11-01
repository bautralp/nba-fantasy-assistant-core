import json,os,shutil,sys,tempfile,unittest,hashlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import isolation_guard as g
class IsolationGuards(unittest.TestCase):
 def trees(self,t):
  root=Path(t);base=root/'base';after=root/'after';base.mkdir();after.mkdir();return base,after
 def test_every_original_protected_path_rejects_edit_add_delete_rename_and_mode(self):
  for name in ['rookie-selection','rookie-source-impact']:
   for scope in g.policy(name)['protectedPaths']:
    for mutation in ['edit','add','delete','rename','mode']:
     with self.subTest(policy=name,path=scope,mutation=mutation),tempfile.TemporaryDirectory() as t:
      base,after=self.trees(t);relative=scope if Path(scope).suffix else scope+'/synthetic.txt'
      p=base/relative;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('synthetic protected bytes')
      shutil.copytree(base,after,dirs_exist_ok=True);q=after/relative
      self.assertEqual(g.check(base,after,name),1)
      if mutation=='edit':q.write_text('changed')
      elif mutation=='add':p.unlink()  # newly created protected file absent from trusted base
      elif mutation=='delete':q.unlink()
      elif mutation=='rename':q.rename(q.with_name(q.name+'.renamed'))
      else:q.chmod(0o755)
      with self.assertRaises(ValueError):g.check(base,after,name)
 def test_research_only_change_outside_original_scope_allowed(self):
  for name in ['rookie-selection','rookie-source-impact']:
   with tempfile.TemporaryDirectory() as t:
    base,after=self.trees(t);(after/'research-result.json').write_text('{"synthetic":true}')
    self.assertEqual(g.check(base,after,name),0)
 def test_protected_symlink_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   base,after=self.trees(t);(after/'src').mkdir();(after/'src/leak').symlink_to(base)
   with self.assertRaises(ValueError):g.check(base,after,'rookie-selection')
 def test_private_profile_and_trusted_digest_are_mandatory(self):
  with patch.dict(os.environ,{},clear=True),self.assertRaises(RuntimeError):g.verify_private_manifest('/missing','0'*64,'/missing','rookie-selection')
  with tempfile.TemporaryDirectory() as t,patch.dict(os.environ,{'NFA_VALIDATION_PROFILE':'private'}):
   root=Path(t);p=root/'base.json';p.write_text('{}')
   with self.assertRaises(ValueError):g.verify_private_manifest(p,'0'*64,root,'rookie-selection')
 def test_historical_identities_and_complete_original_scopes_unchanged(self):
  index=json.loads((g.ROOT/'migration/baseline-index.json').read_text())
  for name in ['rookie-selection','rookie-source-impact']:
   p=g.policy(name);old=next(s for s in index['scopes'] if s['commit']==p['historicalCommit'])
   self.assertEqual(p['protectedPaths'],old['paths']);self.assertEqual(p['historicalStatus'],'PRIVATE_ONLY_EXISTING_MISMATCH')
