#!/usr/bin/env python3
"""갤럭시(안드로이드)용 TuneDeck.apk 만들기

필요: Java, apktool.jar, uber-apk-signer.jar (GitHub 릴리스)
    APKTOOL_JAR=/path/apktool.jar SIGNER_JAR=/path/uber-apk-signer.jar python3 build-apk.py

1) build-web.py 로 docs/ (폰 화면) 생성
2) docs 의 CSS·JS 를 index.html 하나로 합쳐 앱 assets 에 넣음
3) apktool 로 빌드 → uber-apk-signer 로 서명 → docs/TuneDeck.apk
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / 'docs'
ANDROID = ROOT / 'android'
STAGE = ROOT / 'android-build'
KEYSTORE = ANDROID / 'tunedeck.jks'
KS_PASS = 'tunedeck'

APKTOOL = os.environ.get('APKTOOL_JAR')
SIGNER = os.environ.get('SIGNER_JAR')


def run(cmd):
    print('$', ' '.join(str(c) for c in cmd))
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    out = '\n'.join(l for l in (r.stdout + r.stderr).splitlines() if not l.startswith('Picked up JAVA_TOOL_OPTIONS'))
    if out.strip():
        print(out)
    if r.returncode != 0:
        sys.exit(f'실패: {cmd[0]} (exit {r.returncode})')


def inline_html():
    html = (DOCS / 'index.html').read_text(encoding='utf-8')

    def css(m):
        return '<style>\n' + (DOCS / m.group(1)).read_text(encoding='utf-8') + '\n</style>'

    def js(m):
        code = (DOCS / m.group(1)).read_text(encoding='utf-8')
        if '</script' in code:
            sys.exit(f'{m.group(1)} 안에 </script 가 있어 합칠 수 없음')
        return '<script>\n' + code + '\n</script>'

    html = re.sub(r'<link rel="stylesheet" href="([\w.-]+\.css)">', css, html)
    html = re.sub(r'<script src="([\w.-]+\.js)"></script>', js, html)
    # 앱에서는 필요 없는 홈 화면 설치용 링크 제거
    html = re.sub(r'\s*<link rel="(manifest|icon|apple-touch-icon)"[^>]*>', '', html)
    assert 'src="app.js"' not in html and 'href="style.css"' not in html
    return html


def gradient_square(size):
    im = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(im)
    for y in range(size):
        t = y / size
        d.line([(0, y), (size, y)], fill=(int(20 + 68 * t), int(184 - 114 * t), int(166 + 63 * t), 255))
    return im


def draw_bars(im, scale):
    """가운데에 막대 6개 (scale: 아이콘 한 변 대비 막대 묶음 크기)"""
    S = im.size[0]
    d = ImageDraw.Draw(im)
    bars = [0.35, 0.62, 0.85, 0.55, 0.75, 0.42]
    unit = S * scale / (6 * 1 + 5 * 0.5)
    w, gap = unit, unit * 0.5
    total = 6 * w + 5 * gap
    x0 = (S - total) / 2
    base = S / 2 + S * scale * 0.42
    hmax = S * scale * 0.95
    for i, h in enumerate(bars):
        x = x0 + i * (w + gap)
        d.rounded_rectangle([x, base - h * hmax, x + w, base], radius=w / 2, fill=(255, 255, 255, 240))


def write_icons(res):
    # 예전 방식 아이콘 (둥근 사각형) — 기존 앱 아이콘 그대로
    src = Image.open(ROOT / 'assets' / 'icon.png').convert('RGBA')
    for folder, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        p = res / f'mipmap-{folder}'
        p.mkdir(parents=True, exist_ok=True)
        src.resize((px, px), Image.LANCZOS).save(p / 'ic_launcher.png')
    # 안드로이드 8+ 적응형 아이콘: 배경(그라데이션) + 전경(막대, 가운데 안전 영역 안)
    p = res / 'mipmap-xxxhdpi'
    gradient_square(432).save(p / 'ic_launcher_background.png')
    fg = Image.new('RGBA', (432, 432), (0, 0, 0, 0))
    draw_bars(fg, 0.42)
    fg.save(p / 'ic_launcher_foreground.png')
    a = res / 'mipmap-anydpi-v26'
    a.mkdir(parents=True, exist_ok=True)
    (a / 'ic_launcher.xml').write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
        '    <background android:drawable="@mipmap/ic_launcher_background" />\n'
        '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n'
        '</adaptive-icon>\n', encoding='utf-8')


def main():
    if not (APKTOOL and SIGNER):
        sys.exit('APKTOOL_JAR, SIGNER_JAR 환경 변수를 지정하세요.')

    run([sys.executable, ROOT / 'build-web.py'])
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    code = int(json.loads((ANDROID / 'version.json').read_text(encoding='utf-8'))['versionCode'])

    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir()
    shutil.copy2(ANDROID / 'AndroidManifest.xml', STAGE / 'AndroidManifest.xml')
    shutil.copytree(ANDROID / 'smali', STAGE / 'smali')
    (STAGE / 'assets').mkdir()
    (STAGE / 'assets' / 'index.html').write_text(inline_html(), encoding='utf-8')
    write_icons(STAGE / 'res')
    (STAGE / 'apktool.yml').write_text(
        f'version: 2.12.1\n'
        f'apkFileName: TuneDeck.apk\n'
        f'usesFramework:\n  ids:\n  - 1\n'
        f'sdkInfo:\n  minSdkVersion: 24\n  targetSdkVersion: 34\n'
        f'packageInfo:\n  forcedPackageId: 127\n'
        f'versionInfo:\n  versionCode: {code}\n  versionName: {version}\n'
        f'doNotCompress:\n- png\n', encoding='utf-8')

    unsigned = STAGE / 'TuneDeck-unsigned.apk'
    run(['java', '-jar', APKTOOL, 'b', STAGE, '-o', unsigned])

    if not KEYSTORE.exists():
        run(['keytool', '-genkeypair', '-keystore', KEYSTORE, '-storetype', 'PKCS12',
             '-storepass', KS_PASS, '-keypass', KS_PASS, '-alias', 'tunedeck',
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
             '-dname', 'CN=TuneDeck, O=TuneDeck, C=KR'])

    signed_dir = STAGE / 'signed'
    run(['java', '-jar', SIGNER, '-a', unsigned, '-o', signed_dir,
         '--ks', KEYSTORE, '--ksAlias', 'tunedeck', '--ksPass', KS_PASS, '--ksKeyPass', KS_PASS,
         '--allowResign'])
    out = next(signed_dir.glob('*.apk'))
    shutil.copy2(out, DOCS / 'TuneDeck.apk')
    print('완료:', DOCS / 'TuneDeck.apk', f'({(DOCS / "TuneDeck.apk").stat().st_size:,} bytes, v{version}, code {code})')


if __name__ == '__main__':
    main()
