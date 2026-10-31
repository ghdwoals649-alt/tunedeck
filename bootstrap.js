// TuneDeck 시작 파일 — 자동 업데이트로 받은 새 버전이 있으면 그걸 실행한다.
// 이 파일은 자동 업데이트 대상이 아니므로 최대한 단순하게 유지한다.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

let dir = __dirname;
try {
  const root = path.join(app.getPath('userData'), 'app');
  const marker = path.join(root, 'boot-pending.txt');
  const currentFile = path.join(root, 'current.txt');
  const cur = fs.readFileSync(currentFile, 'utf8').trim();
  const cand = path.join(root, cur);
  const candVersion = JSON.parse(fs.readFileSync(path.join(cand, 'package.json'), 'utf8')).version;
  const bundledVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;

  let pending = '';
  try { pending = fs.readFileSync(marker, 'utf8').trim(); } catch {}

  if (pending === cand) {
    // 지난번에 이 업데이트 버전이 제대로 시작되지 못함 → 기본 버전으로 되돌림
    fs.rmSync(currentFile, { force: true });
    fs.rmSync(marker, { force: true });
  } else if (newer(candVersion, bundledVersion) && fs.existsSync(path.join(cand, 'main.js'))) {
    fs.writeFileSync(marker, cand);
    dir = cand;
  }
} catch {
  // 업데이트가 없거나 읽을 수 없으면 기본 버전 실행
}

// 설치 폴더 위치 (친구용 링크 전용판 표시 파일 edition.json 이 여기 있음)
global.TUNEDECK_BUNDLED_DIR = __dirname;

require(path.join(dir, 'main.js'));
