import importlib.util,json,shutil,sys,tempfile,unittest,os
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'scripts'))
import check_public_boundary as b
class DataBoundary(unittest.TestCase):
 def copy(self,root):
  for name,p in b.source_files(ROOT).items():
   q=root/name;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)
 def test_reviewed_tree_and_no_private_profile_pass(self):self.assertEqual(b.check()['status'],'PUBLIC_BOUNDARY_PASS')
 def test_added_data_changed_code_and_extra_workflow_are_rejected(self):
  for name in ['public/data/real.json','research/record.json','.env','src/app/App.tsx','.github/workflows/publish.yml']:
   with self.subTest(path=name),tempfile.TemporaryDirectory() as t:
    r=Path(t);self.copy(r);p=r/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('unreviewed')
    with self.assertRaises(ValueError):b.check(r)
 def test_excluded_file_at_renamed_path_is_rejected_before_digest_approval(self):
  # No real private bytes are copied: use a synthetic banned hash in an isolated policy.
  import hashlib
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);self.copy(r);p=r/'README.md';p.write_text('synthetic banned bytes');policy=json.loads((r/'migration/data-boundary-policy.json').read_text());policy['forbidden_original_sha256'].append(hashlib.sha256(p.read_bytes()).hexdigest());(r/'migration/data-boundary-policy.json').write_text(json.dumps(policy))
   reviewed=json.loads((r/'migration/public-files.json').read_text())
   for path in ['README.md','migration/data-boundary-policy.json']:reviewed['files'][path]['sha256']=b.sha(r/path)
   (r/'migration/public-files.json').write_text(json.dumps(reviewed))
   with self.assertRaisesRegex(ValueError,'Excluded original bytes'):b.check(r)

 def test_actions_checkout_metadata_is_ignored_but_never_allowed_in_source_pack(self):
  with tempfile.TemporaryDirectory() as t:
   r=Path(t);self.copy(r);(r/'.git').mkdir();(r/'.git/HEAD').write_text('synthetic checkout metadata only')
   with patch.dict(os.environ,{'GITHUB_ACTIONS':'false'}),self.assertRaises(ValueError):b.check(r)
   with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}):self.assertEqual(b.check(r)['status'],'PUBLIC_BOUNDARY_PASS')
   (r/'public/.git').mkdir(parents=True)
   with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),self.assertRaises(ValueError):b.check(r)
