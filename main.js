// TuneDeck — 화면 가장자리에 붙는 LP 위젯형 YouTube 플레이어
const {
  app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut,
  ipcMain, screen, net, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const updater = require('./updater');

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
let updateReady = null;

// 접힌 창: LP(지름 200)의 왼쪽 절반만 보이도록 폭 112 (그림자 여백 12)
const COLLAPSED = { w: 112, h: 212, lpTop: 6 };
const EXPANDED_W = 400;
const EXPANDED_MAX_H = 920;

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

function currentArea() {
  const ref = win ? win.getBounds() : screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint({ x: ref.x, y: ref.y }).workArea;
}

function collapsedBounds() {
  const wa = currentArea();
  const savedY = settings().dockY;
  const y = clamp(savedY ?? Math.round(wa.y + wa.height * 0.38), wa.y, wa.y + wa.height - COLLAPSED.h);
  return { x: wa.x + wa.width - COLLAPSED.w, y, width: COLLAPSED.w, height: COLLAPSED.h };
}

function expandedBounds() {
  const wa = currentArea();
  const col = collapsedBounds();
  const height = Math.min(wa.height - 40, EXPANDED_MAX_H);
  const y = clamp(col.y - 22, wa.y + 20, wa.y + wa.height - height - 20);
  return {
    bounds: { x: wa.x + wa.width - EXPANDED_W, y, width: EXPANDED_W, height },
    // 펼친 창 안에서 LP가 처음 있어야 할 위치 (접힌 상태와 같은 화면 위치)
    lpStartTop: col.y - y + COLLAPSED.lpTop,
  };
}

function applyBounds(b) {
  if (!win) return;
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
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

ipcMain.handle('win:prepareExpand', () => expandedBounds().lpStartTop);
ipcMain.handle('win:expand', () => {
  applyBounds(expandedBounds().bounds);
  expanded = true;
  win.focus();
});
ipcMain.handle('win:collapse', () => {
  applyBounds(collapsedBounds());
  expanded = false;
});

ipcMain.on('dock:start', (_e, screenY) => {
  drag = { startY: screenY, startTop: win.getBounds().y };
});
ipcMain.on('dock:move', (_e, screenY) => {
  if (!drag || expanded) return;
  const wa = currentArea();
  const y = clamp(Math.round(drag.startTop + screenY - drag.startY), wa.y, wa.y + wa.height - COLLAPSED.h);
  applyBounds({ x: wa.x + wa.width - COLLAPSED.w, y, width: COLLAPSED.w, height: COLLAPSED.h });
});
ipcMain.on('dock:end', () => {
  if (!drag) return;
  drag = null;
  saveSettings({ dockY: win.getBounds().y });
});

ipcMain.on('app:quit', () => { isQuitting = true; app.quit(); });
ipcMain.on('app:applyUpdate', () => {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
});

// ---------- 자동 업데이트 ----------
async function checkForUpdate() {
  if (updateReady) return;
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
  if (/^https:\/\/(www\.|music\.)?youtube\.com\//.test(url)) shell.openExternal(url);
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
    {
      label: 'LP 위치 초기화',
      click: () => { saveSettings({ dockY: null }); if (!expanded) applyBounds(collapsedBounds()); },
    },
    { type: 'separator' },
    updateReady
      ? { label: `새 버전 ${updateReady} 적용하고 다시 시작`, click: () => { isQuitting = true; app.relaunch(); app.exit(0); } }
      : { label: '업데이트 확인', click: () => checkForUpdate() },
    { label: `버전 ${APP_VERSION}`, enabled: false },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]);
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
  await startServer();
  createWindow();
  createTray();

  globalShortcut.register('Control+Alt+P', () => sendMedia('playPause'));
  globalShortcut.register('Control+Alt+Right', () => sendMedia('next'));
  globalShortcut.register('Control+Alt+Left', () => sendMedia('prev'));

  // 시작 8초 뒤, 그리고 3시간마다 새 버전 확인
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 3 * 60 * 60 * 1000);

  // 해상도나 모니터 구성이 바뀌면 다시 가장자리에 붙이기
  screen.on('display-metrics-changed', () => {
    applyBounds(expanded ? expandedBounds().bounds : collapsedBounds());
  });
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); server?.close(); });
app.on('window-all-closed', () => app.quit());
