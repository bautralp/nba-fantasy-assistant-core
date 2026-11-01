import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
scopes=json.loads((root/'migration/validation-scopes.json').read_text())
print(json.dumps({'status':'BLOCKED','technical_readiness':'TECHNICAL NOT READY','blocked_scopes':scopes['blocked_scopes']},indent=2))
# Deliberately cannot turn missing rights/data/equivalence into a successful full gate.
raise SystemExit(2)
