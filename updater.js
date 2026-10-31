// GitHub 저장소에서 새 버전을 받아 사용자 데이터 폴더에 설치한다.
// 실제 적용은 다음 실행 때 bootstrap.js가 한다.
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = 'ghdwoals649-alt/tunedeck';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function fetchRaw(file) {
  const url = RAW + file.split('/').map(encodeURIComponent).join('/') + `?t=${Date.now()}`;
  const res = await net.fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const SAFE = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * 새 버전이 있으면 내려받아 설치하고 버전 문자열을 돌려준다. 없으면 null.
 * runningDir: 지금 실행 중인 앱 폴더 (정리할 때 지우지 않도록)
 */
async function checkAndDownload(currentVersion, runningDir) {
  const manifest = JSON.parse((await fetchRaw('version.json')).toString('utf8'));
  const version = String(manifest.version || '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, currentVersion)) return null;

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!files.includes('main.js') || !files.includes('package.json')) throw new Error('manifest incomplete');
  if (!files.every((f) => typeof f === 'string' && SAFE.test(f))) throw new Error('manifest has bad path');

  const root = path.join(app.getPath('userData'), 'app');
  const staging = path.join(root, `${version}.partial`);
  const final = path.join(root, version);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  for (const f of files) {
    const data = await fetchRaw(f);
    const dest = path.join(staging, f);
    if (!dest.startsWith(staging + path.sep)) throw new Error('bad path');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error('version mismatch');

  if (path.resolve(final) !== path.resolve(runningDir)) fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(staging, final);
  fs.writeFileSync(path.join(root, 'current.txt'), version);

  // 오래된 버전 폴더 정리
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name);
    if (name === version || name.endsWith('.txt')) continue;
    if (path.resolve(p) === path.resolve(runningDir)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
  return version;
}

module.exports = { checkAndDownload, REPO };
