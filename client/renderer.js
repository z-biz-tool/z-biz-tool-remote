let currentDeviceId = null;
let currentSessionId = null;
let currentSessionToken = null;
let isInControlMode = false;
let currentLang = 'zh';

const translations = {
    zh: {
        app: { title: '远程协同', subtitle: '安全、高效的远程控制工具' },
        status: { online: '在线', offline: '离线', connecting: '连接中...' },
        device: { id: '设备 ID', copy: '复制', copied: '已复制!' },
        actions: { createSession: '创建会话', refreshDevices: '刷新设备', joinSession: '加入会话', closeControl: '关闭', syncClipboard: '同步剪贴板', sendFile: '发送文件', connect: '连接', disconnect: '断开连接', delete: '删除', clearHistory: '清空历史' },
        session: { title: '会话', id: '会话 ID', token: '会话令牌', info: '会话信息', noActive: '无活动会话', sessionCreated: '会话已创建', sessionJoined: '已加入会话', sessionClosed: '会话已关闭', host: '主机', clients: '客户端', startTime: '开始时间' },
        devices: { title: '在线设备', noDevices: '未找到设备', name: '设备名称', status: '状态', lastSeen: '最后在线' },
        settings: { title: '设置', frameQuality: '画面质量', fps: '帧率', language: '语言', theme: '主题', autoConnect: '自动连接', saveHistory: '保存历史记录', security: '安全设置', encryption: '启用加密' },
        control: { title: '远程视图', waiting: '等待屏幕数据...', viewOnly: '仅查看', fullControl: '完全控制' },
        history: { title: '历史记录', recentDevices: '设备', recentSessions: '会话', noHistory: '暂无历史记录', date: '日期', duration: '持续时间', type: '类型' },
        security: { title: '安全设置', accessControl: '访问控制', allowControl: '允许控制', allowFileTransfer: '允许文件传输', allowClipboard: '允许剪贴板同步', trustedDevices: '信任设备' },
        notification: { controlRequest: '设备 {id} 请求控制您的电脑', accept: '接受', reject: '拒绝', connected: '已连接到 {name}', disconnected: '已断开连接', error: '错误', success: '成功', warning: '警告' },
        common: { ok: '确定', cancel: '取消', yes: '是', no: '否', save: '保存', apply: '应用', reset: '重置', search: '搜索', filter: '筛选', sort: '排序', show: '显示', hide: '隐藏' },
        errors: { connectionFailed: '连接失败', sessionNotFound: '会话不存在', invalidToken: '无效令牌', deviceOffline: '设备离线', controlFailed: '控制失败', fileTransferFailed: '文件传输失败', networkError: '网络错误', permissionDenied: '权限被拒绝' }
    },
    en: {
        app: { title: 'Remote Control', subtitle: 'Secure and efficient remote control tool' },
        status: { online: 'Online', offline: 'Offline', connecting: 'Connecting...' },
        device: { id: 'Device ID', copy: 'Copy', copied: 'Copied!' },
        actions: { createSession: 'Create Session', refreshDevices: 'Refresh Devices', joinSession: 'Join Session', closeControl: 'Close', syncClipboard: 'Sync Clipboard', sendFile: 'Send File', connect: 'Connect', disconnect: 'Disconnect', delete: 'Delete', clearHistory: 'Clear History' },
        session: { title: 'Session', id: 'Session ID', token: 'Session Token', info: 'Session Info', noActive: 'No active session', sessionCreated: 'Session created', sessionJoined: 'Joined session', sessionClosed: 'Session closed', host: 'Host', clients: 'Clients', startTime: 'Start Time' },
        devices: { title: 'Online Devices', noDevices: 'No devices found', name: 'Device Name', status: 'Status', lastSeen: 'Last Seen' },
        settings: { title: 'Settings', frameQuality: 'Frame Quality', fps: 'FPS', language: 'Language', theme: 'Theme', autoConnect: 'Auto Connect', saveHistory: 'Save History', security: 'Security', encryption: 'Enable Encryption' },
        control: { title: 'Remote View', waiting: 'Waiting for screen data...', viewOnly: 'View Only', fullControl: 'Full Control' },
        history: { title: 'History', recentDevices: 'Devices', recentSessions: 'Sessions', noHistory: 'No history', date: 'Date', duration: 'Duration', type: 'Type' },
        security: { title: 'Security', accessControl: 'Access Control', allowControl: 'Allow Control', allowFileTransfer: 'Allow File Transfer', allowClipboard: 'Allow Clipboard', trustedDevices: 'Trusted Devices' },
        notification: { controlRequest: 'Device {id} requests to control your computer', accept: 'Accept', reject: 'Reject', connected: 'Connected to {name}', disconnected: 'Disconnected', error: 'Error', success: 'Success', warning: 'Warning' },
        common: { ok: 'OK', cancel: 'Cancel', yes: 'Yes', no: 'No', save: 'Save', apply: 'Apply', reset: 'Reset', search: 'Search', filter: 'Filter', sort: 'Sort', show: 'Show', hide: 'Hide' },
        errors: { connectionFailed: 'Connection failed', sessionNotFound: 'Session not found', invalidToken: 'Invalid token', deviceOffline: 'Device offline', controlFailed: 'Control failed', fileTransferFailed: 'File transfer failed', networkError: 'Network error', permissionDenied: 'Permission denied' }
    }
};

