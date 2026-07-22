const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard, dialog, screen } = require('electron');
const path = require('path');
const WebSocket = require('ws');
const { mouse, keyboard, Button, Key, Point } = require('@nut-tree/nut-js');
const fs = require('fs');
const storage = require('./storage');
const i18n = require('./i18n');

let mainWindow;
let controlWindow;
let ws = null;
let deviceId = null;
let sessionId = null;
let sessionToken = null;
let encryptionKey = null;
let targetDeviceId = null;
let isControlling = false;
let isHosting = false;
let captureInterval = null;
let frameQuality = 80;
let fps = 15;
let appClosing = false;

const SERVER_URL = 'ws://101.37.80.51:8080';

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    title: i18n.t('app.title'),
    icon: path.join(__dirname, 'icons', 'icon.png')
  });

  mainWindow.loadFile('index.html');
}

function createControlWindow() {
  if (controlWindow) {
    controlWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  controlWindow = new BrowserWindow({
    width: Math.floor(width * 0.9),
    height: Math.floor(height * 0.9),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    },
    title: i18n.t('control.title'),
    icon: path.join(__dirname, 'icons', 'icon.png')
  });

  controlWindow.loadFile('index.html');

  controlWindow.on('closed', () => {
    controlWindow = null;
    stopScreenCapture();
    isControlling = false;
    isHosting = false;
  });
}

function connectToServer() {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    console.log('Connected to server');
    const savedDeviceId = storage.getDeviceId();
    ws.send(JSON.stringify({
      type: 'REGISTER',
      deviceId: savedDeviceId
    }));
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      handleServerMessage(data);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from server');
    if (!appClosing) {
      mainWindow?.webContents.send('server-disconnected');
      const settings = storage.getSettings();
      setTimeout(connectToServer, settings.reconnectInterval || 3000);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'REGISTER_SUCCESS': {
      deviceId = data.deviceId;
      encryptionKey = data.encryptionKey;
      storage.saveDeviceId(deviceId);
      storage.addAccessLog({
        type: 'registered',
        deviceId: deviceId,
        action: 'Device registered successfully'
      });
      mainWindow?.webContents.send('registered', { deviceId });
      break;
    }

    case 'SESSION_CREATED': {
      sessionId = data.sessionId;
      sessionToken = data.sessionToken;
      isHosting = true;
      storage.addSessionToHistory({
        sessionId: data.sessionId,
        sessionToken: data.sessionToken,
        role: 'host'
      });
      mainWindow?.webContents.send('session-created', { sessionId, sessionToken, deviceId });
      startScreenCapture();
      break;
    }

    case 'JOIN_SUCCESS': {
      sessionId = data.sessionId;
      targetDeviceId = data.hostId;
      isControlling = true;
      storage.addDeviceToHistory({
        id: data.hostId,
        name: `Device ${data.hostId}`,
        type: 'host'
      });
      storage.addSessionToHistory({
        sessionId: data.sessionId,
        role: 'client',
        targetDeviceId: data.hostId
      });
      mainWindow?.webContents.send('joined-session', { sessionId, hostId: data.hostId });
      createControlWindow();
      break;
    }

    case 'JOIN_FAILED': {
      mainWindow?.webContents.send('join-failed', data.message);
      break;
    }

    case 'CLIENT_JOINED': {
      storage.addDeviceToHistory({
        id: data.clientId,
        name: `Device ${data.clientId}`,
        type: 'client'
      });
      mainWindow?.webContents.send('client-joined', { clientId: data.clientId });
      break;
    }

    case 'CLIENT_LEFT': {
      mainWindow?.webContents.send('client-left', { clientId: data.clientId });
      break;
    }

    case 'SESSION_CLOSED': {
      stopScreenCapture();
      isHosting = false;
      isControlling = false;
      mainWindow?.webContents.send('session-closed', data.message);
      controlWindow?.close();
      break;
    }

    case 'CONTROL_REQUEST': {
      const security = storage.getSecurity();
      if (security.isTrustedDevice(data.fromId)) {
        ws.send(JSON.stringify({
          type: 'CONTROL_ACCEPT',
          fromId: data.fromId,
          sessionId: data.sessionId
        }));
        isHosting = true;
        startScreenCapture();
        storage.addAccessLog({
          type: 'control_request_auto_accepted',
          fromId: data.fromId,
          reason: 'Trusted device'
        });
      } else {
        dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: i18n.t('notification.controlRequest', { id: data.fromId }),
          message: `${i18n.t('notification.controlRequest', { id: data.fromId })}`,
          buttons: [i18n.t('notification.accept'), i18n.t('notification.reject')]
        }).then((result) => {
          if (result.response === 0) {
            ws.send(JSON.stringify({
              type: 'CONTROL_ACCEPT',
              fromId: data.fromId,
              sessionId: data.sessionId
            }));
            isHosting = true;
            startScreenCapture();
            storage.addAccessLog({
              type: 'control_request_accepted',
              fromId: data.fromId,
              action: 'User accepted control request'
            });
          } else {
            ws.send(JSON.stringify({
              type: 'CONTROL_REJECT',
              fromId: data.fromId,
              message: i18n.t('errors.permissionDenied')
            }));
            storage.addAccessLog({
              type: 'control_request_rejected',
              fromId: data.fromId,
              action: 'User rejected control request'
            });
          }
        });
      }
      break;
    }

    case 'CONTROL_ACCEPTED': {
      targetDeviceId = data.targetId;
      isControlling = true;
      createControlWindow();
      mainWindow?.webContents.send('control-accepted', { targetId: data.targetId });
      storage.addAccessLog({
        type: 'control_accepted',
        targetId: data.targetId,
        action: 'Successfully gained control'
      });
      break;
    }

    case 'CONTROL_REJECTED': {
      mainWindow?.webContents.send('control-rejected', data.message);
      break;
    }

    case 'CONTROL_FAILED': {
      mainWindow?.webContents.send('control-failed', data.message);
      break;
    }

    case 'SCREEN_FRAME': {
      controlWindow?.webContents.send('screen-frame', {
        frame: data.frame,
        fromId: data.fromId
      });
      break;
    }

    case 'INPUT_EVENT': {
      const security = storage.getSecurity();
      if (security.requirePermission || isHosting) {
        handleInputEvent(data.event);
      }
      break;
    }

    case 'CLIPBOARD_DATA': {
      const security = storage.getSecurity();
      if (security.allowClipboardSync) {
        clipboard.writeText(data.data);
        mainWindow?.webContents.send('clipboard-received', data.data);
      }
      break;
    }

    case 'FILE_TRANSFER': {
      const security = storage.getSecurity();
      if (security.allowFileTransfer) {
        handleFileTransfer(data);
      }
      break;
    }

    case 'ONLINE_DEVICES': {
      mainWindow?.webContents.send('online-devices', data.devices);
      break;
    }

    case 'PONG': {
      break;
    }
  }
}

