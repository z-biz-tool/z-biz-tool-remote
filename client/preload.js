const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteControl', {
  createSession: () => ipcRenderer.send('create-session'),
  joinSession: (sessionId, sessionToken) => ipcRenderer.send('join-session', { sessionId, sessionToken }),
  sendControlRequest: (targetId) => ipcRenderer.send('send-control-request', targetId),
  sendInputEvent: (event) => ipcRenderer.send('send-input-event', event),
  sendClipboard: (text) => ipcRenderer.send('send-clipboard', text),
  sendFile: (filePath, targetId) => ipcRenderer.send('send-file', { filePath, targetId }),
  getOnlineDevices: () => ipcRenderer.send('get-online-devices'),
  setFrameQuality: (quality) => ipcRenderer.send('set-frame-quality', quality),
  setFps: (fps) => ipcRenderer.send('set-fps', fps),
  closeControlWindow: () => ipcRenderer.send('close-control-window'),
  
  getSettings: () => new Promise(resolve => ipcRenderer.once('settings', (event, data) => resolve(data))),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  getHistory: () => new Promise(resolve => ipcRenderer.once('history', (event, data) => resolve(data))),
  clearHistory: () => ipcRenderer.send('clear-history'),
  deleteDeviceHistory: (deviceId) => ipcRenderer.send('delete-device-history', deviceId),
  
  getSecurity: () => new Promise(resolve => ipcRenderer.once('security', (event, data) => resolve(data))),
  saveSecurity: (security) => ipcRenderer.send('save-security', security),
  addTrustedDevice: (deviceId) => ipcRenderer.send('add-trusted-device', deviceId),
  removeTrustedDevice: (deviceId) => ipcRenderer.send('remove-trusted-device', deviceId),
  
  getLanguage: () => new Promise(resolve => ipcRenderer.once('language', (event, data) => resolve(data))),
  setLanguage: (lang) => ipcRenderer.send('set-language', lang),
  getTranslations: () => new Promise(resolve => ipcRenderer.once('translations', (event, data) => resolve(data))),
  
  onRegistered: (callback) => ipcRenderer.on('registered', (event, data) => callback(data)),
  onSessionCreated: (callback) => ipcRenderer.on('session-created', (event, data) => callback(data)),
  onJoinedSession: (callback) => ipcRenderer.on('joined-session', (event, data) => callback(data)),
  onJoinFailed: (callback) => ipcRenderer.on('join-failed', (event, message) => callback(message)),
  onClientJoined: (callback) => ipcRenderer.on('client-joined', (event, data) => callback(data)),
  onClientLeft: (callback) => ipcRenderer.on('client-left', (event, data) => callback(data)),
  onSessionClosed: (callback) => ipcRenderer.on('session-closed', (event, message) => callback(message)),
  onControlAccepted: (callback) => ipcRenderer.on('control-accepted', (event, data) => callback(data)),
  onControlRejected: (callback) => ipcRenderer.on('control-rejected', (event, message) => callback(message)),
  onControlFailed: (callback) => ipcRenderer.on('control-failed', (event, message) => callback(message)),
  onScreenFrame: (callback) => ipcRenderer.on('screen-frame', (event, data) => callback(data)),
  onClipboardReceived: (callback) => ipcRenderer.on('clipboard-received', (event, data) => callback(data)),
  onOnlineDevices: (callback) => ipcRenderer.on('online-devices', (event, data) => callback(data)),
  onServerDisconnected: (callback) => ipcRenderer.on('server-disconnected', () => callback())
});