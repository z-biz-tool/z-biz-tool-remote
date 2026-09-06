// z-biz-tool-remote-server
// Standalone WebSocket signaling server for cross-machine remote desktop sessions.
//
// Hardened from the test signaling-server.js (200 lines) that lives inside
// z-biz-tool-remote's `tests/e2e-protocol.mjs`. This is the production counterpart:
//   - user account auth (HTTP /api/auth/* + per-user session tokens) OR legacy
//     shared AUTH_TOKEN env (for backward compat with pre-account builds)
//   - optional TLS / WSS
//   - /healthz endpoint for load balancer
//   - structured JSON logging
//   - graceful shutdown
//   - JSON-file persistence (users / devices / sessions) at $DATA_FILE
//
// Protocol is wire-compatible with z-biz-tool-remote client. See README.MD.
//
// Run:
//   node src/server.js                # uses defaults
//   PORT=9001 node src/server.js        # custom port
//   AUTH_TOKEN=$(openssl rand -hex 32) node src/server.js   # legacy shared token
//   DATA_FILE=/var/lib/zbt/data.json node src/server.js
//   TLS_KEY_PATH=key.pem TLS_CERT_PATH=cert.pem node src/server.js   # WSS
//
// All env vars also in .env.example.

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import * as auth from "./auth.js";
import * as store from "./storage.js";

// ---------- config ----------

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const SESSIONS_FILE = process.env.SESSIONS_FILE || "";

if (!AUTH_TOKEN) {
  logger.warn("AUTH_TOKEN is empty — server is in user-account mode (no shared-token fallback). Users must register / login first.");
} else {
  logger.info("AUTH_TOKEN set — server accepts both user session tokens and the shared legacy token.");
}

if (AUTH_TOKEN && AUTH_TOKEN.length < 16) {
  logger.error("AUTH_TOKEN too short (<16 chars). Use `openssl rand -hex 32` for a strong token.");
  process.exit(1);
}

// ---------- state ----------

/** @type {Map<string, import('ws').WebSocket>} */
const clients = new Map(); // deviceId -> ws
/** @type {Map<string, { hostId: string|null, sessionToken: string|null, clients: Set<string>, createdAt: number }>} */
const sessions = new Map(); // sessionId -> session

let startedAt = Date.now();
let totalConnections = 0;

// ---------- utilities ----------

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.warn("send failed", { err: String(e) });
    }
  }
}

function getOrCreateSession(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { hostId: null, sessionToken: null, clients: new Set(), createdAt: Date.now() };
    sessions.set(sessionId, s);
  }
  return s;
}

function listOnlineDevices() {
  return [...clients.keys()].map((id) => ({ id, online: true }));
}

function snapshotSessions() {
  return [...sessions.entries()].map(([sid, s]) => ({
    id: sid,
    host: s.hostId,
    clients: [...s.clients],
    ageSec: Math.floor((Date.now() - s.createdAt) / 1000),
  }));
}

function persistSessions() {
  if (!SESSIONS_FILE) return;
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(snapshotSessions(), null, 2), "utf8");
  } catch (e) {
    logger.warn("persistSessions failed", { err: String(e) });
  }
}

