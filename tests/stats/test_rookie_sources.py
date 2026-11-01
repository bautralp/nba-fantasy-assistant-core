"""Synthetic acquisition and identity edge cases; not player evidence."""
from datetime import datetime,timezone
from pathlib import Path
import io,json,sys,tempfile,unittest
from urllib.error import HTTPError,URLError
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from rookie_http import SourceClient,SourceError,retry_after_seconds
from acquire_rookie_sources import fetch_profile,needs_retry
from rookie_identity import nba_id_from_draft,verify_current_draft,merge_draft_evidence
from rookie_model import classify

class Response(io.BytesIO):
    def __enter__(self):return self
    def __exit__(self,*args):self.close()
class Clock:
    def __init__(self):self.now=0;self.waits=[]
    def sleep(self,seconds):self.now+=seconds;self.waits.append(seconds)
    def time(self):return self.now
class HTTPTests(unittest.TestCase):
    def client(self,opener,**kw):
        clock=Clock();c=SourceClient(opener=opener,sleep=clock.sleep,monotonic=clock.time,jitter=lambda:0,**kw)
        return c,clock
    def test_statuses_retry_after_and_no_retry_on_403_404(self):
        for status in (403,404):
            calls=[]
            def opened(request,**kw):
                calls.append(request);raise HTTPError(request.full_url,status,'denied',{},None)
            c,_=self.client(opened)
            with self.assertRaises(SourceError) as error:c.get('https://example.test/x')
            self.assertEqual(error.exception.kind,'http-'+str(status));self.assertEqual(len(calls),1)
        for status in (429,503):
            calls=[]
            def opened(request,**kw):
                calls.append(request)
                if len(calls)==1:raise HTTPError(request.full_url,status,'temporary',{'Retry-After':'7'},None)
                return Response(b'valid')
            c,clock=self.client(opened);self.assertEqual(c.get('https://example.test/x'),b'valid')
            self.assertIn(7,clock.waits);self.assertEqual(len(calls),2)
    def test_retry_after_http_date_network_budget_and_deferred(self):
        now=datetime(2026,10,22,tzinfo=timezone.utc)
        self.assertEqual(retry_after_seconds('Thu, 22 Oct 2026 00:00:10 GMT',now),10)
        self.assertIsNone(retry_after_seconds('invalid',now))
        def broken(request,**kw):raise URLError('temporary network')
        c,_=self.client(broken,attempts=2)
        with self.assertRaises(SourceError) as e:c.get('https://example.test/x')
        self.assertEqual(e.exception.kind,'network');self.assertEqual(c.requests,2)
        c,_=self.client(lambda *a,**kw:Response(b'ok'),budget=1)
        c.get('https://example.test/x')
        with self.assertRaisesRegex(SourceError,'request-budget'):c.get('https://example.test/y')
        def deferred(request,**kw):raise HTTPError(request.full_url,503,'later',{'Retry-After':'300'},None)
        c,clock=self.client(deferred,max_retry_wait=120)
        with self.assertRaisesRegex(SourceError,'retry-deferred'):c.get('https://example.test/x')
        self.assertEqual(clock.waits,[])
    def test_success_cache_is_immutable_and_skips_network(self):
        with tempfile.TemporaryDirectory() as root:
            c,_=self.client(lambda *a,**kw:Response(b'good'),cache=root)
            self.assertEqual(c.get('https://example.test/x'),b'good')
            c2,_=self.client(lambda *a,**kw:(_ for _ in ()).throw(AssertionError('cached source fetched')),cache=root)
            self.assertEqual(c2.get('https://example.test/x'),b'good');self.assertEqual(c2.requests,0)
            self.assertTrue(c2.events[0]['cached'])
    def test_partial_career_failure_preserves_identity_and_ncaa_link(self):
        raw=json.dumps({'athlete':{'id':'1','uid':'s:40~l:46~a:1','displayName':'Synthetic','collegeAthlete':{'id':'77'}}}).encode()
        def opened(request,**kw):
            if request.full_url.endswith('/stats'):raise HTTPError(request.full_url,503,'later',{},None)
            return Response(raw)
        c,_=self.client(opened,attempts=1)
        result=fetch_profile('1',c,{'id':'1','nbaHistory':{'2025':20}})
        self.assertTrue(result['identityVerified']);self.assertEqual(result['collegeAthlete']['id'],'77')
        self.assertEqual(result['nbaHistory'],{'2025':20});self.assertTrue(needs_retry(result))
        self.assertEqual(result['endpointErrors']['career']['kind'],'http-503')
    def test_rate_limit_applies_to_all_requests(self):
        c,clock=self.client(lambda *a,**kw:Response(b'ok'),interval=1)
        c.get('https://example.test/a');c.get('https://example.test/b');c.get('https://example.test/c')
        self.assertEqual(clock.waits,[1,1])
    def test_unverified_200_career_schema_retains_known_history_and_is_retryable(self):
        previous={'id':'1','uid':'s:40~l:46~a:1','identityVerified':True,'careerSchemaVerified':True,
                  'seasons':[{'year':2020,'gp':50}]}
        athlete=json.dumps({'athlete':{'id':'1','uid':'s:40~l:46~a:1'}}).encode()
        calls=[]
        def opened(request,**kw):
            calls.append(request.full_url)
            return Response(b'{}' if request.full_url.endswith('/stats') else athlete)
        with tempfile.TemporaryDirectory() as root:
            c,_=self.client(opened,cache=root)
            first=fetch_profile('1',c,previous)
            self.assertEqual(first['seasons'],previous['seasons']);self.assertTrue(first['careerSchemaVerified'])
            self.assertEqual(first['endpointErrors']['career']['kind'],'validation')
            fetch_profile('1',c,first)
            self.assertEqual(sum(url.endswith('/stats') for url in calls),2)

