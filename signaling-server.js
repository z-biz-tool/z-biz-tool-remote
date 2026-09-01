// Minimal WebSocket signaling server for z-biz-tool-remote E2E test.
// Implements just enough of the original server.js protocol to let two clients
// (host + controller) negotiate a session and relay screen frames / input events.
//
// Run: node signaling-server.js [port]
// Default port: 8080

import { WebSocketServer } from "ws";
import { randomUUID, randomBytes } from "node:crypto";

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const wss = new WebSocketServer({ port: PORT });

// deviceId -> ws
const clients = new Map();
// sessionId -> { hostId, sessionToken, clients: Set<deviceId> }
const sessions = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getOrCreateSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { hostId: null, sessionToken: null, clients: new Set() };
    sessions.set(sessionId, s);
  }
  return s;
}

function listOnlineDevices() {
  return [...clients.keys()].map((id) => ({ id, online: true }));
}

wss.on("connection", (ws) => {
  let deviceId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "REGISTER": {
        // 服务端统一分配 deviceId，避免多实例撞 id。客户端带的 deviceId 仅作 hint。
        if (msg.deviceId && !clients.has(msg.deviceId)) {
          deviceId = msg.deviceId;
        } else {
          deviceId = "srv-" + randomBytes(4).toString("hex");
        }
        clients.set(deviceId, ws);
        send(ws, {
          type: "REGISTER_SUCCESS",
          deviceId,
          encryptionKey: "test-key",
        });
        console.log(`[register] ${deviceId} (online=${clients.size})`);
        break;
      }
      case "CREATE_SESSION": {
        if (!deviceId) return;
        const sessionId = randomBytes(4).toString("hex");
        const sessionToken = randomBytes(6).toString("hex");
        const sess = getOrCreateSession(sessionId);
        sess.hostId = deviceId;
        sess.sessionToken = sessionToken;
        sess.clients.add(deviceId);
        send(ws, {
          type: "SESSION_CREATED",
          sessionId,
          sessionToken,
          deviceId,
        });
        console.log(`[create-session] ${deviceId} -> ${sessionId}`);
        break;
      }
      case "JOIN_SESSION": {
        if (!deviceId) return;
        const sess = sessions.get(msg.sessionId);
        if (!sess || sess.sessionToken !== msg.sessionToken) {
          send(ws, { type: "JOIN_FAILED", message: "会话不存在或令牌错误" });
          return;
        }
        if (!sess.hostId) {
          send(ws, { type: "JOIN_FAILED", message: "会话没有 host" });
          return;
        }
        sess.clients.add(deviceId);
        send(ws, {
          type: "JOIN_SUCCESS",
          sessionId: msg.sessionId,
          hostId: sess.hostId,
        });
        // 通知 host
        const hostWs = clients.get(sess.hostId);
        if (hostWs) {
          send(hostWs, { type: "CLIENT_JOINED", clientId: deviceId });
        }
        console.log(`[join-session] ${deviceId} -> ${msg.sessionId} (host=${sess.hostId})`);
        break;
      }
      case "CONTROL_REQUEST": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (!targetWs) {
          send(ws, { type: "CONTROL_FAILED", message: "目标设备不在线" });
          return;
        }
        send(targetWs, {
          type: "CONTROL_REQUEST",
          fromId: deviceId,
          sessionId: msg.sessionId,
        });
        console.log(`[control-request] ${deviceId} -> ${targetId}`);
        break;
      }
      case "CONTROL_ACCEPT": {
        if (!deviceId) return;
        const targetId = msg.targetId || msg.fromId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, { type: "CONTROL_ACCEPTED", targetId: deviceId });
        }
        console.log(`[control-accept] ${deviceId} -> ${targetId}`);
        break;
      }
      case "CONTROL_REJECT": {
        if (!deviceId) return;
        const targetId = msg.targetId || msg.fromId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "CONTROL_REJECTED",
            message: msg.message || "对方拒绝",
          });
        }
        break;
      }
      case "SCREEN_FRAME": {
        if (!deviceId) return;
        const sess = sessions.get(msg.sessionId);
        if (!sess) return;
        // 转发给 session 里除自己以外的所有人
        for (const cid of sess.clients) {
          if (cid === deviceId) continue;
          const cws = clients.get(cid);
          if (cws) {
            send(cws, {
              type: "SCREEN_FRAME",
              frame: msg.frame,
              fromId: deviceId,
            });
          }
        }
        break;
      }
      case "INPUT_EVENT": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "INPUT_EVENT",
            event: msg.event,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "FILE_TRANSFER_REQUEST": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "FILE_TRANSFER_REQUEST",
            fromId: deviceId,
            fileName: msg.fileName,
            fileSize: msg.fileSize,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "FILE_TRANSFER_ACCEPT": {
        if (!deviceId) return;
        const targetId = msg.targetId || msg.fromId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "FILE_TRANSFER_ACCEPT",
            fromId: deviceId,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "FILE_TRANSFER_REJECT": {
        if (!deviceId) return;
        const targetId = msg.targetId || msg.fromId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "FILE_TRANSFER_REJECT",
            fromId: deviceId,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "FILE_DATA": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "FILE_DATA",
            fromId: deviceId,
            chunk: msg.chunk,
            offset: msg.offset,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "FILE_TRANSFER_PROGRESS": {
        if (!deviceId) return;
        const targetId = msg.targetId || msg.fromId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "FILE_TRANSFER_PROGRESS",
            fromId: deviceId,
            progress: msg.progress,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "CHAT_MESSAGE": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "CHAT_MESSAGE",
            fromId: deviceId,
            message: msg.message,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "SYSTEM_NOTIFICATION": {
        if (!deviceId) return;
        const targetId = msg.targetId;
        const targetWs = clients.get(targetId);
        if (targetWs) {
          send(targetWs, {
            type: "SYSTEM_NOTIFICATION",
            fromId: deviceId,
            message: msg.message,
            sessionId: msg.sessionId,
          });
        }
        break;
      }
      case "GET_ONLINE_DEVICES": {
        send(ws, { type: "ONLINE_DEVICES", devices: listOnlineDevices() });
        break;
      }
      case "PONG":
        break;
      default:
        // 忽略未知消息
        break;
    }
  });

  ws.on("close", () => {
    if (deviceId && clients.get(deviceId) === ws) {
      clients.delete(deviceId);
      console.log(`[disconnect] ${deviceId} (online=${clients.size})`);
      // 清理涉及此 deviceId 的 session
      for (const [sid, sess] of sessions) {
        if (sess.hostId === deviceId || sess.clients.has(deviceId)) {
          sess.clients.delete(deviceId);
          for (const cid of sess.clients) {
            const cws = clients.get(cid);
            if (cws) {
              send(cws, { type: "SESSION_CLOSED", message: "对端已断开" });
            }
          }
          sessions.delete(sid);
        }
      }
    }
  });
});

console.log(`signaling server listening on ws://0.0.0.0:${PORT}`);