function t(key) {
    const keys = key.split('.');
    let value = translations[currentLang];
    for (const k of keys) {
        if (value && typeof value === 'object') {
            value = value[k];
        } else {
            value = key;
            break;
        }
    }
    return value || key;
}

function init() {
    loadSettings();
    loadHistory();
    loadSecurity();
    setupEventListeners();
    setupServerListeners();
    updateUI();
}

function updateUI() {
    document.getElementById('app-title').textContent = t('app.title');
    document.getElementById('app-subtitle').textContent = t('app.subtitle');
    document.getElementById('label-device-id').textContent = t('device.id');
    document.getElementById('copy-device-id').textContent = t('device.copy');
    document.getElementById('label-quick-actions').textContent = t('actions.createSession');
    document.getElementById('create-session').textContent = t('actions.createSession');
    document.getElementById('get-devices').textContent = t('actions.refreshDevices');
    document.getElementById('label-join-session').textContent = t('session.title');
    document.getElementById('label-session-id').textContent = t('session.id');
    document.getElementById('session-id').placeholder = t('session.id');
    document.getElementById('label-session-token').textContent = t('session.token');
    document.getElementById('session-token').placeholder = t('session.token');
    document.getElementById('join-session').textContent = t('actions.joinSession');
    document.getElementById('label-online-devices').textContent = t('devices.title');
    document.getElementById('label-history').textContent = t('history.title');
    document.getElementById('tab-devices').textContent = t('history.recentDevices');
    document.getElementById('tab-sessions').textContent = t('history.recentSessions');
    document.getElementById('clear-history').textContent = t('actions.clearHistory');
    document.getElementById('label-session-info').textContent = t('session.info');
    document.getElementById('label-settings').textContent = t('settings.title');
    document.getElementById('label-frame-quality').textContent = t('settings.frameQuality');
    document.getElementById('label-fps').textContent = t('settings.fps');
    document.getElementById('label-auto-connect').textContent = t('settings.autoConnect');
    document.getElementById('label-save-history').textContent = t('settings.saveHistory');
    document.getElementById('label-security').textContent = t('security.title');
    document.getElementById('label-require-permission').textContent = t('security.allowControl');
    document.getElementById('label-allow-file-transfer').textContent = t('security.allowFileTransfer');
    document.getElementById('label-allow-clipboard').textContent = t('security.allowClipboard');
    document.getElementById('label-trusted-devices').textContent = t('security.trustedDevices');
    document.getElementById('control-title').textContent = t('control.title');
    document.getElementById('close-control').textContent = t('actions.closeControl');
    document.getElementById('send-clipboard').textContent = t('actions.syncClipboard');
    document.getElementById('send-file').textContent = t('actions.sendFile');
    document.getElementById('screen-placeholder').querySelector('p').textContent = t('control.waiting');
}

