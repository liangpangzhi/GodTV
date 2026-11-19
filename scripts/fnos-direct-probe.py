#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探测飞牛直链播放能力：/v/api/v1/stream 与 /media/range 对比转码 HLS"""
import hashlib, json, random, time, urllib.request, urllib.error
import os as _os

def _env(name, default=""):
    return _os.environ.get(name, default)

BASE = _env("FNOS_BASE", "http://127.0.0.1:5666")
FNOS_USER = _env("FNOS_USERNAME")
FNOS_PASS = _env("FNOS_PASSWORD")

def _login_body():
    if not FNOS_USER or not FNOS_PASS:
        raise SystemExit(
            "请先设置环境变量 FNOS_USERNAME / FNOS_PASSWORD / FNOS_BASE，\n"
            "例如： FNOS_USERNAME=你的账号 FNOS_PASSWORD=你的密码 FNOS_BASE=http://192.168.1.10:5666 python " + __file__
        )
    return {"username": FNOS_USER, "password": FNOS_PASS, "app_name": "trimemedia-web"}

API_KEY="NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
API_SECRET="16CCEB3D-AB42-077D-36A1-F355324E4237"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
TOKEN=None

def md5(s): return hashlib.md5(s.encode('utf-8')).hexdigest()
def authx(path, data=None):
    nonce=str(random.randint(100000,999999)); ts=str(int(time.time()*1000))
    dmd5=md5(json.dumps(data,separators=(',',':'),ensure_ascii=False)) if data is not None else md5("")
    return f"nonce={nonce}&timestamp={ts}&sign={md5('_'.join([API_KEY,path,nonce,ts,dmd5,API_SECRET]))}"

def api(path, method='GET', body=None):
    headers={'Accept':'application/json','User-Agent':UA,'x-trim-client':'web',
             'x-trim-client-version':'616','Authorization':TOKEN,'Cookie':f'Trim-MC-token={TOKEN}'}
    data=None
    if body is not None:
        headers['Content-Type']='application/json'; headers['Authx']=authx(path,body)
        data=json.dumps(body,separators=(',',':'),ensure_ascii=False).encode('utf-8')
    req=urllib.request.Request(BASE+path,data=data,headers=headers,method=method)
    with urllib.request.urlopen(req,timeout=30) as r: return json.loads(r.read().decode('utf-8','replace'))

def timed_fetch(url, headers=None, timeout=30):
    h={'User-Agent':UA}
    if headers: h.update(headers)
    req=urllib.request.Request(url, headers=h)
    t0=time.time()
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            chunk=r.read(65536); return r.status, r.headers.get('content-type',''), chunk, time.time()-t0, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('content-type',''), e.read(65536), time.time()-t0, e.headers
    except Exception as e:
        return -1,'',str(e).encode(),time.time()-t0,{}

body = _login_body()
headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':UA,
         'x-trim-client':'web','x-trim-client-version':'616','Authx':authx('/v/api/v1/login',body)}
req=urllib.request.Request(BASE+'/v/api/v1/login',data=json.dumps(body).encode(),headers=headers,method='POST')
with urllib.request.urlopen(req,timeout=20) as r:
    TOKEN=json.loads(r.read().decode())['data']['token']
auth={'Authorization':TOKEN,'Cookie':f'Trim-MC-token={TOKEN}','x-trim-client':'web','x-trim-client-version':'616'}

GUID="07e04d7929ff4de58deb305eb8c02651"
info=api('/v/api/v1/play/info','POST',{"item_guid":GUID})
d=info.get('data') or {}
media_guid=d.get('media_guid'); video_guid=d.get('video_guid')
print('media_guid=',media_guid,'\nvideo_guid=',video_guid)

print('\n=== A) /v/api/v1/stream  直链信息 ===')
try:
    st=api('/v/api/v1/stream','POST',{"media_guid":media_guid,"level":1})
    print('code=',st.get('code'),'msg=',st.get('msg'))
    print(json.dumps(st.get('data'),ensure_ascii=False)[:800])
except Exception as e:
    print('异常:', e)

print('\n=== B) /media/range 直链响应 ===')
rng=f'{BASE}/v/api/v1/media/range/{media_guid}'
st,ct,chunk,dt,hdr=timed_fetch(rng, auth)
print(f'HTTP {st} type={ct} 首块 {len(chunk)} 字节 耗时 {dt:.2f}s')
print('headers:', {k:v for k,v in dict(hdr).items() if k.lower() in ('content-length','content-range','accept-ranges','content-type')})

print('\n=== C) 转码 HLS 首片耗时对比 ===')
pb={"media_guid":media_guid,"video_guid":video_guid,"video_encoder":"h264","resolution":"",
    "bitrate":0,"startTimestamp":0,"audio_encoder":"aac","audio_guid":"","subtitle_guid":"",
    "channels":2,"forced_sdr":0}
res=api('/v/api/v1/play/play','POST',pb)
play_link=(res.get('data') or {}).get('play_link')
pl=BASE+play_link
st,ct,chunk,dt,hdr=timed_fetch(pl, auth)
print(f'播放列表 HTTP {st} 耗时 {dt:.2f}s 长度 {len(chunk)}')
lines=[l for l in chunk.decode('utf-8','replace').split('\n') if l.strip()]
seg=next((l for l in lines if l and not l.startswith('#')), None)
from urllib.parse import urljoin

seg_url=urljoin(pl, seg)
t0=time.time()
st,ct,c2,dt,hdr=timed_fetch(seg_url, auth, timeout=60)
print(f'首个分片 HTTP {st} type={ct} {len(c2)} 字节 耗时 {dt:.2f}s')
