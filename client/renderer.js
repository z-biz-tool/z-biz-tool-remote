let currentDeviceId = null;
let currentSessionId = null;
let currentSessionToken = null;
let isInControlMode = false;

function init() {
    setupEventListeners();
    setupServerListeners();
}

function setupEventListeners() {
    document.getElementById('create-session').addEventListener('click', () => {
        window.remoteControl.createSession();
    });

    document.getElementById('join-session').addEventListener('click', () => {
        const sessionId = document.getElementById('session-id').value.trim();
        const sessionToken = document.getElementById('session-token').value.trim();
        
        if (sessionId && sessionToken) {
            window.remoteControl.joinSession(sessionId, sessionToken);
        } else {
            alert('Please enter both Session ID and Session Token');
        }
    });

    document.getElementById('get-devices').addEventListener('click', () => {
        window.remoteControl.getOnlineDevices();
    });

    document.getElementById('copy-device-id').addEventListener('click', () => {
        if (currentDeviceId) {
            navigator.clipboard.writeText(currentDeviceId).then(() => {
                alert('Device ID copied to clipboard');
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

    document.getElementById('close-control').addEventListener('click', () => {
        window.remoteControl.closeControlWindow();
    });

    document.getElementById('send-clipboard').addEventListener('click', () => {
        navigator.clipboard.readText().then((text) => {
            window.remoteControl.sendClipboard(text);
            alert('Clipboard sent');
        });
    });

    document.getElementById('send-file').addEventListener('click', () => {
        document.getElementById('file-input').click();
    });

    document.getElementById('file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            window.remoteControl.sendFile(file.path, currentSessionId);
            alert(`File ${file.name} sending...`);
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
        document.getElementById('connection-status').textContent = 'Online';
        window.remoteControl.getOnlineDevices();
    });

    window.remoteControl.onSessionCreated((data) => {
        currentSessionId = data.sessionId;
        currentSessionToken = data.sessionToken;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = `
            <p><strong>Session ID:</strong> <span class="highlight">${data.sessionId}</span></p>
            <p><strong>Session Token:</strong> <span class="highlight">${data.sessionToken}</span></p>
            <p><strong>Your Device ID:</strong> <span class="highlight">${data.deviceId}</span></p>
            <p><strong>Status:</strong> Hosting - Waiting for connections...</p>
        `;
        
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onJoinedSession((data) => {
        currentSessionId = data.sessionId;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = `
            <p><strong>Session ID:</strong> <span class="highlight">${data.sessionId}</span></p>
            <p><strong>Connected to:</strong> <span class="highlight">${data.hostId}</span></p>
            <p><strong>Status:</strong> Controlling</p>
        `;
        
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onJoinFailed((message) => {
        alert(`Failed to join session: ${message}`);
    });

    window.remoteControl.onClientJoined((data) => {
        alert(`Client ${data.clientId} joined the session`);
    });

    window.remoteControl.onClientLeft((data) => {
        alert(`Client ${data.clientId} left the session`);
    });

    window.remoteControl.onSessionClosed((message) => {
        alert(`Session closed: ${message}`);
        document.getElementById('main-panel').classList.remove('hidden');
        document.getElementById('control-panel').classList.add('hidden');
        isInControlMode = false;
        
        const sessionInfo = document.getElementById('session-info');
        sessionInfo.innerHTML = '<p>No active session</p>';
    });

    window.remoteControl.onControlAccepted((data) => {
        alert(`Control accepted by ${data.targetId}`);
        document.getElementById('main-panel').classList.add('hidden');
        document.getElementById('control-panel').classList.remove('hidden');
        isInControlMode = true;
    });

    window.remoteControl.onControlRejected((message) => {
        alert(`Control rejected: ${message}`);
    });

    window.remoteControl.onControlFailed((message) => {
        alert(`Control request failed: ${message}`);
    });

    window.remoteControl.onScreenFrame((data) => {
        renderFrame(data.frame);
    });

    window.remoteControl.onClipboardReceived((data) => {
        alert(`Clipboard received: ${data.substring(0, 50)}...`);
    });

    window.remoteControl.onOnlineDevices((data) => {
        const devicesList = document.getElementById('devices-list');
        
        if (data.devices && data.devices.length > 0) {
            devicesList.innerHTML = data.devices
                .filter(id => id !== currentDeviceId)
                .map(id => `
                    <div class="device-item">
                        <span class="device-name">${id}</span>
                        <button class="btn btn-primary connect-btn" data-device="${id}">Connect</button>
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
            devicesList.innerHTML = '<p>No online devices found</p>';
        }
    });

    window.remoteControl.onServerDisconnected(() => {
        document.getElementById('connection-status').className = 'status offline';
        document.getElementById('connection-status').textContent = 'Reconnecting...';
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
            ' ': 'space',
            'Enter': 'enter',
            'Tab': 'tab',
            'Shift': 'shift',
            'Control': 'ctrl',
            'Alt': 'alt',
            'Meta': 'meta',
            'Backspace': 'backspace',
            'Delete': 'delete',
            'ArrowUp': 'up',
            'ArrowDown': 'down',
            'ArrowLeft': 'left',
            'ArrowRight': 'right',
            'Home': 'home',
            'End': 'end',
            'PageUp': 'pageup',
            'PageDown': 'pagedown',
            'Escape': 'escape',
            'F1': 'f1',
            'F2': 'f2',
            'F3': 'f3',
            'F4': 'f4',
            'F5': 'f5',
            'F6': 'f6',
            'F7': 'f7',
            'F8': 'f8',
            'F9': 'f9',
            'F10': 'f10',
            'F11': 'f11',
            'F12': 'f12'
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
            ' ': 'space',
            'Enter': 'enter',
            'Tab': 'tab',
            'Shift': 'shift',
            'Control': 'ctrl',
            'Alt': 'alt',
            'Meta': 'meta',
            'Backspace': 'backspace',
            'Delete': 'delete',
            'ArrowUp': 'up',
            'ArrowDown': 'down',
            'ArrowLeft': 'left',
            'ArrowRight': 'right',
            'Home': 'home',
            'End': 'end',
            'PageUp': 'pageup',
            'PageDown': 'pagedown',
            'Escape': 'escape',
            'F1': 'f1',
            'F2': 'f2',
            'F3': 'f3',
            'F4': 'f4',
            'F5': 'f5',
            'F6': 'f6',
            'F7': 'f7',
            'F8': 'f8',
            'F9': 'f9',
            'F10': 'f10',
            'F11': 'f11',
            'F12': 'f12'
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