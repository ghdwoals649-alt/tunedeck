// TuneDeck — 화면 가장자리에 붙는 LP 위젯형 YouTube 플레이어
const {
  app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut,
  ipcMain, screen, net, shell, session, desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const updater = require('./updater');

// Windows 투명 창 + GPU 합성에서 카세트가 안 그려지는 문제를 피하려고 소프트웨어 렌더링 사용
// (작은 위젯이라 성능 차이는 거의 없음)
app.disableHardwareAcceleration();

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
let updateReady = null;

// 판 구분: 설치 폴더에 edition.json {"search": false} 가 있으면 검색이 빠진 링크 전용판
const EDITION = (() => {
  try {
    const base = global.TUNEDECK_BUNDLED_DIR || __dirname;
    const e = JSON.parse(fs.readFileSync(path.join(base, 'edition.json'), 'utf8'));
    return { search: e.search !== false, updates: e.updates !== false };
  } catch {
    return { search: true, updates: true };
  }
})();

// 모양(카세트/LP/CD)별 크기. tape = 접힌 위젯 크기, slot = 펼친 창 안에서 데크에 놓인 위치/크기
// (renderer/style.css 의 .skin-* 값과 같아야 함)
const SKINS = {
  cassette: { tape: { w: 154, h: 98 }, slot: { x: 35, y: 55, w: 210, h: 134 } },
  lp: { tape: { w: 112, h: 112 }, slot: { x: 62, y: 46, w: 156, h: 156 } },
  cd: { tape: { w: 108, h: 108 }, slot: { x: 66, y: 50, w: 148, h: 148 } },
  // 숨은 테마 (테마 제목 5번 클릭)
  washer: { tape: { w: 112, h: 112 }, slot: { x: 62, y: 46, w: 156, h: 156 } },
  tire: { tape: { w: 112, h: 112 }, slot: { x: 62, y: 46, w: 156, h: 156 } },
  magic: { tape: { w: 116, h: 116 }, slot: { x: 60, y: 44, w: 160, h: 160 } },
};
let skinName = 'cassette';
const TAPE = {
  pad: 12,
  get w() { return SKINS[skinName].tape.w; },
  get h() { return SKINS[skinName].tape.h; },
};
const COLLAPSED = {
  get w() { return TAPE.w + TAPE.pad * 2; },
  get h() { return TAPE.h + TAPE.pad * 2; },
};
const SLOT = {
  get x() { return SKINS[skinName].slot.x; },
  get y() { return SKINS[skinName].slot.y; },
  get w() { return SKINS[skinName].slot.w; },
  get h() { return SKINS[skinName].slot.h; },
};
const EXPANDED_W = 280;
const EXPANDED_MAX_H = 620;

let win = null;
let tray = null;
let server = null;
let port = 0;
let isQuitting = false;
let expanded = false;
let drag = null;

// ---------- 저장소 ----------
const file = (name) => path.join(app.getPath('userData'), name);
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}
function writeJSON(name, data) {
  try { fs.writeFileSync(file(name), JSON.stringify(data, null, 2)); } catch {}
}
const settings = () => readJSON('settings.json', {});
const saveSettings = (patch) => writeJSON('settings.json', { ...settings(), ...patch });

// ---------- 중복 실행 방지 ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    win.show();
    if (!expanded) win.webContents.send('toggle');
  });
}

// ---------- 위치 계산 ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const areaAt = (x, y) => screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;

// 접힌 카세트 창의 위치 (사용자가 끌어다 놓은 곳)
let dock = null;
let movedWhileExpanded = false;

function clampDock(d) {
  const wa = areaAt(d.x + COLLAPSED.w / 2, d.y + COLLAPSED.h / 2);
  return {
    x: clamp(Math.round(d.x), wa.x, wa.x + wa.width - COLLAPSED.w),
    y: clamp(Math.round(d.y), wa.y, wa.y + wa.height - COLLAPSED.h),
  };
}

function getDock() {
  if (dock) return dock;
  const saved = settings().dock;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    dock = clampDock(saved);
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    dock = clampDock({ x: wa.x + wa.width - COLLAPSED.w - 24, y: wa.y + wa.height * 0.35 });
  }
  return dock;
}

function setDock(d) {
  dock = clampDock(d);
  saveSettings({ dock });
}

function collapsedBounds() {
  const d = getDock();
  return { x: d.x, y: d.y, width: COLLAPSED.w, height: COLLAPSED.h };
}

