const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (data) => ipcRenderer.send('state:save', data),
  oembed: (id) => ipcRenderer.invoke('oembed', id),
  prepareExpand: () => ipcRenderer.invoke('win:prepareExpand'),
  expand: () => ipcRenderer.invoke('win:expand'),
  collapse: () => ipcRenderer.invoke('win:collapse'),
  dragStart: (y) => ipcRenderer.send('dock:start', y),
  dragMove: (y) => ipcRenderer.send('dock:move', y),
  dragEnd: () => ipcRenderer.send('dock:end'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  nowPlaying: (title) => ipcRenderer.send('now-playing', title),
  onMedia: (cb) => ipcRenderer.on('media', (_e, action) => cb(action)),
  onToggle: (cb) => ipcRenderer.on('toggle', () => cb()),
  quit: () => ipcRenderer.send('app:quit'),
  applyUpdate: () => ipcRenderer.send('app:applyUpdate'),
  onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, v) => cb(v)),
  onAppInfo: (cb) => ipcRenderer.on('app-info', (_e, info) => cb(info)),
});