async function startScreenCapture() {
  if (captureInterval) {
    clearInterval(captureInterval);
  }

  captureInterval = setInterval(async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      });

      if (sources.length > 0) {
        const source = sources[0];
        const imageData = source.thumbnail.toPNG();
        
        const base64Frame = imageData.toString('base64');
        
        if (ws && ws.readyState === WebSocket.OPEN && sessionId) {
          ws.send(JSON.stringify({
            type: 'SCREEN_FRAME',
            sessionId: sessionId,
            frame: base64Frame,
            timestamp: Date.now(),
            quality: frameQuality
          }));
        }
      }
    } catch (error) {
      console.error('Screen capture error:', error);
    }
  }, 1000 / fps);
}

function stopScreenCapture() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
}

async function handleInputEvent(event) {
  try {
    switch (event.type) {
      case 'mouse-move': {
        await mouse.move(new Point(event.x, event.y));
        break;
      }
      case 'mouse-down': {
        await mouse.pressButton(Button[event.button.toUpperCase()]);
        break;
      }
      case 'mouse-up': {
        await mouse.releaseButton(Button[event.button.toUpperCase()]);
        break;
      }
      case 'mouse-wheel': {
        await mouse.scroll(event.deltaY, event.deltaX);
        break;
      }
      case 'key-down': {
        await keyboard.pressKey(Key[event.key.toUpperCase()]);
        break;
      }
      case 'key-up': {
        await keyboard.releaseKey(Key[event.key.toUpperCase()]);
        break;
      }
    }
  } catch (error) {
    console.error('Input event error:', error);
  }
}

function handleFileTransfer(data) {
  const tempDir = app.getPath('temp');
  const filePath = path.join(tempDir, data.filename);
  
  if (data.chunkIndex === 0) {
    fs.writeFileSync(filePath, Buffer.from(data.chunk, 'base64'));
  } else {
    fs.appendFileSync(filePath, Buffer.from(data.chunk, 'base64'));
  }
  
  if (data.chunkIndex === data.totalChunks - 1) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: i18n.t('notification.success'),
      message: `${i18n.t('notification.success')}: ${filePath}`
    });
  }
}