// 카세트 중심이 그대로 있도록 펼친 창을 배치 (화면 밖으로 나가면 안쪽으로 밀어 넣음)
function expandedBounds() {
  const d = getDock();
  const cx = d.x + TAPE.pad + TAPE.w / 2;
  const cy = d.y + TAPE.pad + TAPE.h / 2;
  const wa = areaAt(cx, cy);
  const height = Math.min(wa.height - 20, EXPANDED_MAX_H);
  const x = clamp(Math.round(cx - (SLOT.x + SLOT.w / 2)), wa.x, wa.x + wa.width - EXPANDED_W);
  const y = clamp(Math.round(cy - (SLOT.y + SLOT.h / 2)), wa.y, wa.y + wa.height - height);
  return {
    bounds: { x, y, width: EXPANDED_W, height },
    // 펼친 창 안에서 카세트가 처음 있어야 할 위치 (접힌 상태와 같은 화면 위치)
    start: { left: d.x + TAPE.pad - x, top: d.y + TAPE.pad - y },
  };
}

function applyBounds(b) {
  if (!win) return;
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
  // 크기가 바뀐 뒤 투명 창이 빈 화면으로 남지 않도록 두 번 다시 그림
  setTimeout(() => { try { win.webContents.invalidate(); } catch {} }, 16);
  setTimeout(() => { try { win.webContents.invalidate(); } catch {} }, 120);
}

// IP 주소(127.0.0.1)보다 localhost 출처가 YouTube 플레이어에서 더 잘 받아들여짐
const appOrigin = () => `http://localhost:${port}`;

// ---------- 화면 파일을 로컬 주소로 제공 (YouTube 플레이어는 http 출처가 필요) ----------
function startServer() {
  const root = path.join(__dirname, 'renderer');
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      if (p === '/') p = '/index.html';
      const f = path.normalize(path.join(root, p));
      if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
          'Content-Type': types[path.extname(f)] || 'application/octet-stream',
          // YouTube 플레이어는 Referer가 없으면 오류 153을 냄
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

// ---------- 창 ----------
function createWindow() {
  const s = settings();
  win = new BrowserWindow({
    ...collapsedBounds(),
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    hasShadow: false,
    alwaysOnTop: s.alwaysOnTop !== false,
    backgroundColor: '#00000000',
    title: 'TuneDeck',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  const ua = win.webContents.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?tunedeck\/\S+/i, '');
  win.webContents.setUserAgent(ua);

  win.loadURL(`${appOrigin()}/`);

  // 화면이 정상적으로 떴으면 "업데이트 버전 시작 실패" 표시를 지움
  win.webContents.once('did-finish-load', () => {
    try { fs.rmSync(path.join(app.getPath('userData'), 'app', 'boot-pending.txt'), { force: true }); } catch {}
    win.webContents.send('app-info', { version: APP_VERSION });
    if (updateReady) win.webContents.send('update-ready', updateReady);
  });

  // 작업표시줄 아이콘을 누르면(최소화됐다 돌아오면) 펼치기
  win.on('restore', () => { if (!expanded) win.webContents.send('toggle'); });

  // F12 또는 Ctrl+Shift+I: 문제 확인용 개발자 도구
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      win.webContents.openDevTools({ mode: 'detach' });
      e.preventDefault();
    }
  });
  win.once('ready-to-show', () => win.showInactive());

  // 영상 안의 링크(채널, YouTube 로고 등)는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appOrigin())) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
}

// ---------- IPC ----------
ipcMain.handle('state:load', () => readJSON('library.json', null));
ipcMain.on('state:save', (_e, data) => writeJSON('library.json', data));