// Constant-time string compare to thwart token-timing side channels.
function tokenMatches(provided) {
  if (!AUTH_TOKEN) return false; // require explicit auth (user or shared)
  if (!provided) return false;
  const a = Buffer.from(AUTH_TOKEN, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Extract token from URL query string or Authorization header.
// URL like ws://host:port/?token=abc → "abc"
// Header "Authorization: Bearer abc" → "abc"
function extractToken(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = url.searchParams.get("token");
    if (q) return q;
  } catch {
    /* ignore malformed URL */
  }
  const h = req.headers["authorization"];
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

// ---------- HTTP / WS servers ----------

const httpServer = TLS_KEY_PATH && TLS_CERT_PATH
  ? createHttpsServer(
      {
        key: readFileSync(TLS_KEY_PATH),
        cert: readFileSync(TLS_CERT_PATH),
      },
      handleHttp
    )
  : createHttpServer(handleHttp);

function setCors(res) {
  // Permissive CORS so the Tauri WebView (tauri://localhost) and any
  // browser-based admin tool can hit the JSON API.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

function handleHttp(req, res) {
  setCors(res);
  // Preflight: respond to OPTIONS without body so browsers can proceed.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check: load balancer / k8s probe
  if (req.url === "/healthz" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        online: clients.size,
        sessions: sessions.size,
        totalConnections,
      })
    );
    return;
  }

  // API routes
  if (req.method === "POST" && req.url === "/api/auth/register") {
    auth.handleRegister(req, res).catch((e) => {
      logger.error("register handler error", { err: String(e) });
      try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/login") {
    auth.handleLogin(req, res).catch((e) => {
      logger.error("login handler error", { err: String(e) });
      try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/refresh") {
    auth.handleRefresh(req, res).catch((e) => {
      logger.error("refresh handler error", { err: String(e) });
      try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
    });
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/logout") {
    auth.handleLogout(req, res).catch((e) => {
      logger.error("logout handler error", { err: String(e) });
      try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
    });
    return;
  }
  if (req.method === "GET" && req.url === "/api/me") {
    auth.handleMe(req, res).catch((e) => {
      logger.error("me handler error", { err: String(e) });
      try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
    });
    return;
  }
  // /api/devices/:id
  const devMatch = req.url && req.url.match(/^\/api\/devices\/([A-Za-z0-9_\-]+)$/);
  if (devMatch) {
    const deviceId = devMatch[1];
    if (req.method === "PATCH") {
      auth.handlePatchDevice(req, res, deviceId).catch((e) => {
        logger.error("patch device error", { err: String(e) });
        try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
      });
      return;
    }
    if (req.method === "DELETE") {
      auth.handleDeleteDevice(req, res, deviceId).catch((e) => {
        logger.error("delete device error", { err: String(e) });
        try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal"}'); } catch {}
      });
      return;
    }
  }

  // Default: tell callers this is a WebSocket-only server
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "z-biz-tool-remote-server\nHTTP API: /api/auth/{register,login,refresh,logout}, /api/me, /api/devices/:id\n" +
        "WebSocket signaling at ws://" + req.headers.host + "/\n"
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found\n");
}

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  // 1. Auth check: prefer user session token, fall back to legacy shared AUTH_TOKEN.
  const provided = extractToken(req);
  let user = null;
  if (provided) {
    user = auth.tokenToUser(provided);
  }
  const sharedOk = user == null && tokenMatches(provided);
  if (!user && !sharedOk) {
    logger.warn("ws upgrade rejected: bad/missing token", {
      remote: req.socket.remoteAddress,
      url: req.url,
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // 2. Hand off to ws, attach user to request
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, user);
  });
});

wss.on("connection", (ws, req, user) => {
  totalConnections++;
  let deviceId = null;
  const remoteAddr = req.socket.remoteAddress;

  logger.info("ws connected", {
    remote: remoteAddr,
    userId: user ? user.id : null,
    online: clients.size + 1,
  });

  // 30s ping/pong — kill zombie sockets on broken networks
  let alive = true;
  ws.on("pong", () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) {
      logger.info("ws heartbeat timeout, terminating", { deviceId });
      try {
        ws.terminate();
      } catch {}
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {}
  }, 30000);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn("ws sent non-JSON", { deviceId, remote: remoteAddr });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
    handleMessage(ws, msg, () => deviceId, (id) => (deviceId = id), remoteAddr, user);
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (deviceId && clients.get(deviceId) === ws) {
      clients.delete(deviceId);
      logger.info("ws disconnected", {
        deviceId,
        userId: user ? user.id : null,
        online: clients.size,
      });
      // Tear down sessions that involved this device
      for (const [sid, sess] of sessions) {
        if (sess.hostId === deviceId || sess.clients.has(deviceId)) {
          sess.clients.delete(deviceId);
          for (const cid of sess.clients) {
            const cws = clients.get(cid);
            send(cws, { type: "SESSION_CLOSED", message: "对端已断开" });
          }
          sessions.delete(sid);
        }
      }
    }
    persistSessions();
  });

  ws.on("error", (err) => {
    logger.warn("ws error", { deviceId, err: String(err) });
  });
});