async function loadSettings() {
    try {
        const settings = await window.remoteControl.getSettings();
        currentLang = settings.language || 'zh';
        document.getElementById('language-select').value = currentLang;
        
        document.getElementById('frame-quality').value = settings.frameQuality || 80;
        document.getElementById('quality-value').textContent = settings.frameQuality || 80;
        
        document.getElementById('fps').value = settings.fps || 15;
        document.getElementById('fps-value').textContent = settings.fps || 15;
        
        document.getElementById('auto-connect').checked = settings.autoConnect !== false;
        document.getElementById('save-history').checked = settings.saveHistory !== false;
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

async function loadHistory() {
    try {
        const history = await window.remoteControl.getHistory();
        renderHistoryDevices(history.devices || []);
        renderHistorySessions(history.sessions || []);
    } catch (e) {
        console.error('Failed to load history:', e);
    }
}

async function loadSecurity() {
    try {
        const security = await window.remoteControl.getSecurity();
        document.getElementById('require-permission').checked = security.requirePermission !== false;
        document.getElementById('allow-file-transfer').checked = security.allowFileTransfer !== false;
        document.getElementById('allow-clipboard').checked = security.allowClipboardSync !== false;
        renderTrustedDevices(security.trustedDevices || []);
    } catch (e) {
        console.error('Failed to load security:', e);
    }
}

function renderHistoryDevices(devices) {
    const container = document.getElementById('history-devices');
    if (devices.length === 0) {
        container.innerHTML = `<p>${t('history.noHistory')}</p>`;
        return;
    }
    
    container.innerHTML = devices.map(device => `
        <div class="history-item">
            <div class="history-info">
                <span class="history-name">${device.name || device.id}</span>
                <span class="history-date">${formatDate(device.lastConnected)}</span>
            </div>
            <div class="history-actions">
                <button class="btn btn-primary btn-sm connect-history-btn" data-device="${device.id}">${t('actions.connect')}</button>
                <button class="btn btn-danger btn-sm delete-history-btn" data-device="${device.id}">${t('actions.delete')}</button>
            </div>
        </div>
    `).join('');
    
    document.querySelectorAll('.connect-history-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.remoteControl.sendControlRequest(btn.dataset.device);
        });
    });
    
    document.querySelectorAll('.delete-history-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.remoteControl.deleteDeviceHistory(btn.dataset.device);
            loadHistory();
        });
    });
}

function renderHistorySessions(sessions) {
    const container = document.getElementById('history-sessions');
    if (sessions.length === 0) {
        container.innerHTML = `<p>${t('history.noHistory')}</p>`;
        return;
    }
    
    container.innerHTML = sessions.map(session => `
        <div class="history-item">
            <div class="history-info">
                <span class="history-name">${session.sessionId}</span>
                <span class="history-type">${session.role === 'host' ? t('session.host') : t('session.clients')}</span>
            </div>
            <div class="history-actions">
                <span class="history-date">${formatDate(session.timestamp)}</span>
            </div>
        </div>
    `).join('');
}

function renderTrustedDevices(devices) {
    const container = document.getElementById('trusted-list');
    if (devices.length === 0) {
        container.innerHTML = `<p>${t('history.noHistory')}</p>`;
        return;
    }
    
    container.innerHTML = devices.map(deviceId => `
        <div class="trusted-item">
            <span>${deviceId}</span>
            <button class="btn btn-danger btn-sm remove-trusted-btn" data-device="${deviceId}">${t('actions.delete')}</button>
        </div>
    `).join('');
    
    document.querySelectorAll('.remove-trusted-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            window.remoteControl.removeTrustedDevice(btn.dataset.device);
            loadSecurity();
        });
    });
}

