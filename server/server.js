const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const server = new WebSocket.Server({ port: PORT });

const devices = new Map();
const sessions = new Map();
const sessionRelations = new Map();

function generateDeviceId() {
  return uuidv4().replace(/-/g, '').substring(0, 16);
}

function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

function encrypt(data, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(JSON.stringify(data));
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    data: encrypted.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

function decrypt(encryptedData, key) {
  const iv = Buffer.from(encryptedData.iv, 'hex');
  const encrypted = Buffer.from(encryptedData.data, 'hex');
  const authTag = Buffer.from(encryptedData.authTag, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return JSON.parse(decrypted.toString());
}

server.on('connection', (ws) => {
  console.log('New client connected');
  
  let deviceId = null;
  let sessionToken = null;
  let sessionId = null;
  let encryptionKey = null;

  ws.on('message', (message) => {
    try {
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (e) {
        console.error('Invalid JSON message');
        return;
      }

      switch (data.type) {
        case 'REGISTER': {
          if (devices.has(data.deviceId)) {
            deviceId = data.deviceId;
            devices.set(deviceId, ws);
            ws.send(JSON.stringify({
              type: 'REGISTER_SUCCESS',
              deviceId: deviceId,
              message: 'Device reconnected'
            }));
          } else {
            deviceId = generateDeviceId();
            encryptionKey = crypto.randomBytes(32).toString('hex');
            devices.set(deviceId, ws);
            ws.send(JSON.stringify({
              type: 'REGISTER_SUCCESS',
              deviceId: deviceId,
              encryptionKey: encryptionKey
            }));
          }
          console.log(`Device registered: ${deviceId}`);
          break;
        }

        case 'CREATE_SESSION': {
          sessionId = uuidv4();
          sessionToken = generateSessionToken();
          sessions.set(sessionId, {
            host: deviceId,
            token: sessionToken,
            clients: [],
            createdAt: Date.now()
          });
          sessionRelations.set(deviceId, sessionId);
          ws.send(JSON.stringify({
            type: 'SESSION_CREATED',
            sessionId: sessionId,
            sessionToken: sessionToken,
            deviceId: deviceId
          }));
          console.log(`Session created: ${sessionId} by device ${deviceId}`);
          break;
        }

        case 'JOIN_SESSION': {
          const session = sessions.get(data.sessionId);
          if (!session) {
            ws.send(JSON.stringify({
              type: 'JOIN_FAILED',
              message: 'Session not found'
            }));
            break;
          }
          if (data.sessionToken !== session.token) {
            ws.send(JSON.stringify({
              type: 'JOIN_FAILED',
              message: 'Invalid token'
            }));
            break;
          }
          session.clients.push(deviceId);
          sessionRelations.set(deviceId, sessionId);
          const hostWs = devices.get(session.host);
          if (hostWs) {
            hostWs.send(JSON.stringify({
              type: 'CLIENT_JOINED',
              clientId: deviceId,
              sessionId: data.sessionId
            }));
          }
          ws.send(JSON.stringify({
            type: 'JOIN_SUCCESS',
            sessionId: data.sessionId,
            hostId: session.host
          }));
          console.log(`Device ${deviceId} joined session ${data.sessionId}`);
          break;
        }

        case 'CONTROL_REQUEST': {
          const targetWs = devices.get(data.targetId);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'CONTROL_REQUEST',
              fromId: deviceId,
              sessionId: data.sessionId
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'CONTROL_FAILED',
              message: 'Target device not online'
            }));
          }
          break;
        }

        case 'CONTROL_ACCEPT': {
          const controllerWs = devices.get(data.fromId);
          if (controllerWs) {
            controllerWs.send(JSON.stringify({
              type: 'CONTROL_ACCEPTED',
              targetId: deviceId,
              sessionId: data.sessionId
            }));
          }
          break;
        }

        case 'CONTROL_REJECT': {
          const controllerWs = devices.get(data.fromId);
          if (controllerWs) {
            controllerWs.send(JSON.stringify({
              type: 'CONTROL_REJECTED',
              targetId: deviceId,
              message: data.message || 'Control request rejected'
            }));
          }
          break;
        }

        case 'SCREEN_FRAME': {
          const session = sessions.get(data.sessionId);
          if (session) {
            session.clients.forEach(clientId => {
              const clientWs = devices.get(clientId);
              if (clientWs && clientId !== deviceId) {
                clientWs.send(JSON.stringify({
                  type: 'SCREEN_FRAME',
                  fromId: deviceId,
                  sessionId: data.sessionId,
                  frame: data.frame,
                  timestamp: data.timestamp
                }));
              }
            });
          }
          break;
        }

        case 'INPUT_EVENT': {
          const targetWs = devices.get(data.targetId);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'INPUT_EVENT',
              fromId: deviceId,
              event: data.event,
              sessionId: data.sessionId
            }));
          }
          break;
        }

        case 'CLIPBOARD_DATA': {
          const targetWs = devices.get(data.targetId);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'CLIPBOARD_DATA',
              fromId: deviceId,
              data: data.data,
              sessionId: data.sessionId
            }));
          }
          break;
        }

        case 'FILE_TRANSFER': {
          const targetWs = devices.get(data.targetId);
          if (targetWs) {
            targetWs.send(JSON.stringify({
              type: 'FILE_TRANSFER',
              fromId: deviceId,
              filename: data.filename,
              size: data.size,
              chunk: data.chunk,
              chunkIndex: data.chunkIndex,
              totalChunks: data.totalChunks,
              sessionId: data.sessionId
            }));
          }
          break;
        }

        case 'GET_ONLINE_DEVICES': {
          const onlineDevices = Array.from(devices.keys());
          ws.send(JSON.stringify({
            type: 'ONLINE_DEVICES',
            devices: onlineDevices
          }));
          break;
        }

        case 'PING': {
          ws.send(JSON.stringify({ type: 'PONG' }));
          break;
        }

        default:
          console.log(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (deviceId) {
      devices.delete(deviceId);
      const sid = sessionRelations.get(deviceId);
      if (sid) {
        const session = sessions.get(sid);
        if (session) {
          if (session.host === deviceId) {
            sessions.delete(sid);
            session.clients.forEach(clientId => {
              const clientWs = devices.get(clientId);
              if (clientWs) {
                clientWs.send(JSON.stringify({
                  type: 'SESSION_CLOSED',
                  message: 'Host disconnected'
                }));
              }
              sessionRelations.delete(clientId);
            });
          } else {
            session.clients = session.clients.filter(id => id !== deviceId);
            const hostWs = devices.get(session.host);
            if (hostWs) {
              hostWs.send(JSON.stringify({
                type: 'CLIENT_LEFT',
                clientId: deviceId
              }));
            }
          }
        }
        sessionRelations.delete(deviceId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

server.on('listening', () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, sid) => {
    if (now - session.createdAt > 3600000) {
      sessions.delete(sid);
    }
  });
}, 60000);