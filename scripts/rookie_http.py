"""Polite public HTTP acquisition with immutable success cache and typed failures."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import random
import tempfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

class SourceError(Exception):
    def __init__(self, kind, url, status=None, detail=None, retry_after=None):
        self.kind,self.url,self.status,self.detail,self.retry_after=kind,url,status,detail,retry_after
        super().__init__(f'{kind}: {status or ""} {detail or ""}'.strip())
    def record(self):
        return {'kind':self.kind,'url':self.url,'status':self.status,'detail':self.detail,'retryAfter':self.retry_after}

def retry_after_seconds(value, now=None):
    if value is None:return None
    try:return max(0,float(value))
    except (TypeError,ValueError):
        try:
            parsed=parsedate_to_datetime(value)
            if parsed.tzinfo is None:parsed=parsed.replace(tzinfo=timezone.utc)
            return max(0,(parsed-(now or datetime.now(timezone.utc))).total_seconds())
        except (TypeError,ValueError,OverflowError):return None

def atomic_bytes(path,raw):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as stream:
            temporary=stream.name;stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,path)
    finally:
        if temporary and os.path.exists(temporary):os.unlink(temporary)

class SourceClient:
    def __init__(self, cache=None, interval=1.0, attempts=3, max_retry_wait=120, budget=1800,
                 opener=urlopen, sleep=time.sleep, monotonic=time.monotonic, jitter=random.random):
        if interval<0 or not 1<=attempts<=5:raise ValueError('Invalid HTTP acquisition limits')
        self.cache=Path(cache) if cache else None
        self.interval,self.attempts,self.max_retry_wait,self.budget=interval,attempts,max_retry_wait,budget
        self.opener,self.sleep,self.clock,self.jitter=opener,sleep,monotonic,jitter
        self.lock=threading.Lock();self.next_request=0;self.requests=0;self.events=[]
    def _record(self,record):
        with self.lock:self.events.append(record)
    def invalidate(self,url,detail):
        # A 200 response is not a validated identity/career result. Preserve its
        # immutable body for audit, but permit a failed semantic record to retry.
        if self.cache is not None:
            key=hashlib.sha256(url.encode()).hexdigest()
            with self.lock:(self.cache/(key+'.json')).unlink(missing_ok=True)
        self._record({'url':url,'kind':'validation-rejected','detail':detail})
    def _cached(self,url):
        if self.cache is None:return None
        key=hashlib.sha256(url.encode()).hexdigest();meta=self.cache/(key+'.json')
        if not meta.exists():return None
        try:
            entry=json.loads(meta.read_text());raw=(self.cache/(entry['sha256']+'.body')).read_bytes()
            if entry['url']!=url or hashlib.sha256(raw).hexdigest()!=entry['sha256']:raise ValueError('Cache hash mismatch')
        except Exception as error:raise SourceError('cache-corrupt',url,detail=str(error)) from error
        self._record({'url':url,'kind':'success','status':200,'cached':True,'sha256':entry['sha256'],'retrievedAt':entry['retrievedAt']})
        return raw
    def _save(self,url,raw):
        if self.cache is None:return
        digest=hashlib.sha256(raw).hexdigest();key=hashlib.sha256(url.encode()).hexdigest()
        # Old manifest always points to immutable, complete success bytes even after interruption.
        body=self.cache/(digest+'.body')
        if not body.exists():atomic_bytes(body,raw)
        atomic_bytes(self.cache/(key+'.json'),json.dumps({'url':url,'sha256':digest,'retrievedAt':datetime.now(timezone.utc).isoformat()}).encode())
    def _rate_limit(self,url):
        with self.lock:
            if self.requests>=self.budget:raise SourceError('request-budget',url,detail='Public request budget exhausted')
            wait=max(0,self.next_request-self.clock())
            if wait>self.max_retry_wait:raise SourceError('retry-deferred',url,detail='Shared server cooldown exceeds bounded request wait',retry_after=wait)
            if wait:self.sleep(wait)
            self.next_request=self.clock()+self.interval+0.25*self.jitter()
            self.requests+=1
    def get(self,url):
        cached=self._cached(url)
        if cached is not None:return cached
        for attempt in range(self.attempts):
            self._rate_limit(url)
            try:
                with self.opener(Request(url,headers={'User-Agent':'nba-fantasy-assistant-research/14.1 (public data; rate limited)'}),timeout=45) as response:
                    raw=response.read(50_000_001)
                    if len(raw)>50_000_000:raise SourceError('size-limit',url,detail='Source exceeds 50 MB')
                self._save(url,raw)
                self._record({'url':url,'kind':'success','status':200,'cached':False,'sha256':hashlib.sha256(raw).hexdigest(),'retrievedAt':datetime.now(timezone.utc).isoformat()})
                return raw
            except HTTPError as error:
                code=error.code;after=retry_after_seconds(error.headers.get('Retry-After') if error.headers else None)
                failure=SourceError('http-'+str(code),url,code,str(error),after)
                retry=code in (408,429,500,502,503,504)
            except (URLError,TimeoutError,ConnectionError,OSError) as error:
                failure=SourceError('network',url,detail=str(error));retry=True;after=None
            self._record({**failure.record(),'attempt':attempt+1,'cached':False})
            if not retry or attempt+1>=self.attempts:raise failure
            wait=max(2*(2**attempt)+self.jitter(),after or 0)
            if wait>self.max_retry_wait:
                with self.lock:self.next_request=max(self.next_request,self.clock()+wait)
                raise SourceError('retry-deferred',url,failure.status,'Retry-After exceeds bounded run; retry later',wait)
            # Another worker must observe the same server cooldown, especially
            # for Retry-After on 429/503. Keep concurrency bounded globally.
            with self.lock:self.next_request=max(self.next_request,self.clock()+wait)
            self.sleep(wait)
        raise AssertionError('Unreachable HTTP retry state')
