import hashlib,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import migration_baselines as m
from prepare_pages import prepare
from pages_integrity import DATA_FILES,validate_release
class PublicBoundaries(unittest.TestCase):
 def test_default_profile_is_blocked(self):
  with patch.dict(os.environ,{},clear=True):
   with self.assertRaises(m.PrivateValidationRequired):m.private_root()
 def test_hash_and_blob_integrity(self):
  raw=b'independently authored synthetic baseline\n'
  meta={'sha256':hashlib.sha256(raw).hexdigest(),'git_blob_sha1':hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()}
  self.assertEqual(m.validate_bytes(raw,meta),raw)
  with self.assertRaises(ValueError):m.validate_bytes(raw+b'x',meta)
 def test_no_private_pack_inside_export(self):
  with patch.dict(os.environ,{'NFA_VALIDATION_PROFILE':'private','NFA_PRIVATE_BASELINE_ROOT':str(m.ROOT)}):
   with self.assertRaises(m.PrivateValidationRequired):m.private_root()
 def test_synthetic_staging_and_tamper(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t); source=root/'dist'; (source/'assets').mkdir(parents=True);(source/'data').mkdir()
   (source/'index.html').write_text('<div id="root"></div><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">')
   (source/'assets/app.css').write_text('body{color:black}')
   (source/'assets/app.js').write_text('document.title="Synthetic staging only";')
   for name in DATA_FILES:(source/'data'/name).write_text(json.dumps({'synthetic':True}))
   output=root/'release';prepare(source,output,'a'*40);validate_release(output,'a'*40)
   (output/'assets/app.js').write_text('tampered')
   with self.assertRaises(ValueError):validate_release(output,'a'*40)
 def test_actual_export_cannot_stage_missing_production_data(self):
  with tempfile.TemporaryDirectory() as t:
   with self.assertRaises(ValueError):prepare(m.ROOT/'dist',Path(t)/'release','a'*40)

 def test_public_workflow_is_read_only_and_automation_is_inert(self):
  active=list((m.ROOT/'.github/workflows').glob('*.yml'))
  self.assertEqual([p.name for p in active],['public-core.yml'])
  text=active[0].read_text()
  self.assertIn('contents: read',text);self.assertIn('persist-credentials: false',text)
  for forbidden in ['secrets.','contents: write','pull_request_target','workflow_run:','workflow_dispatch:','schedule:','git push','PAGES_PUBLISH_TOKEN']:
   self.assertNotIn(forbidden,text)
  contract=json.loads((m.ROOT/'migration/automation-contract.json').read_text())
  self.assertEqual(contract['site_url'],'https://nba-fantasy-assistant.github.io')
  self.assertEqual(contract['pages_repository'],'nba-fantasy-assistant/nba-fantasy-assistant.github.io')
  self.assertEqual(contract['daily_cron_utc'],'23 14 * * *')
  self.assertEqual(contract['active_daily_owner_during_preflight'],'existing private repository only')