ipcMain.handle('oembed', async (_e, id) => {
  if (!/^[\w-]{11}$/.test(id)) return null;
  try {
    const res = await net.fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`
    );
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title, author: j.author_name };
  } catch {
    return null;
  }
});

ipcMain.handle('win:prepareExpand', () => expandedBounds().start);
ipcMain.handle('win:expand', () => {
  applyBounds(expandedBounds().bounds);
  expanded = true;
  movedWhileExpanded = false;
  win.focus();
});
// 접기 직전: 카세트가 돌아갈 위치(펼친 창 기준 좌표)를 알려줌
ipcMain.handle('win:prepareCollapse', () => {
  const b = win.getBounds();
  if (movedWhileExpanded) {
    // 펼친 상태에서 창을 옮겼으면, 데크 위치에서 그대로 접힘
    setDock({
      x: b.x + SLOT.x + SLOT.w / 2 - TAPE.w / 2 - TAPE.pad,
      y: b.y + SLOT.y + SLOT.h / 2 - TAPE.h / 2 - TAPE.pad,
    });
  }
  const d = getDock();
  return { left: d.x + TAPE.pad - b.x, top: d.y + TAPE.pad - b.y };
});
ipcMain.handle('win:collapse', () => {
  applyBounds(collapsedBounds());
  expanded = false;
});

// 끌어서 옮기기 (접힌 카세트, 또는 펼친 창의 위쪽/카세트)
ipcMain.on('dock:start', (_e, sx, sy) => {
  const b = win.getBounds();
  drag = { sx, sy, x: b.x, y: b.y };
});
ipcMain.on('dock:move', (_e, sx, sy) => {
  if (!drag) return;
  const b = win.getBounds();
  let x = drag.x + (sx - drag.sx);
  let y = drag.y + (sy - drag.sy);
  const wa = areaAt(x + b.width / 2, y + b.height / 2);
  x = clamp(x, wa.x - b.width + 60, wa.x + wa.width - 60);
  y = clamp(y, wa.y, wa.y + wa.height - 40);
  win.setPosition(Math.round(x), Math.round(y));
});
ipcMain.on('dock:end', () => {
  if (!drag) return;
  drag = null;
  const b = win.getBounds();
  if (expanded) movedWhileExpanded = true;
  else setDock({ x: b.x, y: b.y });
  if (!expanded) applyBounds(collapsedBounds()); // 화면 안쪽으로 맞춤
});

ipcMain.on('app:quit', () => { isQuitting = true; app.quit(); });

// 위젯 투명도는 CSS가 아니라 창 자체에 적용 (Windows 투명 창에서 CSS 투명도는 화면이 안 그려지는 문제가 있음)
// 창 투명도(setOpacity)는 절대 쓰지 않음: Windows에서 한 번이라도 호출하면 투명 창이 '레이어드 창'으로 바뀌어
// 카세트가 안 그려지거나 접을 때 창 전체가 사라짐. 투명도는 화면 안의 배경색으로만 처리함.
ipcMain.on('win:opacity', () => {});
// 화면 전체를 강제로 다시 그림 (애니메이션·창 크기 변경 뒤 잔상/사라짐 방지)
const repaint = () => { try { win?.webContents.invalidate(); } catch {} };
ipcMain.on('win:repaint', repaint);
ipcMain.on('app:applyUpdate', () => {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
});

// ---------- 자동 업데이트 ----------
async function checkForUpdate() {
  if (updateReady || !EDITION.updates) return; // zip 배포판은 자동 업데이트 안 함
  try {
    const v = await updater.checkAndDownload(APP_VERSION, __dirname);
    if (v) {
      updateReady = v;
      win?.webContents.send('update-ready', v);
      tray?.setToolTip(`TuneDeck — 새 버전 ${v} 준비됨 (다시 시작하면 적용)`);
    }
  } catch (err) {
    console.warn('update check failed:', err && err.message);
  }
}

ipcMain.on('open-external', (_e, url) => {
  if (/^https:\/\/((www\.|music\.)?youtube\.com|console\.cloud\.google\.com)\//.test(url)) shell.openExternal(url);
});

// ---------- YouTube 검색 (공식 Data API v3, 사용자 본인의 API 키) ----------
const decodeEntities = (s) => String(s || '')
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

function isoDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return '';
  const h = +(m[1] || 0), mi = +(m[2] || 0), s = +(m[3] || 0);
  if (!h && !mi && !s) return '';
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(mi).padStart(2, '0')}:${ss}` : `${mi}:${ss}`;
}

async function ytSearch(q, key, max = 20) {
  const params = new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true',
    maxResults: String(max), q, key, regionCode: 'KR', relevanceLanguage: 'ko',
  });
  const res = await net.fetch('https://www.googleapis.com/youtube/v3/search?' + params);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || '';
    const msg = json?.error?.message || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return { error: 'quota' };
    if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(msg)) return { error: 'notenabled' };
    if (reason === 'keyInvalid' || /API key not valid|API_KEY_INVALID/i.test(msg)) return { error: 'badkey' };
    return { error: 'fail', message: msg };
  }
  const items = (json.items || [])
    .filter((i) => i.id && i.id.videoId)
    .map((i) => ({ id: i.id.videoId, title: decodeEntities(i.snippet.title), author: decodeEntities(i.snippet.channelTitle) }));
  if (items.length) {
    try {
      const r2 = await net.fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({
        part: 'contentDetails', id: items.map((i) => i.id).join(','), key,
      }));
      if (r2.ok) {
        const j2 = await r2.json();
        const dur = new Map((j2.items || []).map((v) => [v.id, isoDuration(v.contentDetails?.duration)]));
        items.forEach((i) => { i.duration = dur.get(i.id) || ''; });
      }
    } catch {}
  }
  return { items };
}

ipcMain.handle('app:edition', () => EDITION);

