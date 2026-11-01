import json,sys,unittest,socket,os
from pathlib import Path
from unittest.mock import patch
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'tests/stats'))
scopes=json.loads((root/'migration/validation-scopes.json').read_text())
print('PUBLIC SYNTHETIC PROFILE ONLY; private full validation is not claimed.',flush=True)
suite=unittest.defaultTestLoader.loadTestsFromNames(scopes['python_cases'])
records=[]
class EvidenceResult(unittest.TextTestResult):
 def addSuccess(self,test):
  records.append({'id':test.id(),'status':'PASS'});super().addSuccess(test)
 def addFailure(self,test,err):
  records.append({'id':test.id(),'status':'FAIL'});super().addFailure(test,err)
 def addError(self,test,err):
  records.append({'id':test.id(),'status':'ERROR'});super().addError(test,err)
with patch.object(socket.socket,'connect',side_effect=AssertionError('Public tests cannot contact provider/network')):
 result=unittest.TextTestRunner(verbosity=2,resultclass=EvidenceResult).run(suite)
if os.environ.get('PUBLIC_PYTHON_EVENTS'):Path(os.environ['PUBLIC_PYTHON_EVENTS']).write_text(json.dumps(records,indent=2))
raise SystemExit(0 if result.wasSuccessful() and not result.skipped else 1)
