import hashlib, json, random, time, urllib.request
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

API_KEY="NDzZTVxnRKP8Z0jXg1VAMonaG8akvh"; API_SECRET="16CCEB3D-AB42-077D-36A1-F355324E4237"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36"
def md5(s): return hashlib.md5(s.encode()).hexdigest()
def authx(p,d=None):
    n=str(random.randint(100000,999999)); t=str(int(time.time()*1000))
    dm=md5(json.dumps(d,separators=(',',':'),ensure_ascii=False)) if d is not None else md5("")
    return f"nonce={n}&timestamp={t}&sign={md5('_'.join([API_KEY,p,n,t,dm,API_SECRET]))}"
body = _login_body()
h={'Accept':'application/json','Content-Type':'application/json','User-Agent':UA,'x-trim-client':'web',
   'x-trim-client-version':'616','Authx':authx('/v/api/v1/login',body)}
r=urllib.request.Request(BASE+'/v/api/v1/login',data=json.dumps(body).encode(),headers=h,method='POST')
TOKEN=json.loads(urllib.request.urlopen(r,timeout=20).read().decode())['data']['token']
AUTH={'Authorization':TOKEN,'Cookie':f'Trim-MC-token={TOKEN}','User-Agent':UA,
      'x-trim-client':'web','x-trim-client-version':'616'}
def api(p,b):
    hh=dict(AUTH); hh['Content-Type']='application/json'; hh['Authx']=authx(p,b)
    req=urllib.request.Request(BASE+p,data=json.dumps(b,separators=(',',':'),ensure_ascii=False).encode(),headers=hh,method='POST')
    return json.loads(urllib.request.urlopen(req,timeout=60).read().decode('utf-8','replace'))
def fetch(url):
    t0=time.time()
    req=urllib.request.Request(url,headers=AUTH)
    with urllib.request.urlopen(req,timeout=120) as resp:
        data=resp.read(); return len(data), time.time()-t0

GUID="07e04d7929ff4de58deb305eb8c02651"
info=api('/v/api/v1/play/info',{"item_guid":GUID})['data']
mg,vg=info['media_guid'],info['video_guid']

for res,bitrate in [("", 0), ("1080p", 0), ("720p", 0), ("480p", 0)]:
    pb={"media_guid":mg,"video_guid":vg,"video_encoder":"h264","resolution":res,"bitrate":bitrate,
        "startTimestamp":0,"audio_encoder":"aac","audio_guid":"","subtitle_guid":"","channels":2,"forced_sdr":0}
    t0=time.time()
    r=api('/v/api/v1/play/play',pb)
    pl=(r.get('data') or {}).get('play_link')
    if not pl:
        print(f'resolution={res or "默认"} -> 失败 code={r.get("code")} msg={r.get("msg")}'); continue
    url=BASE+pl
    n1,d1=fetch(url)
    lines=[l for l in n1 and urllib.request.urlopen(urllib.request.Request(url,headers=AUTH),timeout=60).read().decode('utf-8','replace').split('\n') if l.strip()]
    segs=[l for l in lines if l and not l.startswith('#')]
    seg_url=urljoin(url, segs[0])
    s0,ts0=fetch(seg_url)          # 首片（含转码启动）
    s1,ts1=fetch(urljoin(url,segs[1]))  # 第二片（稳态）
    print(f'resolution={res or "默认":6} bitrate={bitrate}: 首片 {s0}B/{ts0:.2f}s  第二片 {s1}B/{ts1:.2f}s  '
          f'→ {"实时可播" if ts1 < 5 else "跟不上实时(会累积延迟)"}')