// 모양 바꾸기: 접힌 위젯의 중심은 그대로 두고 크기만 바꿈
ipcMain.handle('skin:get', () => skinName);
ipcMain.handle('skin:set', (_e, name) => {
  if (!SKINS[name] || name === skinName) return skinName;
  const d = getDock();
  const cx = d.x + COLLAPSED.w / 2;
  const cy = d.y + COLLAPSED.h / 2;
  skinName = name;
  saveSettings({ skin: name });
  setDock({ x: cx - COLLAPSED.w / 2, y: cy - COLLAPSED.h / 2 });
  if (!expanded) applyBounds(collapsedBounds());
  return skinName;
});
ipcMain.handle('yt:hasKey', () => !!settings().apiKey);
ipcMain.handle('yt:setKey', async (_e, key) => {
  key = String(key || '').trim();
  if (!/^[\w-]{30,60}$/.test(key)) return { ok: false, error: 'format' };
  try {
    const r = await ytSearch('music', key, 1);
    if (r.error) return { ok: false, error: r.error };
  } catch {
    return { ok: false, error: 'network' };
  }
  saveSettings({ apiKey: key });
  return { ok: true };
});
ipcMain.handle('yt:search', async (_e, q) => {
  if (!EDITION.search) return { error: 'disabled' };
  const key = settings().apiKey;
  if (!key) return { error: 'nokey' };
  q = String(q || '').trim().slice(0, 200);
  if (!q) return { items: [] };
  try { return await ytSearch(q, key); } catch { return { error: 'network' }; }
});

// ---------- 트레이 ----------
const sendMedia = (action) => win?.webContents.send('media', action);

function buildTrayMenu() {
  const s = settings();
  return Menu.buildFromTemplate([
    { label: expanded ? '접기' : '펼치기', click: () => { win.show(); win.webContents.send('toggle'); } },
    { type: 'separator' },
    { label: '재생 / 일시정지', click: () => sendMedia('playPause') },
    { label: '다음 곡', click: () => sendMedia('next') },
    { label: '이전 곡', click: () => sendMedia('prev') },
    { type: 'separator' },
    {
      label: '항상 위에 표시',
      type: 'checkbox',
      checked: s.alwaysOnTop !== false,
      click: (item) => { saveSettings({ alwaysOnTop: item.checked }); win.setAlwaysOnTop(item.checked); },
    },
    {
      label: 'Windows 시작 시 자동 실행',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    EDITION.search && {
      label: '검색용 API 키 지우기',
      enabled: !!s.apiKey,
      click: () => saveSettings({ apiKey: null }),
    },
    {
      label: '카세트 위치 초기화',
      click: () => {
        dock = null;
        saveSettings({ dock: null });
        if (!expanded) applyBounds(collapsedBounds());
      },
    },
    { type: 'separator' },
    EDITION.updates && (updateReady
      ? { label: `새 버전 ${updateReady} 적용하고 다시 시작`, click: () => { isQuitting = true; app.relaunch(); app.exit(0); } }
      : { label: '업데이트 확인', click: () => checkForUpdate() }),
    { label: `버전 ${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ].filter(Boolean));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('TuneDeck');
  tray.setContextMenu(buildTrayMenu());
  tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));
  tray.on('click', () => { win.show(); win.webContents.send('toggle'); });
}

ipcMain.on('now-playing', (_e, title) => {
  tray?.setToolTip(title ? `${title} — TuneDeck` : 'TuneDeck');
});

// ---------- 시작 ----------
app.whenReady().then(async () => {
  app.setAppUserModelId('com.tunedeck.app');
  Menu.setApplicationMenu(null);
  if (SKINS[settings().skin]) skinName = settings().skin;
  await startServer();

  // 음량 막대용: PC에서 나오는 소리(루프백)만 앱 화면에 넘겨줌. 녹음·전송하지 않음.
  // TuneDeck 자체 화면에서 요청할 때만 허용하고, YouTube 플레이어 등 다른 곳의 요청은 거절.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const origin = String(request.securityOrigin || request.frame?.url || '');
    if (!origin.startsWith(appOrigin())) return callback({});
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources.length) return callback({});
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  });
  createWindow();
  createTray();

  globalShortcut.register('Control+Alt+P', () => sendMedia('playPause'));
  globalShortcut.register('Control+Alt+Right', () => sendMedia('next'));
  globalShortcut.register('Control+Alt+Left', () => sendMedia('prev'));

  // 시작 8초 뒤, 그리고 3시간마다 새 버전 확인
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 3 * 60 * 60 * 1000);

  // 해상도나 모니터 구성이 바뀌면 다시 가장자리에 붙이기
  const refit = () => {
    if (dock) dock = clampDock(dock);
    applyBounds(expanded ? expandedBounds().bounds : collapsedBounds());
  };
  screen.on('display-metrics-changed', refit);
  screen.on('display-removed', refit);
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); server?.close(); });
app.on('window-all-closed', () => app.quit());
