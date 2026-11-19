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
def api(p,m='GET',b=None):
    hh={'Accept':'application/json','User-Agent':UA,'x-trim-client':'web','x-trim-client-version':'616',
        'Authorization':TOKEN,'Cookie':f'Trim-MC-token={TOKEN}'}
    d=None
    if b is not None:
        hh['Content-Type']='application/json'; hh['Authx']=authx(p,b); d=json.dumps(b,separators=(',',':'),ensure_ascii=False).encode()
    req=urllib.request.Request(BASE+p,data=d,headers=hh,method=m)
    return json.loads(urllib.request.urlopen(req,timeout=30).read().decode('utf-8','replace'))
GUID="07e04d7929ff4de58deb305eb8c02651"
info=api('/v/api/v1/play/info','POST',{"item_guid":GUID})
print('=== play/info 完整数据 ===')
print(json.dumps(info.get('data'),ensure_ascii=False,indent=1)[:1500])
# 尝试几种 stream 参数组合
mg=info['data']['media_guid']; vg=info['data']['video_guid']
for body_try in [{"media_guid":mg,"level":1},{"media_guid":mg,"level":0},{"media_guid":mg},
                 {"media_guid":mg,"video_guid":vg,"level":1},{"guid":GUID,"level":1},{"media_guid":mg,"level":2}]:
    try:
        st=api('/v/api/v1/stream','POST',body_try)
        print('stream 参数', body_try, '-> code=',st.get('code'), 'msg=',st.get('msg'),
              ('data=' + json.dumps(st.get('data'),ensure_ascii=False)[:300]) if st.get('data') else '')
    except Exception as e:
        print('stream 参数', body_try, '-> 异常', e)
# media/range 首字节（判断容器格式）
auth={'Authorization':TOKEN,'Cookie':f'Trim-MC-token={TOKEN}','User-Agent':UA}
req=urllib.request.Request(f'{BASE}/v/api/v1/media/range/{mg}', headers={**auth,'Range':'bytes=0-2047'})
resp=urllib.request.urlopen(req,timeout=30)
head=resp.read(2048)
print('\n=== media/range 首 2048 字节 ===')
print('前 16 字节:', head[:16])
print('是否 ftyp(mp4):', head[4:8]==b'ftyp', '| 是否 EBML(mkv):', head[:4]==b'\x1a\x45\xdf\xa3')