function formatDate(timestamp) {
    if (!timestamp) return '-';
    const date = new Date(timestamp);
    return date.toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US');
}

function setupEventListeners() {
    document.getElementById('language-select').addEventListener('change', (e) => {
        currentLang = e.target.value;
        window.remoteControl.setLanguage(currentLang);
        updateUI();
    });

    document.getElementById('create-session').addEventListener('click', () => {
        window.remoteControl.createSession();
    });

    document.getElementById('join-session').addEventListener('click', () => {
        const sessionId = document.getElementById('session-id').value.trim();
        const sessionToken = document.getElementById('session-token').value.trim();
        
        if (sessionId && sessionToken) {
            window.remoteControl.joinSession(sessionId, sessionToken);
        } else {
            alert(t('errors.sessionNotFound'));
        }
    });

    document.getElementById('get-devices').addEventListener('click', () => {
        window.remoteControl.getOnlineDevices();
    });

    document.getElementById('copy-device-id').addEventListener('click', () => {
        if (currentDeviceId) {
            navigator.clipboard.writeText(currentDeviceId).then(() => {
                alert(t('device.copied'));
            });
        }
    });

    document.getElementById('frame-quality').addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById('quality-value').textContent = value;
        window.remoteControl.setFrameQuality(parseInt(value));
    });

    document.getElementById('fps').addEventListener('input', (e) => {
        const value = e.target.value;
        document.getElementById('fps-value').textContent = value;
        window.remoteControl.setFps(parseInt(value));
    });

    document.getElementById('auto-connect').addEventListener('change', (e) => {
        window.remoteControl.saveSettings({ autoConnect: e.target.checked });
    });

    document.getElementById('save-history').addEventListener('change', (e) => {
        window.remoteControl.saveSettings({ saveHistory: e.target.checked });
    });

    document.getElementById('require-permission').addEventListener('change', (e) => {
        window.remoteControl.saveSecurity({ requirePermission: e.target.checked });
    });

    document.getElementById('allow-file-transfer').addEventListener('change', (e) => {
        window.remoteControl.saveSecurity({ allowFileTransfer: e.target.checked });
    });

    document.getElementById('allow-clipboard').addEventListener('change', (e) => {
        window.remoteControl.saveSecurity({ allowClipboardSync: e.target.checked });
    });

    document.getElementById('clear-history').addEventListener('click', () => {
        if (confirm(t('common.yes'))) {
            window.remoteControl.clearHistory();
            loadHistory();
        }
    });

    document.getElementById('tab-devices').addEventListener('click', () => {
        document.getElementById('tab-devices').classList.add('active');
        document.getElementById('tab-sessions').classList.remove('active');
        document.getElementById('history-devices').classList.remove('hidden');
        document.getElementById('history-sessions').classList.add('hidden');
    });

    document.getElementById('tab-sessions').addEventListener('click', () => {
        document.getElementById('tab-sessions').classList.add('active');
        document.getElementById('tab-devices').classList.remove('active');
        document.getElementById('history-sessions').classList.remove('hidden');
        document.getElementById('history-devices').classList.add('hidden');
    });

    document.getElementById('close-control').addEventListener('click', () => {
        window.remoteControl.closeControlWindow();
    });

    document.getElementById('send-clipboard').addEventListener('click', () => {
        navigator.clipboard.readText().then((text) => {
            window.remoteControl.sendClipboard(text);
            alert(t('notification.success'));
        });
    });

    document.getElementById('send-file').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            window.remoteControl.sendFile(file.path, currentSessionId);
            alert(`${t('actions.sendFile')} ${file.name}...`);
            e.target.value = '';
        }
    });

    setupCanvasEvents();
}

