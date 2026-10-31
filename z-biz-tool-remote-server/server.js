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
// 令牌怎么带（WS_TOKEN_TRANSPORT，默认 frame）：
//   frame —— 令牌放在**首帧** {"type":"AUTH","token":"..."}；URL 查询串里**没有**凭据。
//            浏览器 WS 不能自定义 header，而查询串会进浏览器历史 / 反代 access_log /
//            抓包 / 截图 —— 账号令牌不该出现在那里。
//   query —— 老行为：ws://host/?token=...（**仅**为兼容老客户端保留，默认关闭）
//   both  —— 两种都收（灰度期用：先发新版客户端，再切服务端）
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
// 令牌承载方式：frame（默认，令牌走首帧）/ query（老行为）/ both（灰度期）
const WS_TOKEN_TRANSPORT = (process.env.WS_TOKEN_TRANSPORT || "frame").toLowerCase();
// 首帧鉴权的等待上限：超过就断开，避免未鉴权连接长期占资源
const WS_AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS || 5000);
// 单条 WS 消息上限（台账 S1-B06）。当前屏幕帧是 base64 JPEG，单帧可达数百 KB，
// 所以不能按「信令 64KB」卡死；默认 8MB 是「足以放下正常帧、又不让一条消息打爆内存」。
// 超限时 ws 库直接以 1009 关闭连接（不解析、不转发）。
const WS_MAX_PAYLOAD = Number(process.env.WS_MAX_PAYLOAD || 8 * 1024 * 1024);

if (!Number.isFinite(WS_MAX_PAYLOAD) || WS_MAX_PAYLOAD < 1024) {
  logger.error("WS_MAX_PAYLOAD 非法（应为 >=1024 的字节数）", { value: process.env.WS_MAX_PAYLOAD });
  process.exit(1);
}

if (!["frame", "query", "both"].includes(WS_TOKEN_TRANSPORT)) {
  logger.error("WS_TOKEN_TRANSPORT 非法，只能是 frame | query | both", { value: WS_TOKEN_TRANSPORT });
  process.exit(1);
}

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
/** @type {Map<string, Set<string>>} host deviceId -> deviceIds it accepted control from */
const controlGrants = new Map();

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

// INPUT_EVENT ends up as real mouse/keyboard injection on the target machine,
// so "the host clicked accept on this device" has to be state the server
// actually remembers — the client's own isHosting flag is not a gate.
function grantControl(hostId, peerId) {
  if (!hostId || !peerId) return;
  let peers = controlGrants.get(hostId);
  if (!peers) {
    peers = new Set();
    controlGrants.set(hostId, peers);
  }
  peers.add(peerId);
}

function revokeControl(hostId, peerId) {
  const peers = controlGrants.get(hostId);
  if (!peers) return;
  peers.delete(peerId);
  if (!peers.size) controlGrants.delete(hostId);
}

function dropGrantsFor(deviceId) {
  controlGrants.delete(deviceId);
  for (const [hostId, peers] of controlGrants) {
    if (peers.delete(deviceId) && !peers.size) controlGrants.delete(hostId);
  }
}

/** True when `peerId` may drive `hostId`: an accepted control link, or both
 *  sides genuinely belonging to the claimed session. A guessed sessionId is
 *  useless here because membership is checked against the sender too. */
function canRelay(hostId, peerId, sessionId) {
  if (!hostId || !peerId || hostId === peerId) return false;
  if (controlGrants.get(hostId)?.has(peerId)) return true;
  const sess = sessions.get(sessionId);
  if (!sess) return false;
  const inSess = (id) => id === sess.hostId || sess.clients.has(id);
  return inSess(hostId) && inSess(peerId);
}

/** 「在线设备」列表 —— **按调用者可见范围裁剪**。
 *
 *  2026-10-05 补：原先这里直接吐 `[...clients.keys()]`，也就是**全量 deviceId**。
 *  在账号模式下这是一次跨租户目录泄漏：任何注册用户都能枚举到全组织在线设备的
 *  id，而 deviceId 正是 `CONTROL_REQUEST` 的寻址目标。兄弟通道 `LIST_MY_DEVICES`
 *  早就按 `listDevicesByUser` 裁剪了，只有这条漏了。
 *
 *  口径：
 *  - 账号模式（带 user）：只返回该用户名下的设备，与 LIST_MY_DEVICES 同源。
 *  - 共享 AUTH_TOKEN 模式：整个部署共用一个 token，本就是一个逻辑租户，返回全量
 *    与该模式的信任模型自洽 —— 这也是这里唯一保留全量的分支，且它需要显式的
 *    共享 token 才进得来。
 */
