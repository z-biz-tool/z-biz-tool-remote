const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENCRYPTION_KEY = Buffer.from('remote-control-storage-key-32bytes', 'utf-8').slice(0, 32);

class StorageManager {
  constructor() {
    this.storageDir = path.join(require('electron').app ? require('electron').app.getPath('temp') : process.cwd(), 'RemoteControl');
    this.ensureDir();
    this.loadData();
  }

  ensureDir() {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  encrypt(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf-8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { iv: iv.toString('hex'), encryptedData: encrypted, authTag };
  }

  decrypt(encryptedData) {
    try {
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const authTag = Buffer.from(encryptedData.authTag, 'hex');
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedData.encryptedData, 'hex', 'utf-8');
      decrypted += decipher.final('utf-8');
      return JSON.parse(decrypted);
    } catch {
      return null;
    }
  }

  loadData() {
    try {
      const devicePath = path.join(this.storageDir, 'device.json');
      if (fs.existsSync(devicePath)) {
        const content = fs.readFileSync(devicePath, 'utf-8');
        this.deviceData = JSON.parse(content);
      } else {
        this.deviceData = {};
      }

      const historyPath = path.join(this.storageDir, 'history.json');
      if (fs.existsSync(historyPath)) {
        const content = fs.readFileSync(historyPath, 'utf-8');
        const encrypted = JSON.parse(content);
        this.historyData = this.decrypt(encrypted) || { devices: [], sessions: [] };
      } else {
        this.historyData = { devices: [], sessions: [] };
      }

      const settingsPath = path.join(this.storageDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        this.settingsData = JSON.parse(content);
      } else {
        this.settingsData = this.getDefaultSettings();
      }

      const securityPath = path.join(this.storageDir, 'security.json');
      if (fs.existsSync(securityPath)) {
        const content = fs.readFileSync(securityPath, 'utf-8');
        const encrypted = JSON.parse(content);
        this.securityData = this.decrypt(encrypted) || this.getDefaultSecurity();
      } else {
        this.securityData = this.getDefaultSecurity();
      }
    } catch (error) {
      console.error('Failed to load storage:', error);
      this.deviceData = {};
      this.historyData = { devices: [], sessions: [] };
      this.settingsData = this.getDefaultSettings();
      this.securityData = this.getDefaultSecurity();
    }
  }

  getDefaultSettings() {
    return {
      language: 'zh',
      theme: 'dark',
      frameQuality: 80,
      fps: 15,
      autoConnect: true,
      saveHistory: true,
      showNotifications: true,
      autoReconnect: true,
      reconnectInterval: 3000,
      screenshotInterval: 1000
    };
  }

  getDefaultSecurity() {
    return {
      encryptionEnabled: true,
      requirePermission: true,
      allowFileTransfer: true,
      allowClipboardSync: true,
      sessionRecording: false,
      ipWhitelist: [],
      trustedDevices: [],
      accessLog: []
    };
  }

  saveDeviceId(deviceId) {
    this.deviceData.deviceId = deviceId;
    fs.writeFileSync(path.join(this.storageDir, 'device.json'), JSON.stringify(this.deviceData, null, 2));
  }

  getDeviceId() {
    return this.deviceData.deviceId || null;
  }

  addDeviceToHistory(device) {
    if (!this.settingsData.saveHistory) return;
    
    const existingIndex = this.historyData.devices.findIndex(d => d.id === device.id);
    if (existingIndex !== -1) {
      this.historyData.devices.splice(existingIndex, 1);
    }
    
    this.historyData.devices.unshift({
      ...device,
      lastConnected: Date.now(),
      connectionCount: (existingIndex !== -1 ? this.historyData.devices[existingIndex].connectionCount : 0) + 1
    });

    if (this.historyData.devices.length > 50) {
      this.historyData.devices = this.historyData.devices.slice(0, 50);
    }

    this.saveHistory();
  }

  addSessionToHistory(session) {
    if (!this.settingsData.saveHistory) return;
    
    this.historyData.sessions.unshift({
      ...session,
      timestamp: Date.now()
    });

    if (this.historyData.sessions.length > 100) {
      this.historyData.sessions = this.historyData.sessions.slice(0, 100);
    }

    this.saveHistory();
  }

  saveHistory() {
    const encrypted = this.encrypt(this.historyData);
    fs.writeFileSync(path.join(this.storageDir, 'history.json'), JSON.stringify(encrypted, null, 2));
  }

  getHistory() {
    return this.historyData;
  }

  clearHistory() {
    this.historyData = { devices: [], sessions: [] };
    this.saveHistory();
  }

  deleteDeviceFromHistory(deviceId) {
    this.historyData.devices = this.historyData.devices.filter(d => d.id !== deviceId);
    this.saveHistory();
  }

  saveSettings(settings) {
    this.settingsData = { ...this.settingsData, ...settings };
    fs.writeFileSync(path.join(this.storageDir, 'settings.json'), JSON.stringify(this.settingsData, null, 2));
  }

  getSettings() {
    return this.settingsData;
  }

  saveSecurity(security) {
    this.securityData = { ...this.securityData, ...security };
    const encrypted = this.encrypt(this.securityData);
    fs.writeFileSync(path.join(this.storageDir, 'security.json'), JSON.stringify(encrypted, null, 2));
  }

  getSecurity() {
    return this.securityData;
  }

  addAccessLog(entry) {
    this.securityData.accessLog.unshift({
      ...entry,
      timestamp: Date.now()
    });
    
    if (this.securityData.accessLog.length > 1000) {
      this.securityData.accessLog = this.securityData.accessLog.slice(0, 1000);
    }
    
    this.saveSecurity();
  }

  addTrustedDevice(deviceId) {
    if (!this.securityData.trustedDevices.includes(deviceId)) {
      this.securityData.trustedDevices.push(deviceId);
      this.saveSecurity();
    }
  }

  removeTrustedDevice(deviceId) {
    this.securityData.trustedDevices = this.securityData.trustedDevices.filter(d => d !== deviceId);
    this.saveSecurity();
  }

  isTrustedDevice(deviceId) {
    return this.securityData.trustedDevices.includes(deviceId);
  }
}

module.exports = new StorageManager();