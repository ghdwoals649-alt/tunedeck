#!/usr/bin/env python3
"""폰(웹)용 TuneDeck 만들기: renderer/ + web/ -> docs/ (GitHub Pages가 docs 폴더를 웹페이지로 공개)

    python3 build-web.py
"""
import json
import shutil
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'renderer'
WEB = ROOT / 'web'
OUT = ROOT / 'docs'
NAME = 'youtape'  # 폰에서 보이는 앱 이름


def must_replace(text, old, new):
    if old not in text:
        raise SystemExit(f'index.html 에서 찾지 못함: {old}')
    return text.replace(old, new, 1)


def build_index():
    html = (SRC / 'index.html').read_text(encoding='utf-8')
    html = must_replace(html, '<title>TuneDeck</title>', f'<title>{NAME}</title>')
    html = must_replace(html, 'class="ltitle">TuneDeck<', f'class="ltitle">{NAME}<')
    html = must_replace(html, '<html lang="ko">', '<html lang="ko" class="mobile">')
    html = must_replace(
        html,
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    )
    html = must_replace(
        html,
        '<meta name="referrer" content="strict-origin-when-cross-origin">',
        '<meta name="referrer" content="strict-origin-when-cross-origin">\n'
        '  <meta name="color-scheme" content="dark">\n'
        '  <meta name="theme-color" content="#120f14">\n'
        '  <meta name="mobile-web-app-capable" content="yes">\n'
        '  <link rel="manifest" href="manifest.webmanifest">\n'
        '  <link rel="icon" href="icon-192.png">\n'
        '  <link rel="apple-touch-icon" href="icon-192.png">',
    )
    html = must_replace(
        html,
        '<link rel="stylesheet" href="style.css">',
        '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="mobile.css">',
    )
    html = must_replace(
        html,
        '<script src="app.js"></script>',
        '<script src="web-api.js"></script>\n  <script src="app.js"></script>\n  <script src="mobile.js"></script>',
    )
    (OUT / 'index.html').write_text(html, encoding='utf-8')


def build_icons():
    src = Image.open(ROOT / 'assets' / 'icon.png').convert('RGBA')
    for size in (192, 512):
        src.resize((size, size), Image.LANCZOS).save(OUT / f'icon-{size}.png')

    # 안드로이드 둥근/물방울 아이콘용: 가장자리까지 꽉 찬 배경 + 가운데 80% 안에 막대
    S = 512
    im = Image.new('RGBA', (S, S))
    d = ImageDraw.Draw(im)
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=(int(20 + 68 * t), int(184 - 114 * t), int(166 + 63 * t), 255))
    bars = [0.35, 0.62, 0.85, 0.55, 0.75, 0.42]
    w, gap = 34, 18
    x0 = (S - (len(bars) * w + (len(bars) - 1) * gap)) // 2
    base = 350
    for i, h in enumerate(bars):
        x = x0 + i * (w + gap)
        d.rounded_rectangle([x, base - int(h * 200), x + w, base], radius=17, fill=(255, 255, 255, 240))
    im.save(OUT / 'icon-maskable-512.png')


def build_manifest():
    manifest = {
        'name': NAME,
        'short_name': NAME,
        'description': '카세트테이프 음악 플레이어',
        'lang': 'ko',
        'start_url': './',
        'scope': './',
        'display': 'standalone',
        'orientation': 'portrait',
        'background_color': '#120f14',
        'theme_color': '#120f14',
        'icons': [
            {'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    (OUT / 'manifest.webmanifest').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    shutil.copy2(SRC / 'style.css', OUT / 'style.css')
    app = (SRC / 'app.js').read_text(encoding='utf-8')
    app = app.replace("'TuneDeck'", f"'{NAME}'").replace('— TuneDeck', f'— {NAME}')
    (OUT / 'app.js').write_text(app, encoding='utf-8')
    for f in ('web-api.js', 'mobile.js', 'mobile.css', 'sw.js'):
        shutil.copy2(WEB / f, OUT / f)
    build_index()
    build_icons()
    build_manifest()
    (OUT / '.nojekyll').write_text('', encoding='utf-8')  # GitHub Pages가 파일을 그대로 내보내게
    print('docs/ 생성:', ', '.join(sorted(p.name for p in OUT.iterdir())))


if __name__ == '__main__':
    main()