function handleMessage(ws, msg, getDeviceId, setDeviceId, remoteAddr, user) {
  const deviceId = getDeviceId();
  switch (msg.type) {
    case "REGISTER": {
      // Server-assigned deviceId avoids collision across multiple instances / reconnects.
      if (msg.deviceId && !clients.has(msg.deviceId)) {
        setDeviceId(msg.deviceId);
      } else {
        const id = "srv-" + randomBytes(4).toString("hex");
        // Reject if the freshly-generated id also collides (1 in 2^32 chance, but still).
        if (clients.has(id)) {
          send(ws, { type: "ERROR", code: "ID_COLLISION", message: "retry" });
          return;
        }
        setDeviceId(id);
      }
      clients.set(getDeviceId(), ws);
      // Bind the device to the user (if WS was authenticated as a user).
      if (user) {
        auth.claimDevice({
          id: getDeviceId(),
          userId: user.id,
          name: msg.deviceName || null,
        }).catch((e) => logger.warn("claimDevice failed", { err: String(e) }));
      } else {
        // Legacy AUTH_TOKEN user — still touch lastSeen if the device exists
        auth.touchDevice(getDeviceId()).catch(() => {});
      }
      send(ws, {
        type: "REGISTER_SUCCESS",
        deviceId: getDeviceId(),
        // Production deployments should rotate this; here we keep the original test key for compatibility.
        encryptionKey: msg.encryptionKey || process.env.ENCRYPTION_KEY || "test-key",
        // Tell the client whether it's bound to a user account.
        userId: user ? user.id : null,
        username: user ? user.username : null,
      });
      logger.info("device registered", {
        deviceId: getDeviceId(),
        userId: user ? user.id : null,
        remote: remoteAddr,
      });
      break;
    }
    case "LIST_MY_DEVICES": {
      // Return the calling user's devices (excluding self).
      if (!user) {
        send(ws, { type: "ERROR", code: "NOT_AUTHENTICATED", message: "user session required" });
        return;
      }
      const myDevices = store.listDevicesByUser(user.id).map((d) => ({
        id: d.id,
        name: d.name || d.id,
        lastSeen: d.lastSeen,
        online: clients.has(d.id) && d.id !== deviceId,
      }));
      send(ws, { type: "MY_DEVICES", devices: myDevices });
      break;
    }
    case "CREATE_SESSION": {
      if (!deviceId) {
        send(ws, { type: "ERROR", code: "NOT_REGISTERED" });
        return;
      }
      const sessionId = randomBytes(4).toString("hex");
      const sessionToken = randomBytes(8).toString("hex"); // 16 chars, harder to brute force than 12
      const sess = getOrCreateSession(sessionId);
      sess.hostId = deviceId;
      sess.sessionToken = sessionToken;
      sess.clients.add(deviceId);
      send(ws, { type: "SESSION_CREATED", sessionId, sessionToken, deviceId });
      logger.info("session created", { sessionId, host: deviceId, remote: remoteAddr });
      persistSessions();
      break;
    }
    case "JOIN_SESSION": {
      if (!deviceId) {
        send(ws, { type: "JOIN_FAILED", message: "未注册" });
        return;
      }
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
      send(ws, { type: "JOIN_SUCCESS", sessionId: msg.sessionId, hostId: sess.hostId });
      const hostWs = clients.get(sess.hostId);
      if (hostWs) send(hostWs, { type: "CLIENT_JOINED", clientId: deviceId });
      logger.info("session joined", {
        sessionId: msg.sessionId,
        client: deviceId,
        host: sess.hostId,
      });
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
      logger.info("control request", { from: deviceId, to: targetId });
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
      logger.info("control reject", { from: deviceId, to: targetId });
      break;
    }
    case "CONTROL_ACCEPT": {
      if (!deviceId) return;
      const targetId = msg.targetId;
      const targetWs = clients.get(targetId);
      if (targetWs) {
        send(targetWs, {
          type: "CONTROL_ACCEPTED",
          targetId: deviceId,
          sessionId: msg.sessionId,
        });
      }
      logger.info("control accept", { from: deviceId, to: targetId });
      break;
    }
    case "SCREEN_FRAME": {
      if (!deviceId) return;
      const sess = sessions.get(msg.sessionId);
      if (!sess) return;
      // Fan out to every other participant in this session.
      let n = 0;
      for (const cid of sess.clients) {
        if (cid === deviceId) continue;
        const cws = clients.get(cid);
        if (cws) {
          send(cws, { type: "SCREEN_FRAME", frame: msg.frame, fromId: deviceId });
          n++;
        }
      }
      // Don't log every frame — too noisy. Log only first 5 then silently.
      // (Stat counter could go here.)
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
    case "GET_ONLINE_DEVICES": {
      send(ws, { type: "ONLINE_DEVICES", devices: listOnlineDevices() });
      break;
    }
    case "PING":
      send(ws, { type: "PONG" });
      break;
    case "PONG":
      // already handled by heartbeat
      break;
    default:
      logger.warn("unknown message type", { type: msg.type, deviceId });
      send(ws, { type: "ERROR", code: "UNKNOWN_TYPE", message: msg.type });
  }
}

// ---------- lifecycle ----------

httpServer.listen(PORT, HOST, () => {
  const proto = TLS_KEY_PATH && TLS_CERT_PATH ? "wss" : "ws";
  logger.info("server listening", {
    addr: `${proto}://${HOST}:${PORT}`,
    auth: AUTH_TOKEN ? "shared-token (legacy)" : "user-account",
    tls: TLS_KEY_PATH && TLS_CERT_PATH ? "enabled" : "disabled",
    dataFile: process.env.DATA_FILE || "data.json",
  });
  store.startSweeper(60_000);
});

function shutdown(signal) {
  logger.info("shutting down", { signal });
  // 1. Stop accepting new connections
  httpServer.close(() => {
    logger.info("http server closed");
  });
  // 2. Close all WS gracefully
  for (const [id, ws] of clients) {
    try {
      ws.send(JSON.stringify({ type: "SERVER_SHUTDOWN", message: "server going down" }));
    } catch {}
    try {
      ws.close(1001, "going away");
    } catch {}
  }
  // 3. Persist final session snapshot
  persistSessions();
  // 4. Force-exit after 5s if anyone is still hanging
  setTimeout(() => process.exit(0), 5000).unref();
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err: String(err), stack: err.stack });
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
});