function listOnlineDevicesFor(user) {
  const online = new Set(clients.keys());
  if (!user) {
    return [...online].map((id) => ({ id, online: true }));
  }
  return store
    .listDevicesByUser(user.id)
    .filter((d) => online.has(d.id))
    .map((d) => ({ id: d.id, name: d.name || d.id, online: true }));
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

// 令牌从哪里取：
//   - URL 查询串 ?token=… —— **只有 WS_TOKEN_TRANSPORT=query|both 的兼容模式才读**。
//     查询串会进浏览器历史、反代/CDN access_log、抓包与截图，是凭据最不该待的地方。
//   - Authorization: Bearer … —— 非浏览器客户端（node ws / curl / 脚本）用这个；
//     它不在 URL 里，也不进 access_log（除非反代专门记这个头）。
//   - 首帧 {"type":"AUTH","token":"…"} —— 默认（frame）路径，见 handleAuthFrame。
function extractQueryToken(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    return url.searchParams.get("token") || "";
  } catch {
    /* ignore malformed URL */
  }
  return "";
}

function extractHeaderToken(req) {
  const h = req.headers["authorization"];
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

/** 日志里不能出现明文令牌：查询串里的 token= 全部打码。 */
function redactUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  return rawUrl.replace(/([?&]token=)[^&]*/gi, "$1***");
}

// ---------- HTTP / WS servers ----------

// TLS 材料必须在**启动时**校验：原来「只配了 key 没配 cert」会静默回落成明文 HTTP，
// 现场表现就是 ssl.wrap_socket 报 WRONG_VERSION_NUMBER —— 看起来像「证书坏了」，
// 实际是**根本没启用 TLS**。宁可启动失败并说清楚，也不要悄悄降级成明文。
function loadTlsOptions() {
  if (!TLS_KEY_PATH && !TLS_CERT_PATH) return null;
  if (!TLS_KEY_PATH || !TLS_CERT_PATH) {
    logger.error("TLS 配置不完整：TLS_KEY_PATH 与 TLS_CERT_PATH 必须**同时**提供", {
      hasKey: Boolean(TLS_KEY_PATH),
      hasCert: Boolean(TLS_CERT_PATH),
    });
    process.exit(1);
  }
  for (const p of [TLS_KEY_PATH, TLS_CERT_PATH]) {
    if (!existsSync(p)) {
      logger.error("TLS 文件不存在（容器里要挂进容器的路径，不是宿主路径）", { path: p });
      process.exit(1);
    }
  }
  try {
    return { key: readFileSync(TLS_KEY_PATH), cert: readFileSync(TLS_CERT_PATH) };
  } catch (e) {
    logger.error("TLS 材料读取失败", { err: String(e) });
    process.exit(1);
  }
}

const tlsOptions = loadTlsOptions();
const TLS_ENABLED = Boolean(tlsOptions);

