#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""God TV 应用图标生成器

绘制大写「G」艺术字图标（几何构造 + 金色渐变 + 外发光），
输出 public/icons/ 下多尺寸 PNG 与 .electron-build/icon.ico。

用法: python scripts/make-app-icon.py
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024          # 输出尺寸
SS = 3            # 超采样倍数
N = S * SS

# ---------- 调色板 ----------
BG_TOP = (18, 23, 43)
BG_BOT = (4, 6, 14)
GLOW = (60, 92, 220)
GOLD_HI = (255, 236, 173)
GOLD_MID = (255, 194, 74)
GOLD_LOW = (233, 132, 17)


def vgrad(size, top, bot):
    """竖直渐变"""
    w, h = size
    img = Image.new("RGB", (1, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        d.point((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((w, h), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build_g_mask(size):
    """构造大写 G 的字形蒙版（几何 logo 风格）"""
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    cx = cy = size / 2

    R = size * 0.303          # 圆弧中心线半径
    sw = size * 0.113         # 笔画粗细
    half = sw / 2
    box = [cx - R, cy - R, cx + R, cy + R]

    # 主圆弧：3 点钟起顺时针扫至 302°，右上方留出开口
    d.arc(box, start=0, end=302, fill=255, width=int(sw))

    # 横杠：自圆弧 3 点钟末端向内延伸至约 45% 半径处
    bar_right = cx + R + half
    bar_left = cx + R * 0.42
    d.rectangle([bar_left, cy - half, bar_right, cy + half], fill=255)

    # 横杠内端做圆角收束，避免方形切口的生硬感
    r = half
    d.ellipse([bar_left - r, cy - half, bar_left + r, cy + half], fill=255)
    d.rectangle([bar_left, cy - half, bar_left + r, cy + half], fill=255)

    return m


def main():
    # ---------- 背景 ----------
    canvas = vgrad((N, N), BG_TOP, BG_BOT).convert("RGBA")

    # 中心辉光
    glow = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = N * 0.46
    gd.ellipse([N / 2 - gr, N / 2 - gr * 0.95, N / 2 + gr, N / 2 + gr * 0.95], fill=GLOW + (105,))
    glow = glow.filter(ImageFilter.GaussianBlur(N * 0.13))
    canvas = Image.alpha_composite(canvas, glow)

    # 左上柔光，避免大块纯色显得沉闷
    sheen = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.ellipse([-N * 0.35, -N * 0.42, N * 0.72, N * 0.62], fill=(255, 255, 255, 16))
    sheen = sheen.filter(ImageFilter.GaussianBlur(N * 0.12))
    canvas = Image.alpha_composite(canvas, sheen)

    # ---------- 字形 ----------
    gmask = build_g_mask(N)

    # 外发光：蒙版模糊后染成金色
    halo_a = gmask.filter(ImageFilter.GaussianBlur(N * 0.032)).point(lambda v: int(v * 0.38))
    halo = Image.new("RGBA", (N, N), GOLD_MID + (255,))
    halo.putalpha(halo_a)
    canvas = Image.alpha_composite(canvas, halo)

    # 立体投影
    shadow_a = gmask.filter(ImageFilter.GaussianBlur(N * 0.018)).point(lambda v: int(v * 0.5))
    shadow = Image.new("RGBA", (N, N), (0, 0, 0, 255))
    shadow.putalpha(shadow_a)
    off = int(N * 0.012)
    sh_layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    sh_layer.paste(shadow, (0, off), shadow)
    canvas = Image.alpha_composite(canvas, sh_layer)

    # 金色渐变填充字形
    ggrad = vgrad((N, N), GOLD_HI, GOLD_LOW).convert("RGBA")
    mid = Image.new("RGBA", (N, N), GOLD_MID + (255,))
    ggrad = Image.blend(ggrad, mid, 0.22)
    ggrad.putalpha(gmask)
    canvas = Image.alpha_composite(canvas, ggrad)

    # 字形内部顶部提亮，增加金属感
    top_light = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    tl_a = Image.new("L", (N, N), 0)
    ImageDraw.Draw(tl_a).rectangle([0, 0, N, int(N * 0.42)], fill=90)
    tl_a = Image.composite(tl_a, Image.new("L", (N, N), 0), gmask)
    top_light.putalpha(tl_a.filter(ImageFilter.GaussianBlur(N * 0.03)))
    canvas = Image.alpha_composite(canvas, top_light)

    # ---------- 圆角裁切 + 描边 ----------
    canvas.putalpha(rounded_mask(N, int(N * 0.225)))

    border = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border)
    bw = max(2, int(N * 0.004))
    bd.rounded_rectangle([bw, bw, N - bw, N - bw], radius=int(N * 0.225),
                         outline=(255, 255, 255, 46), width=bw)
    canvas = Image.alpha_composite(canvas, border)

    # ---------- 输出 ----------
    icon_dir = os.path.join(ROOT, "public", "icons")
    os.makedirs(icon_dir, exist_ok=True)

    master = canvas.resize((S, S), Image.LANCZOS)
    master.save(os.path.join(icon_dir, "icon-1024x1024.png"))
    for sz in (512, 384, 256, 192, 180, 152, 144, 120, 96, 72, 48, 32, 16):
        im = master.resize((sz, sz), Image.LANCZOS)
        name = f"icon-{sz}x{sz}.png"
        im.save(os.path.join(icon_dir, name))
        if sz in (512, 384, 256, 192):
            print("saved", name)

    # favicon
    master.resize((64, 64), Image.LANCZOS).save(os.path.join(ROOT, "public", "favicon.ico"),
                                               sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

    # Windows 多尺寸 ICO
    ico_path = os.path.join(ROOT, ".electron-build", "icon.ico")
    master.save(ico_path, format="ICO",
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("saved", ico_path, os.path.getsize(ico_path), "bytes")

    # 预览图（带透明底展示）
    preview = Image.new("RGBA", (S + 120, S + 120), (245, 246, 250, 255))
    preview.paste(master, (60, 60), master)
    preview.convert("RGB").save(os.path.join(ROOT, "public", "icons", "_preview.png"))


if __name__ == "__main__":
    main()
