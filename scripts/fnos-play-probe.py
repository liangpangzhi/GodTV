#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探测飞牛 HLS 播放链路：play_link / 分片地址 / 分片鉴权要求"""
import hashlib, json, random, time, urllib.request, urllib.error
from urllib.parse import urljoin

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


API_KEY = "NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"
API_SECRET = "16CCEB3D-AB42-077D-36A1-F355324E4237"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
TOKEN = None

def md5(s): return hashlib.md5(s.encode('utf-8')).hexdigest()

def authx(path, data=None):
    nonce = str(random.randint(100000, 999999)); ts = str(int(time.time()*1000))
    dmd5 = md5(json.dumps(data, separators=(',',':'), ensure_ascii=False)) if data is not None else md5("")
    sign = md5("_".join([API_KEY, path, nonce, ts, dmd5, API_SECRET]))
    return f"nonce={nonce}&timestamp={ts}&sign={sign}"

def api(path, method='GET', body=None):
    url = BASE + path
    headers = {'Accept':'application/json','User-Agent':UA,'x-trim-client':'web',
               'x-trim-client-version':'616','Authorization':TOKEN,
               'Cookie':f'Trim-MC-token={TOKEN}'}
    data = None
    if body is not None:
        headers['Content-Type']='application/json'
        headers['Authx']=authx(path, body)
        data = json.dumps(body, separators=(',',':'), ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode('utf-8','replace'))

def fetch_raw(url, with_token=True):
    headers = {'Accept':'*/*','User-Agent':UA}
    if with_token and TOKEN:
        headers['Authorization']=TOKEN; headers['Cookie']=f'Trim-MC-token={TOKEN}'
    req = urllib.request.Request(url, headers=headers, method='GET')
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.headers.get('content-type',''), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get('content-type',''), e.read()
    except Exception as e:
        return -1, '', str(e).encode()

# 1) login
body = _login_body()
headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':UA,
         'x-trim-client':'web','x-trim-client-version':'616','Authx':authx('/v/api/v1/login',body)}
req=urllib.request.Request(BASE+'/v/api/v1/login',data=json.dumps(body).encode(),headers=headers,method='POST')
with urllib.request.urlopen(req,timeout=20) as r:
    TOKEN=json.loads(r.read().decode())['data']['token']
print('1) 登录成功 token=', TOKEN[:8]+'...')

# 2) item/list 取 media_stream 信息
GUID="07e04d7929ff4de58deb305eb8c02651"
res=api('/v/api/v1/item/list','POST',{"guid":"58ff490462c948f5a2e254d499888a40","page":1,"page_size":10,"type":0})
item=(res.get('data') or {}).get('list',[{}])[0]
ms=item.get('media_stream') or {}
print('2) media_stream =', json.dumps(ms, ensure_ascii=False)[:300])

# 3) play/info
info=api("/v/api/v1/play/info","POST",{"item_guid":GUID})
print('3) play/info code=', info.get('code'), 'msg=', info.get('msg'))
data=info.get('data') or {}
media_guid=data.get('media_guid'); video_guid=data.get('video_guid')
print('   media_guid=', media_guid, ' video_guid=', video_guid)

# 4) /play/play
pb={"media_guid":media_guid or "","video_guid":video_guid or "","video_encoder":"h264",
    "resolution":"","bitrate":0,"startTimestamp":0,"audio_encoder":"aac","audio_guid":"",
    "subtitle_guid":"","channels":2,"forced_sdr":0}
res=api('/v/api/v1/play/play','POST',pb)
print('4) /play/play code=', res.get('code'), 'msg=', res.get('msg'))
play_link=(res.get('data') or {}).get('play_link')
print('   play_link =', play_link)
if not play_link: raise SystemExit(1)
pl_url = play_link if str(play_link).startswith('http') else BASE + ('/' if not str(play_link).startswith('/') else '') + str(play_link)

# 5) 播放列表
st, ct, b = fetch_raw(pl_url)
text=b.decode('utf-8','replace')
lines=[l.strip() for l in text.splitlines() if l.strip()]
print('5) 列表 HTTP', st, ct, '长度', len(text))
print('   前 10 行:', lines[:10])

seg=next((l for l in lines if l and not l.startswith('#')), None)
if seg:
    seg_url=urljoin(pl_url, seg)
    print('6) 分片 URL =', seg_url)
    st2,ct2,b2=fetch_raw(seg_url, True);  print('   带 token: HTTP',st2,ct2,'字节',len(b2), b2[:4])
    st3,ct3,b3=fetch_raw(seg_url, False); print('   无 token: HTTP',st3,ct3,'字节',len(b3), b3[:80])