ipcMain.on('create-session', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CREATE_SESSION' }));
  }
});

ipcMain.on('join-session', (event, { sessionId, sessionToken }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'JOIN_SESSION',
      sessionId: sessionId,
      sessionToken: sessionToken
    }));
  }
});

ipcMain.on('send-control-request', (event, targetId) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'CONTROL_REQUEST',
      targetId: targetId,
      sessionId: sessionId
    }));
  }
});

ipcMain.on('send-input-event', (event, inputEvent) => {
  if (ws && ws.readyState === WebSocket.OPEN && targetDeviceId) {
    ws.send(JSON.stringify({
      type: 'INPUT_EVENT',
      targetId: targetDeviceId,
      event: inputEvent,
      sessionId: sessionId
    }));
  }
});

ipcMain.on('send-clipboard', (event, text) => {
  if (ws && ws.readyState === WebSocket.OPEN && targetDeviceId) {
    ws.send(JSON.stringify({
      type: 'CLIPBOARD_DATA',
      targetId: targetDeviceId,
      data: text,
      sessionId: sessionId
    }));
  }
});

ipcMain.on('send-file', (event, { filePath, targetId }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const fileData = fs.readFileSync(filePath);
    const chunkSize = 1024 * 1024;
    const totalChunks = Math.ceil(fileData.length / chunkSize);
    const filename = path.basename(filePath);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileData.length);
      const chunk = fileData.slice(start, end).toString('base64');
      
      ws.send(JSON.stringify({
        type: 'FILE_TRANSFER',
        targetId: targetId,
        filename: filename,
        size: fileData.length,
        chunk: chunk,
        chunkIndex: i,
        totalChunks: totalChunks,
        sessionId: sessionId
      }));
    }
  }
});

ipcMain.on('get-online-devices', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'GET_ONLINE_DEVICES' }));
  }
});

ipcMain.on('set-frame-quality', (event, quality) => {
  frameQuality = quality;
  storage.saveSettings({ frameQuality: quality });
});

ipcMain.on('set-fps', (event, newFps) => {
  fps = newFps;
  storage.saveSettings({ fps: newFps });
  if (isHosting) {
    stopScreenCapture();
    startScreenCapture();
  }
});

ipcMain.on('close-control-window', () => {
  controlWindow?.close();
});

ipcMain.on('get-settings', (event) => {
  event.reply('settings', storage.getSettings());
});

ipcMain.on('save-settings', (event, settings) => {
  storage.saveSettings(settings);
  if (settings.language) {
    i18n.setLang(settings.language);
  }
});

ipcMain.on('get-history', (event) => {
  event.reply('history', storage.getHistory());
});

ipcMain.on('clear-history', () => {
  storage.clearHistory();
});

ipcMain.on('delete-device-history', (event, deviceId) => {
  storage.deleteDeviceFromHistory(deviceId);
});

ipcMain.on('add-trusted-device', (event, deviceId) => {
  storage.addTrustedDevice(deviceId);
});

ipcMain.on('remove-trusted-device', (event, deviceId) => {
  storage.removeTrustedDevice(deviceId);
});

ipcMain.on('get-security', (event) => {
  event.reply('security', storage.getSecurity());
});

ipcMain.on('save-security', (event, security) => {
  storage.saveSecurity(security);
});

ipcMain.on('get-language', (event) => {
  event.reply('language', i18n.getLang());
});

ipcMain.on('set-language', (event, lang) => {
  i18n.setLang(lang);
  storage.saveSettings({ language: lang });
});

ipcMain.on('get-translations', (event) => {
  event.reply('translations', {
    current: i18n.getLang(),
    available: i18n.getAvailableLanguages()
  });
});

app.commandLine.appendSwitch('--no-sandbox');
app.commandLine.appendSwitch('--disable-gpu-sandbox');

app.whenReady().then(() => {
  const settings = storage.getSettings();
  if (settings.language) {
    i18n.setLang(settings.language);
  }
  if (settings.frameQuality) {
    frameQuality = settings.frameQuality;
  }
  if (settings.fps) {
    fps = settings.fps;
  }

  createMainWindow();
  
  if (settings.autoConnect !== false) {
    connectToServer();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  appClosing = true;
  stopScreenCapture();
  if (ws) {
    ws.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});