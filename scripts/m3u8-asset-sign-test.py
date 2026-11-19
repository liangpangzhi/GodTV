#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 /api/proxy/m3u8-asset 的签名校验：无 AUTH_SECRET 时必然 403。"""
import base64
import hashlib
import hmac
import subprocess
import sys
import time
import urllib.parse
import urllib.request

TARGET = "http://127.0.0.1:5666/v/media/probe/00000.ts"
SECRET = "test-secret-123"


def sign(url, referer, secret):
    payload = f"{url}\n{referer or ''}".encode()
    digest = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def call_asset(port, secret):
    url = (
        f"http://127.0.0.1:{port}/api/proxy/m3u8-asset?url="
        + urllib.parse.quote(TARGET, safe="")
        + "&sig="
        + urllib.parse.quote(sign(TARGET, None, secret), safe="")
    )
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.status, r.read()[:120]
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:160]
    except Exception as e:
        return -1, str(e).encode()[:120]


if __name__ == "__main__":
    print("目标:", TARGET)
    print("A) 服务端无 AUTH_SECRET（修复前行为）:", call_asset(int(sys.argv[1]), SECRET))
