"""Create immutable research Git objects for review; never update a branch or production."""
import base64
import json
import os
from pathlib import Path
from urllib.request import Request,urlopen

REPO='bautralp/nba-fantasy-assistant'
def artifact_names(root):
    names=['cohorts.json','rookie-profiles.json','rookie-draft-2026.json','collection-summary.json','sources.json']
    corpus=root/'cohorts.json'
    if corpus.exists() and json.loads(corpus.read_text()).get('selectionPolicy'):
        # Never attach stale legacy parameters/accuracy to a changed population.
        return names+['rookie-selection-evaluation-status.json']
    return names+['rookie-revision-backtest.json','rookie-revision-parameters.json']

def api(path,payload=None):
    token=os.environ['GITHUB_TOKEN']
    body=json.dumps(payload).encode() if payload is not None else None
    request=Request('https://api.github.com/repos/'+REPO+'/'+path,data=body,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','User-Agent':'nba-rookie-research'},method='POST' if payload is not None else 'GET')
    with urlopen(request,timeout=90) as response:return json.load(response)
def main():
    parent=os.environ['PARENT_SHA']
    if len(parent)!=40 or any(c not in '0123456789abcdef' for c in parent):raise ValueError('Invalid parent commit')
    base=api('git/commits/'+parent)['tree']['sha'];elements=[];manifest={}
    root=Path(os.environ.get('RESEARCH_ROOT','artifacts/rookie-revision'))
    for name in artifact_names(root):
        path=root/name
        if not path.exists():continue
        raw=path.read_bytes()
        blob=api('git/blobs',{'encoding':'base64','content':base64.b64encode(raw).decode()})['sha']
        target='research/'+name;elements.append({'path':target,'mode':'100644','type':'blob','sha':blob});manifest[target]=blob
    tree=api('git/trees',{'base_tree':base,'tree':elements})['sha']
    commit=api('git/commits',{'message':'research: immutable rookie source artifacts (no branch update)','tree':tree,'parents':[parent]})['sha']
    print('RESEARCH_ARTIFACT_MANIFEST '+json.dumps({'commit':commit,'parent':parent,'blobs':manifest}),flush=True)
if __name__=='__main__':main()

