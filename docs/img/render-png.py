#!/usr/bin/env python3
"""Render the raster figures: the README hero pair and the GitHub social preview.

The vector figures come from build-figures.py. This script swaps the drawn character
(art/memory-card.png, art/memory-card-wave.png) into the hero, lays out the social preview,
and screenshots both with headless Chrome so Manrope and Inter render. Needs a network
connection for the Google Fonts request and Pillow for the final size pass.

    python3 docs/img/render-png.py

Outputs, next to this file: hero-light.png, hero-dark.png (2400x840),
social-preview-light.png, social-preview-dark.png (1280x640).
"""
import os, subprocess, sys, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700'
         '&family=Manrope:wght@300;600&display=swap" rel="stylesheet">')

PAL = {
    "light": dict(bg="#F2EBDD", ink="#1E2A38", muted="#5C605D", quiet="#8A8F8B", teal="#2E6E73",
                  rust="#C96F4A", sage="#C8D9C5", card="#FBF7EE", dot="#1E2A38", dotop="0.16"),
    "dark":  dict(bg="#1A1A1A", ink="#FAF9F7", muted="#A8ACA9", quiet="#7C807D", teal="#7FA0B4",
                  rust="#D4674F", sage="#33403A", card="#262624", dot="#FAF9F7", dotop="0.12"),
}


def shoot(html, out, w, h, scale=1):
    with tempfile.NamedTemporaryFile("w", suffix=".html", dir=HERE, delete=False) as f:
        f.write(html)
        path = f.name
    try:
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        f"--window-size={w},{h}", f"--force-device-scale-factor={scale}",
                        "--virtual-time-budget=4000", f"--screenshot={out}", f"file://{path}"],
                       check=True, capture_output=True)
    finally:
        os.unlink(path)


def shrink(path, colors=256):
    """Palette-quantize: flat cel art with halftone loses nothing visible and drops ~70% in size."""
    im = Image.open(path).convert("RGBA")
    im.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(path, optimize=True)
    return os.path.getsize(path)


def hero():
    tmp = tempfile.mkdtemp()
    env = dict(os.environ, THEMES="light,dark", HERO_ART=f"file://{HERE}/art/memory-card.png")
    subprocess.run([sys.executable, os.path.join(HERE, "build-figures.py"), tmp], check=True, env=env, capture_output=True)
    for theme in ("light", "dark"):
        svg = open(os.path.join(tmp, f"hero-{theme}.svg")).read()
        html = f'<!doctype html><html><head><meta charset="utf-8">{FONTS}<style>body{{margin:0;background:{PAL[theme]["bg"]}}}svg{{display:block}}</style></head><body>{svg}</body></html>'
        out = os.path.join(HERE, f"hero-{theme}.png")
        shoot(html, out, 1200, 420, scale=2)
        print(out, shrink(out))


def social():
    for theme in ("light", "dark"):
        p = PAL[theme]
        html = f'''<!doctype html><html><head><meta charset="utf-8">{FONTS}<style>
body{{margin:0;width:1280px;height:640px;background:{p["bg"]};font-family:Manrope,Inter,-apple-system,Helvetica,Arial,sans-serif;color:{p["ink"]};overflow:hidden;position:relative}}
.eyebrow{{position:absolute;left:96px;top:128px;font-family:Inter,sans-serif;font-size:15px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:{p["quiet"]}}}
h1{{position:absolute;left:92px;top:170px;margin:0;font-weight:300;font-size:92px;line-height:1.0;letter-spacing:-3px}}
.sub{{position:absolute;left:96px;top:398px;width:560px;font-family:Inter,sans-serif;font-size:23px;line-height:1.4;color:{p["muted"]}}}
.pills{{position:absolute;left:96px;top:512px;display:flex;gap:12px}}
.pill{{font-family:Inter,sans-serif;font-size:14px;font-weight:600;letter-spacing:.04em;padding:9px 18px;border:2.5px solid {p["ink"]};border-radius:999px;color:{p["ink"]}}}
.pill.rust{{border-color:{p["rust"]};color:{p["rust"] if theme == "dark" else p["ink"]};background:{"#3D2A24" if theme == "dark" else "#F1D9CC"}}}
.repo{{position:absolute;left:96px;bottom:40px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;color:{p["quiet"]}}}
.stage{{position:absolute;right:88px;top:52px;width:540px;height:540px}}
.stage svg{{position:absolute;inset:0}}
.stage img{{position:absolute;left:128px;top:44px;height:470px}}
</style></head><body>
<div class="eyebrow">open source &nbsp;&middot;&nbsp; macOS &nbsp;&middot;&nbsp; MIT</div>
<h1>Memory that<br>stays yours.</h1>
<div class="sub">Persistent memory for Claude. Plain files on your Mac, synced through accounts you already own, no server in the middle.</div>
<div class="pills"><span class="pill">search-first reads</span><span class="pill">private git sync</span><span class="pill rust">scan before push</span></div>
<div class="repo">npx setup-claude-memory@latest</div>
<div class="stage">
<svg viewBox="0 0 540 540" xmlns="http://www.w3.org/2000/svg">
<defs><pattern id="dots" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="2" cy="2" r="1.25" fill="{p["dot"]}" fill-opacity="{p["dotop"]}"/></pattern></defs>
<circle cx="270" cy="270" r="236" fill="{p["sage"]}"/><circle cx="270" cy="270" r="236" fill="url(#dots)"/>
<g stroke="{p["ink"]}" stroke-width="3" stroke-dasharray="1 9" stroke-linecap="round" stroke-opacity="0.7">
<line x1="60" y1="96" x2="490" y2="128"/><line x1="490" y1="128" x2="500" y2="430"/><line x1="500" y1="430" x2="40" y2="380"/><line x1="40" y1="380" x2="60" y2="96"/></g>
<g stroke="{p["ink"]}" stroke-width="4"><circle cx="60" cy="96" r="13" fill="{p["card"]}"/><circle cx="490" cy="128" r="15" fill="{p["rust"]}"/><circle cx="500" cy="430" r="15" fill="{p["card"]}"/><circle cx="40" cy="380" r="15" fill="{p["card"]}"/></g>
<ellipse cx="290" cy="516" rx="150" ry="11" fill="{"#000" if theme == "dark" else p["ink"]}" fill-opacity="{"0.35" if theme == "dark" else "0.10"}"/>
</svg>
<img src="file://{HERE}/art/memory-card-wave.png">
</div>
</body></html>'''
        out = os.path.join(HERE, f"social-preview-{theme}.png")
        shoot(html, out, 1280, 640)
        print(out, shrink(out))


if __name__ == "__main__":
    hero()
    social()