function setupServerListeners() {
    window.remoteControl.onRegistered((data) => {
        currentDeviceId = data.deviceId;
        document.getElementById('device-id').textContent = data.deviceId;
        document.getElementById('connection-status').className = 'status online';
        document.getElementById('connection-status').textContent = t('status.online');
        window.remoteControl.getOnlineDevices();
        loadHistory();
    });

    window.remoteControl.onSessionCreated((data) => {
        currentSessionId = data.sessionId;
        currentSessionToken = data.sessionToken;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = `
            <p><strong>${t('session.id')}:</strong> <span class="highlight">${data.sessionId}</span></p>
            <p><strong>${t('session.token')}:</strong> <span class="highlight">${data.sessionToken}</span></p>
            <p><strong>${t('device.id')}:</strong> <span class="highlight">${data.deviceId}</span></p>
            <p><strong>${t('session.host')}:</strong> ${t('notification.connected', { name: 'You' })}</p>
        `;
        
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onJoinedSession((data) => {
        currentSessionId = data.sessionId;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = `
            <p><strong>${t('session.id')}:</strong> <span class="highlight">${data.sessionId}</span></p>
            <p><strong>${t('session.host')}:</strong> <span class="highlight">${data.hostId}</span></p>
            <p><strong>${t('session.status')}:</strong> ${t('control.fullControl')}</p>
        `;
        
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onJoinFailed((message) => {
        alert(`${t('errors.sessionNotFound')}: ${message}`);
    });

    window.remoteControl.onClientJoined((data) => {
        alert(`${t('session.sessionJoined')}: ${data.clientId}`);
        window.remoteControl.addTrustedDevice(data.clientId);
        loadSecurity();
    });

    window.remoteControl.onClientLeft((data) => {
        alert(`${t('session.sessionClosed')}: ${data.clientId}`);
    });

    window.remoteControl.onSessionClosed((message) => {
        alert(`${t('session.sessionClosed')}: ${message}`);
        document.getElementById('main-panel').classList.remove('hidden');
        document.getElementById('control-panel').classList.add('hidden');
        isInControlMode = false;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = `<p>${t('session.noActive')}</p>`;
    });

    window.remoteControl.onControlAccepted((data) => {
        alert(`${t('control.controlAccepted')}: ${data.targetId}`);
        window.remoteControl.addTrustedDevice(data.targetId);
        loadSecurity();
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onControlRejected((message) => {
        alert(`${t('control.controlRejected')}: ${message}`);
    });

    window.remoteControl.onControlFailed((message) => {
        alert(`${t('errors.controlFailed')}: ${message}`);
    });

    window.remoteControl.onScreenFrame((data) => {
        renderFrame(data.frame);
    });

    window.remoteControl.onClipboardReceived((data) => {
        alert(`${t('notification.success')}: ${data.substring(0, 50)}...`);
    });

    window.remoteControl.onOnlineDevices((data) => {
        const devicesList = document.getElementById('devices-list');
        
        if (data.devices && data.devices.length > 0) {
            devicesList.innerHTML = data.devices
                .filter(id => id !== currentDeviceId)
                .map(id => `
                    <div class="device-item">
                        <span class="device-name">${id}</span>
                        <button class="btn btn-primary connect-btn" data-device="${id}">${t('actions.connect')}</button>
                    </div>
                `)
                .join('');
            
            document.querySelectorAll('.connect-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetId = btn.dataset.device;
                    window.remoteControl.sendControlRequest(targetId);
                });
            });
        } else {
            devicesList.innerHTML = `<p>${t('devices.noDevices')}</p>`;
        }
    });

    window.remoteControl.onServerDisconnected(() => {
        document.getElementById('connection-status').className = 'status offline';
        document.getElementById('connection-status').textContent = t('status.connecting');
    });
}

function setupCanvasEvents() {
    const canvas = document.getElementById('screen-canvas');
    const container = document.querySelector('.screen-container');
    
    canvas.addEventListener('mousemove', (e) => {
        if (!isInControlMode) return;
        
        const rect = container.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 1920;
        const y = ((e.clientY - rect.top) / rect.height) * 1080;
        
        window.remoteControl.sendInputEvent({
            type: 'mouse-move',
            x: Math.round(x),
            y: Math.round(y)
        });
    });

    canvas.addEventListener('mousedown', (e) => {
        if (!isInControlMode) return;
        
        const rect = container.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 1920;
        const y = ((e.clientY - rect.top) / rect.height) * 1080;
        
        let button = 'left';
        if (e.button === 1) button = 'middle';
        if (e.button === 2) button = 'right';
        
        window.remoteControl.sendInputEvent({
            type: 'mouse-down',
            x: Math.round(x),
            y: Math.round(y),
            button: button
        });
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!isInControlMode) return;
        
        const rect = container.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 1920;
        const y = ((e.clientY - rect.top) / rect.height) * 1080;
        
        let button = 'left';
        if (e.button === 1) button = 'middle';
        if (e.button === 2) button = 'right';
        
        window.remoteControl.sendInputEvent({
            type: 'mouse-up',
            x: Math.round(x),
            y: Math.round(y),
            button: button
        });
    });

    canvas.addEventListener('wheel', (e) => {
        if (!isInControlMode) return;
        
        e.preventDefault();
        window.remoteControl.sendInputEvent({
            type: 'mouse-wheel',
            deltaX: e.deltaX,
            deltaY: e.deltaY
        });
    });

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    window.addEventListener('keydown', (e) => {
        if (!isInControlMode) return;
        
        const keyMap = {
            ' ': 'space', 'Enter': 'enter', 'Tab': 'tab', 'Shift': 'shift',
            'Control': 'ctrl', 'Alt': 'alt', 'Meta': 'meta', 'Backspace': 'backspace',
            'Delete': 'delete', 'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left',
            'ArrowRight': 'right', 'Home': 'home', 'End': 'end', 'PageUp': 'pageup',
            'PageDown': 'pagedown', 'Escape': 'escape',
            'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4', 'F5': 'f5',
            'F6': 'f6', 'F7': 'f7', 'F8': 'f8', 'F9': 'f9', 'F10': 'f10',
            'F11': 'f11', 'F12': 'f12'
        };
        
        const key = keyMap[e.key] || e.key.toLowerCase();
        
        window.remoteControl.sendInputEvent({
            type: 'key-down',
            key: key
        });
    });

    window.addEventListener('keyup', (e) => {
        if (!isInControlMode) return;
        
        const keyMap = {
            ' ': 'space', 'Enter': 'enter', 'Tab': 'tab', 'Shift': 'shift',
            'Control': 'ctrl', 'Alt': 'alt', 'Meta': 'meta', 'Backspace': 'backspace',
            'Delete': 'delete', 'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left',
            'ArrowRight': 'right', 'Home': 'home', 'End': 'end', 'PageUp': 'pageup',
            'PageDown': 'pagedown', 'Escape': 'escape',
            'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4', 'F5': 'f5',
            'F6': 'f6', 'F7': 'f7', 'F8': 'f8', 'F9': 'f9', 'F10': 'f10',
            'F11': 'f11', 'F12': 'f12'
        };
        
        const key = keyMap[e.key] || e.key.toLowerCase();
        
        window.remoteControl.sendInputEvent({
            type: 'key-up',
            key: key
        });
    });
}

function renderFrame(base64Frame) {
    const canvas = document.getElementById('screen-canvas');
    const placeholder = document.getElementById('screen-placeholder');
    const ctx = canvas.getContext('2d');
    
    placeholder.style.display = 'none';
    
    const img = new Image();
    img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/png;base64,${base64Frame}`;
}

document.addEventListener('DOMContentLoaded', init);