const httpServer = tlsOptions
  ? createHttpsServer(tlsOptions, handleHttp)
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
  // SSO（ctc 统一登录）—— **可选**：服务端没配时返回 204 / 503，
  // 账号密码登录照常可用，不受影响。
  if (req.method === "GET" && req.url === "/api/sso/config") {
    auth.handleSsoConfig(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/api/auth/sso") {
    auth.handleSsoLogin(req, res).catch((e) => {
      logger.error("sso handler error", { err: String(e) });
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
    const wsProto = TLS_ENABLED ? "wss" : "ws";
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "z-biz-tool-remote-server\nHTTP API: /api/auth/{register,login,refresh,logout}, /api/me, /api/devices/:id\n" +
        "WebSocket signaling at " + wsProto + "://" + req.headers.host + "/\n"
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found\n");
}

const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

httpServer.on("upgrade", (req, socket, head) => {
  // 1. Auth check.
  //
  //    默认（WS_TOKEN_TRANSPORT=frame）：**不读 URL 查询串**，握手不做鉴权，
  //    令牌由首帧 AUTH 携带（浏览器 WS 不能自定义 header）。握手放行意味着
  //    存在一个「未鉴权」的短暂窗口 —— 用 WS_AUTH_TIMEOUT_MS 兜底，超时即断。
  //
  //    query / both（兼容模式）：读 ?token= 或 Authorization 头，握手即鉴权。
  //      both 且**没带**令牌时 → 放行握手，改由首帧 AUTH 鉴权（灰度期新客户端走这条）。
  const queryToken = WS_TOKEN_TRANSPORT === "frame" ? "" : extractQueryToken(req);
  const headerToken = extractHeaderToken(req);
  const provided = queryToken || headerToken;
  let user = null;
  let authorized = false;
  if (provided) {
    user = auth.tokenToUser(provided);
    if (user) authorized = true;
    else if (tokenMatches(provided)) authorized = true; // 共享 AUTH_TOKEN 模式
  }
  // 带了一个**错的**令牌 → 立刻 401（别让人挂着等首帧）；
  // query 模式必须握手即鉴权 → 没带令牌也 401（老行为）。
  const badToken = Boolean(provided) && !authorized;
  const handshakeMustAuth = WS_TOKEN_TRANSPORT === "query";
  if (badToken || (handshakeMustAuth && !authorized)) {
    logger.warn("ws upgrade rejected: bad/missing token", {
      remote: req.socket.remoteAddress,
      url: redactUrl(req.url),
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // 2. Hand off to ws, attach auth context to request
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, { user, authorized });
  });
});

wss.on("connection", (ws, req, ctx) => {
  totalConnections++;
  let deviceId = null;
  const remoteAddr = req.socket.remoteAddress;
  // user / authorized 在首帧鉴权成功后会被改写 —— 所以必须是 let。
  let user = ctx?.user ?? null;
  let authorized = ctx?.authorized === true;

  logger.info("ws connected", {
    remote: remoteAddr,
    userId: user ? user.id : null,
    authenticated: authorized,
    online: clients.size + 1,
  });

  // 未鉴权连接（frame 模式首帧还没到）的兜底：超时即断，不给未鉴权连接长期占资源。
  let authTimer = null;
  if (!authorized) {
    authTimer = setTimeout(() => {
      if (authorized) return;
      logger.warn("ws auth timeout (no AUTH frame)", { remote: remoteAddr });
      try { ws.close(4401, "auth timeout"); } catch {}
    }, WS_AUTH_TIMEOUT_MS);
  }

  /** 首帧鉴权：{"type":"AUTH","token":"…"} */
  function handleAuthFrame(msg) {
    if (authorized) {
      // 幂等：已经鉴权过（例如 both 模式握手就过了）就只回一个 AUTH_OK。
      send(ws, { type: "AUTH_OK", userId: user ? user.id : null, username: user ? user.username : null });
      return;
    }
    const provided = typeof msg.token === "string" ? msg.token : "";
    const u = provided ? auth.tokenToUser(provided) : null;
    if (!u && !tokenMatches(provided)) {
      logger.warn("ws auth frame rejected: bad token", { remote: remoteAddr });
      send(ws, { type: "ERROR", code: "UNAUTHORIZED", message: "令牌无效" });
      try { ws.close(4401, "unauthorized"); } catch {}
      return;
    }
    authorized = true;
    user = u;
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
    send(ws, { type: "AUTH_OK", userId: u ? u.id : null, username: u ? u.username : null });
    logger.info("ws authenticated", { remote: remoteAddr, userId: u ? u.id : null });
  }

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

    if (msg.type === "AUTH") {
      handleAuthFrame(msg);
      return;
    }
    // 未鉴权之前只认 AUTH 帧：否则「握手放行 + 首帧鉴权」就等于没有鉴权。
    if (!authorized) {
      logger.warn("ws message before auth", { type: msg.type, remote: remoteAddr });
      send(ws, { type: "ERROR", code: "AUTH_REQUIRED", message: "请先发送 AUTH 帧" });
      try { ws.close(4401, "auth required"); } catch {}
      return;
    }
    handleMessage(ws, msg, () => deviceId, (id) => (deviceId = id), remoteAddr, user);
  });

  ws.on("close", () => {
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
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
      // An offline device can no longer be on the receiving end of a grant,
      // and must not be able to resume control with a stale one.
      dropGrantsFor(deviceId);
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
      //
      // 设备归属校验（台账 S-04 / S-05，P0）：deviceId 是**账号资产**。
      // 原实现只要 `!clients.has(deviceId)` 就接受客户端自带的 id ——
      // 于是「对方离线」时，任何账号都能用别人的 deviceId 注册，
      // 直接把这台设备的归属改挂到自己名下（设备劫持），后续
      // LIST_MY_DEVICES / 控制授权全跟着错。
      // 现在：id 已属于别的账号 ⇒ 不发这个 id，改发一个服务端新 id 并回
      // `deviceIdReassigned: true`（不抛错，避免用户卡在「连不上」里）。
      const requestedId = typeof msg.deviceId === "string" ? msg.deviceId : "";
      const owned = requestedId ? store.findDevice(requestedId) : null;
      const ownedByOtherUser = Boolean(user && owned && owned.userId !== user.id);
      if (requestedId && !ownedByOtherUser && !clients.has(requestedId)) {
        setDeviceId(requestedId);
      } else {
        const id = "srv-" + randomBytes(4).toString("hex");
        // Reject if the freshly-generated id also collides (1 in 2^32 chance, but still).
        if (clients.has(id)) {
          send(ws, { type: "ERROR", code: "ID_COLLISION", message: "retry" });
          return;
        }
        setDeviceId(id);
      }
      const reassigned = Boolean(requestedId) && getDeviceId() !== requestedId;
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
        // ⚠️ 这里**曾经**有一个 `encryptionKey` 字段，现在**删掉了**（台账 S1-B09/B10）。
        // 它从来就不参与任何加解密：屏幕帧与键鼠事件都走
        // `ws.send(JSON.stringify(msg))` 的明文 JSON。
        // 没有 TLS 的时候，带内加密是自欺欺人 —— 屏幕帧与键鼠事件都是明文 JSON，
        // 窃听者直接看得见。**真正的防线是 WSS**
        // （本服务端支持 TLS_KEY_PATH / TLS_CERT_PATH，见文件头）。
        // 账号令牌已不再走 URL 查询串（默认首帧 AUTH，见 WS_TOKEN_TRANSPORT）——
        // 但首帧本身在明文链路上同样裸奔，**所以 WSS 仍然是必须的**。
        //
        // 为什么是「删掉」而不是「换成一个随机值」：
        // 留着一个叫 encryptionKey 的字段，就会让用户以为链路是加密的 ——
        // 而它其实什么都不是。**给用户「已加密」的错觉，比不加密更危险。**
        // 真正的防线是 WSS（本服务端支持 TLS_KEY_PATH / TLS_CERT_PATH，见文件头）。
        // 账号令牌现在也**不再**走 URL 查询串了（默认首帧 AUTH，见 WS_TOKEN_TRANSPORT）。
        // Tell the client whether it's bound to a user account.
        userId: user ? user.id : null,
        username: user ? user.username : null,
        // true = 客户端请求的 deviceId 没被采用（归属他人或在线冲突），本机改用新 id
        deviceIdReassigned: reassigned,
        deviceIdConflict: ownedByOtherUser,
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
      // sameUser 必须由服务端按设备归属算出来，不能由请求方自报（台账 S-16）：
      // 被控端会据此免确认，客户端说"我们同账号"就等于允许它绕过确认。
      const fromDevice = store.findDevice(deviceId);
      const targetDevice = store.findDevice(targetId);
      const sameUser = Boolean(
        user && fromDevice && targetDevice &&
          fromDevice.userId === user.id && targetDevice.userId === user.id
      );
      send(targetWs, {
        type: "CONTROL_REQUEST",
        fromId: deviceId,
        sessionId: msg.sessionId,
        ephemeral: Boolean(msg.ephemeral) || !msg.sessionId,
        sameUser,
        requestedPermission: msg.requestedPermission,
        sasHash: msg.sasHash,
      });
      logger.info("control request", { from: deviceId, to: targetId, sameUser });
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
      revokeControl(deviceId, targetId);
      logger.info("control reject", { from: deviceId, to: targetId });
      break;
    }
    case "CONTROL_ACCEPT": {
      if (!deviceId) return;
      // 客户端发的是 fromId（请求方）；targetId 是老字段，两种都收。
      // 原来只读 targetId ⇒ 真实客户端发 fromId 时这里拿到 undefined，
      // 既不回执也不授权，「接受控制」看着点了、实际什么都没发生（台账 S1-B16 / Z-08）。
      const peerId = msg.targetId || msg.fromId;
      const peerWs = clients.get(peerId);
      if (!peerWs) {
        send(ws, { type: "CONTROL_FAILED", message: "请求方已离线" });
        return;
      }

      const requestedSessionId = typeof msg.sessionId === "string" ? msg.sessionId : "";
      const existing = requestedSessionId ? sessions.get(requestedSessionId) : null;

      if (existing && existing.hostId === deviceId) {
        // 显式会话已存在：沿用原会话，不新建
        existing.clients.add(peerId);
        grantControl(deviceId, peerId);
        send(peerWs, {
          type: "CONTROL_ACCEPTED",
          targetId: deviceId,
          sessionId: requestedSessionId,
        });
        send(ws, { type: "CLIENT_JOINED", clientId: peerId });
        logger.info("control accepted (existing session)", {
          host: deviceId,
          peer: peerId,
          sessionId: requestedSessionId,
        });
      } else {
        // 一键互控（无显式会话）：服务端**真正建会话**，并把
        // sessionId/sessionToken/role 回给请求方，否则控制端停在
        // controlling 视图却没有任何会话可收帧（台账 Z-08）。
        const sessionId = randomBytes(4).toString("hex");
        const sessionToken = randomBytes(8).toString("hex");
        const sess = getOrCreateSession(sessionId);
        sess.hostId = deviceId;
        sess.sessionToken = sessionToken;
        sess.clients.add(deviceId);
        sess.clients.add(peerId);
        grantControl(deviceId, peerId);
        // 被控端据此切到 HostingView 并开始推流
        send(ws, { type: "SESSION_CREATED", sessionId, sessionToken, deviceId });
        send(peerWs, {
          type: "CONTROL_ACCEPTED",
          targetId: deviceId,
          sessionId,
          sessionToken,
          role: "client",
        });
        persistSessions();
        logger.info("control accepted (new ephemeral session)", {
          host: deviceId,
          peer: peerId,
          sessionId,
        });
      }
      break;
    }
    case "SCREEN_FRAME": {
      if (!deviceId) return;
      const sess = sessions.get(msg.sessionId);
      if (!sess) return;
      // 2026-10-04 补：原先只按 sessionId 找到会话就扇出，**不校验发送方是不是
      // 该会话的成员**。sessionId 是 8 位随机串不是密钥，但这仍意味着任何一个
      // 已注册设备，只要拿到/猜到 sessionId，就能往该会话里注入屏幕画面
      // （即伪造远端画面）。本仓的兄弟通道 INPUT_EVENT 与 WEBRTC_SIGNAL 都走了
      // canRelay 校验，只有这里漏了——三选一的漏检。
      // 口径与 canRelay 一致：host 本人、或 sess.clients 里的客户端，才算会话成员。
      const isMember = deviceId === sess.hostId || sess.clients.has(deviceId);
      if (!isMember) {
        logger.warn("screen frame rejected: not a session member", {
          from: deviceId,
          sessionId: msg.sessionId,
        });
        return;
      }
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
      if (!canRelay(targetId, deviceId, msg.sessionId)) {
        send(ws, { type: "CONTROL_FAILED", message: "未被授权控制该设备" });
        logger.warn("input event rejected", { from: deviceId, to: targetId });
        return;
      }
      const targetWs = clients.get(targetId);
      if (targetWs) {
        send(targetWs, {
          type: "INPUT_EVENT",
          event: msg.event,
          sessionId: msg.sessionId,
          fromId: deviceId,
        });
      }
      break;
    }
    case "GET_ONLINE_DEVICES": {
      send(ws, { type: "ONLINE_DEVICES", devices: listOnlineDevicesFor(user) });
      break;
    }
    case "WEBRTC_SIGNAL": {
      // SDP/ICE 一跳转发：服务端不理解内容，所以更得把"谁能把信令塞给谁"看住
      if (!deviceId) return;
      if (msg.kind !== "offer" && msg.kind !== "answer" && msg.kind !== "ice") return;
      if (typeof msg.sdp === "string" && msg.sdp.length > 65536) return;
      if (typeof msg.candidate === "string" && msg.candidate.length > 4096) return;
      const payload = {
        type: "WEBRTC_SIGNAL",
        kind: msg.kind,
        sdp: msg.sdp,
        candidate: msg.candidate ?? null,
        fromId: deviceId,
        sessionId: msg.sessionId,
      };
      if (msg.targetId) {
        // 媒体可能双向协商，所以两个方向里有一个是已授权的配对即可
        const paired =
          canRelay(msg.targetId, deviceId, msg.sessionId) ||
          canRelay(deviceId, msg.targetId, msg.sessionId);
        if (paired) send(clients.get(msg.targetId), payload);
        break;
      }
      const sess = sessions.get(msg.sessionId);
      if (!sess) break;
      if (deviceId !== sess.hostId && !sess.clients.has(deviceId)) break;
      const peers = new Set(sess.clients);
      if (sess.hostId) peers.add(sess.hostId);
      for (const pid of peers) {
        if (pid === deviceId) continue;
        send(clients.get(pid), payload);
      }
      break;
    }
    case "LEAVE_SESSION": {
      // 主动离开/结束会话（台账 S1-B18 / G6-1）。
      // 原实现里客户端 `closeSession()` 发的是一个 PONG 占位 —— 服务端什么都不做，
      // 于是「我点了结束会话」只是本地清屏：对端仍在会话里、服务端仍认为授权有效。
      // 现在：移除成员 + 撤销授权 + 广播 CLIENT_LEFT/SESSION_CLOSED，
      // 并且**给离开者回一个终态**，客户端据此才落 UI（不再靠猜）。
      if (!deviceId) return;
      const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
      const reason = typeof msg.reason === "string" ? msg.reason.slice(0, 200) : undefined;
      const sess = sid ? sessions.get(sid) : null;
      if (!sess) {
        // 幂等：会话已结束 / 本就不存在，也回终态，避免客户端停在「正在结束…」
        send(ws, { type: "SESSION_CLOSED", sessionId: sid, message: reason || "会话已结束" });
        return;
      }
      const isHost = sess.hostId === deviceId;
      if (!isHost && !sess.clients.has(deviceId)) {
        logger.warn("leave session rejected: not a member", { deviceId, sessionId: sid });
        send(ws, { type: "SESSION_CLOSED", sessionId: sid, message: "你不在该会话中" });
        return;
      }
      if (isHost) {
        // 主持人结束 ⇒ 整个会话结束（保留成员名单用于逐个通知）
        sessions.delete(sid);
        for (const cid of sess.clients) {
          if (cid === deviceId) continue;
          send(clients.get(cid), {
            type: "SESSION_CLOSED",
            sessionId: sid,
            message: "主持人已结束会话",
          });
        }
        send(ws, { type: "SESSION_CLOSED", sessionId: sid, message: "会话已结束" });
      } else {
        sess.clients.delete(deviceId);
        send(clients.get(sess.hostId), {
          type: "CLIENT_LEFT",
          sessionId: sid,
          clientId: deviceId,
          reason,
        });
        for (const cid of sess.clients) {
          send(clients.get(cid), { type: "CLIENT_LEFT", sessionId: sid, clientId: deviceId, reason });
        }
        send(ws, { type: "SESSION_CLOSED", sessionId: sid, message: "你已离开会话" });
      }
      // 离开即失去「可注入输入」的资格：不清授权的话，对方窗口还挂着也能继续操作
      dropGrantsFor(deviceId);
      persistSessions();
      logger.info("session left", { deviceId, sessionId: sid, hostLeft: isHost });
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
  const proto = TLS_ENABLED ? "wss" : "ws";
  logger.info("server listening", {
    addr: `${proto}://${HOST}:${PORT}`,
    auth: AUTH_TOKEN ? "shared-token (legacy)" : "user-account",
    tls: TLS_ENABLED ? "enabled" : "disabled",
    tokenTransport: WS_TOKEN_TRANSPORT,
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
