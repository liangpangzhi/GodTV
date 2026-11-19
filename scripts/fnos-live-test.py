#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""飞牛影视 API 真实联调（复刻 src/lib/fnos-client.ts 的 Authx 签名协议）"""
import hashlib
import json
import random
import time
import urllib.request

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
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")

TOKEN = None


def md5(s):
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def authx(path, params=None, data=None):
    nonce = str(random.randint(100000, 999999))
    ts = str(int(time.time() * 1000))
    if data is not None:
        data_md5 = md5(json.dumps(data, separators=(",", ":"), ensure_ascii=False))
    elif params:
        s = "&".join(f"{k}={params[k]}" for k in sorted(params))
        data_md5 = md5(s)
    else:
        data_md5 = md5("")
    sign = md5("_".join([API_KEY, path, nonce, ts, data_md5, API_SECRET]))
    return f"nonce={nonce}&timestamp={ts}&sign={sign}"


def call(path, method="GET", params=None, body=None, token=None):
    global TOKEN
    url = BASE + path
    if method == "GET" and params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
    headers = {
        "Accept": "application/json",
        "User-Agent": UA,
        "Authorization": token or TOKEN or "",
        "x-trim-client": "web",
        "x-trim-client-version": "616",
        "Authx": authx(path, params if method == "GET" else None, body),
    }
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers["Cookie"] = f"Trim-MC-token={token or TOKEN}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            txt = resp.read().decode("utf-8", "replace").lstrip("﻿")
            return json.loads(txt)
    except urllib.error.HTTPError as e:
        return {"httpError": e.code, "body": e.read().decode("utf-8", "replace")[:300]}


def show(tag, obj, limit=400):
    s = json.dumps(obj, ensure_ascii=False)
    print(f"[{tag}] {s[:limit]}{'...' if len(s) > limit else ''}")


print("=" * 60)
print("1) 登录 POST /v/api/v1/login")
body = _login_body()
r = call("/v/api/v1/login", "POST", body=body)
show("login", r)
if r.get("code") == 0 and r.get("data", {}).get("token"):
    TOKEN = r["data"]["token"]
    print(f"    -> token 获取成功 (长度 {len(TOKEN)})")
else:
    print("    -> 登录失败，终止")
    raise SystemExit(1)

print("=" * 60)
print("2) 媒体库列表 GET /v/api/v1/mediadb/list")
r = call("/v/api/v1/mediadb/list")
show("mediadb", r)
dbs = r.get("data") or []
print(f"    -> 媒体库数量: {len(dbs)}")
for db in dbs[:10]:
    print(f"       - guid={db.get('guid')} title={db.get('title')} category={db.get('category')}")

if dbs:
    guid = dbs[0].get("guid")
    print("=" * 60)
    print(f"3) 条目列表 POST /v/api/v1/item/list (guid={guid})")
    r = call("/v/api/v1/item/list", "POST",
             body={"guid": guid, "page": 1, "page_size": 10, "type": 0})
    show("item/list", r, 600)
    items = (r.get("data") or {}).get("list") if isinstance(r.get("data"), dict) else r.get("data")
    if isinstance(items, list):
        print(f"    -> 条目数量: {len(items)}")
        for it in items[:8]:
            print(f"       - guid={it.get('guid')} title={it.get('title')} type={it.get('type')}")