class IdentityTests(unittest.TestCase):
    def test_published_draft_proof_covers_all_sixty_and_the_four_lottery_anchors(self):
        root=Path(__file__).resolve().parents[2]
        draft=json.loads((root/'scripts/rookie-draft-2026.json').read_text())
        profiles=json.loads((root/'scripts/rookie-profiles.json').read_text())['profiles']
        selections=draft['selections']
        self.assertEqual([r['overall'] for r in selections],list(range(1,61)))
        self.assertEqual(sum(r['verified'] for r in selections),60)
        for selected in selections[:30]:
            self.assertIn(classify(profiles[selected['playerId']],[],[]),('rookie','international-newcomer'))
        for pid,pick in [('5142718',1),('5041935',3),('5095151',4),('5142620',7)]:
            selected=next(r for r in selections if r['playerId']==pid)
            self.assertEqual(selected['overall'],pick);self.assertTrue(selected['nbaEntryVerified'])
            self.assertEqual(classify(profiles[pid],[],[]),'rookie')
            self.assertEqual(str(profiles[pid]['ncaa']['id']),str(profiles[pid]['collegeAthlete']['id']))
            self.assertGreater(profiles[pid]['ncaa']['minutes'],0)
    def test_undrafted_pre_debut_needs_roster_and_verified_career_absence(self):
        p={'id':'1','identityVerified':True,'careerSchemaVerified':True,'seasons':[],
           'historyCoverage':[2023,2024,2025,2026],'displayExperience':'Rookie','nbaEntryVerified':True,
           'currentRosterEvidence':{'uid':'s:40~l:46~a:1','experienceYears':0}}
        self.assertEqual(classify(p,[],[]),'rookie')
        p['careerSchemaVerified']=False;self.assertEqual(classify(p,[],[]),'unknown')
        p['nbaHistory']={'2024':1};self.assertEqual(classify(p,[],[]),'returning-veteran')
    def test_draft_internal_id_is_not_nba_id(self):
        a={'id':'110904','alternativeId':'5142718','uid':'s:40~l:46~a:5142718','proLink':'https://www.espn.com/nba/player/_/id/5142718/aj-dybantsa'}
        self.assertEqual(nba_id_from_draft(a),'5142718')
        a['alternativeId']='999'
        with self.assertRaises(ValueError):nba_id_from_draft(a)
        with self.assertRaises(ValueError):nba_id_from_draft({'id':'110904'})
    def test_all_sixty_slots_join_without_name_only_matching(self):
        official=json.loads((Path(__file__).resolve().parents[2]/'scripts/rookie-official-draft-2026.json').read_text())
        picks=[];catalog=[]
        for row in official['records']:
            pid=str(100000+row['overall'])
            picks.append({'overall':row['overall'],'round':row['round'],'teamId':str(row['draftTeamId']),
                'athlete':{'id':str(900000+row['overall']),'alternativeId':pid,'uid':'s:40~l:46~a:'+pid,
                    'proLink':'https://www.espn.com/nba/player/_/id/'+pid,'displayName':row['name']}})
            catalog.append({'playerId':pid,'name':row['name']})
        linked=verify_current_draft(official,{'year':2026,'picks':picks},{'players':catalog})
        self.assertEqual(sum(r['verified'] for r in linked),60)
        picks[0]['teamId']='999'
        failed=verify_current_draft(official,{'year':2026,'picks':picks},{'players':catalog})
        self.assertFalse(failed[0]['verified']);self.assertIn('team',failed[0]['missingReason'])
    def test_official_draft_cannot_override_positive_nba_history_or_prove_entry(self):
        selection={'verified':True,'playerId':'1','espnUID':'s:40~l:46~a:1','name':'Synthetic','overall':1,'round':1,'signals':['year-pick','team','explicit-id']}
        p=merge_draft_evidence({'id':'1','error':'http-503'},selection,'https://www.nba.com/news/2026-nba-draft-order','2026-10-22T00:00:00Z',True)
        self.assertEqual(classify(p,[],[]),'rookie');self.assertEqual(p['error'],'http-503')
        p['nbaHistory']={'2024':10};self.assertEqual(classify(p,[],[]),'returning-veteran')
        p['nbaHistory']={};p['nbaEntryVerified']=False
        self.assertEqual(classify(p,[],[]),'unknown')
        p['nbaEntryVerified']=True;p['preNBALeague']='international-pro';p['preNBALeagueSource']='https://www.nba.com/verified-club'
        self.assertEqual(classify(p,[],[]),'international-newcomer')
        p['draftIdentity']['playerId']='2'
        with self.assertRaises(ValueError):classify(p,[],[])
