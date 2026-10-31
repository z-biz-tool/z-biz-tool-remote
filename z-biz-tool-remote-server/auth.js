// User account layer for z-biz-tool-remote-server.
//
// Provides:
//   - password hashing (scrypt)
//   - access + refresh token generation
//   - HTTP route handlers for /api/auth/* and /api/me, /api/devices/:id
//   - WS upgrade token validation (replaces legacy AUTH_TOKEN env)
//   - **registration gate**: per-IP rate limit + optional invite code
//     (自助注册曾经完全免鉴权、无限速 ⇒ 公网上可被无限灌号)
//
// Tokens are random 32-byte hex strings. Access token: 1h, refresh: 30d.
// Storage is delegated to storage.js (JSON file).

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";
import * as store from "./storage.js";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------- registration gate ----------
//
// 为什么注册端点必须有闸门：它曾经**完全免鉴权、无限速** —— 公网可达时
// 任何人都能自助灌账号（实测：连打 12 次全是 400 参数校验错，0 次 429/403）。
// 现在两道闸门，阈值全部走环境变量：
//
//   REGISTER_RATE_LIMIT     每个 IP 在一个窗口内允许的注册尝试次数（默认 5，0 = 关闭）
//   REGISTER_RATE_WINDOW_MS 窗口长度（默认 10 分钟）
//   INVITE_CODE             非空时，注册必须带上匹配的邀请码（默认空 = 不启用）
//
// 注意「限流必须排在参数校验**之前**」：否则攻击者一直用非法 body 打，
// 闸门永远数不到有效请求 —— 那正是原来「12 次全是 400」的原因。
const REGISTER_RATE_LIMIT = Number(process.env.REGISTER_RATE_LIMIT ?? 5);
const REGISTER_RATE_WINDOW_MS = Number(process.env.REGISTER_RATE_WINDOW_MS || 600_000);
const INVITE_CODE = process.env.INVITE_CODE || "";

/** ip -> { count, resetAt }（固定窗口计数器，进程内存态，重启即清空） */
const registerBuckets = new Map();

/** 取调用方 IP；取不到就归到 unknown（宁可共享一个桶，也不要绕过限流）。 */
export function clientIp(req) {
  const raw = req?.socket?.remoteAddress || req?.connection?.remoteAddress || "";
  // ::ffff:127.0.0.1 → 127.0.0.1
  return String(raw).replace(/^::ffff:/, "") || "unknown";
}

/**
 * 记一次注册尝试并判断是否超限。
 * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
 */
export function takeRegisterSlot(ip, now = Date.now()) {
  if (!Number.isFinite(REGISTER_RATE_LIMIT) || REGISTER_RATE_LIMIT <= 0) {
    return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 };
  }
  let bucket = registerBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + REGISTER_RATE_WINDOW_MS };
    registerBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  // 桶太多时顺手清掉过期的，免得长期运行把 map 撑大
  if (registerBuckets.size > 4096) {
    for (const [k, v] of registerBuckets) {
      if (now >= v.resetAt) registerBuckets.delete(k);
    }
  }
  const allowed = bucket.count <= REGISTER_RATE_LIMIT;
  return {
    allowed,
    remaining: Math.max(0, REGISTER_RATE_LIMIT - bucket.count),
    retryAfterMs: Math.max(0, bucket.resetAt - now),
  };
}

/** 邀请码比对（常量时间，避免逐字符比较泄露前缀）。未启用时恒为真。 */
export function inviteCodeMatches(provided) {
  if (!INVITE_CODE) return true;
  if (typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(INVITE_CODE, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function registrationGateEnabled() {
  return { inviteCode: Boolean(INVITE_CODE), rateLimit: REGISTER_RATE_LIMIT };
}

// ---------- crypto ----------

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return { passwordHash: hash.toString("hex"), passwordSalt: salt.toString("hex") };
}

export function verifyPassword(password, passwordHashHex, passwordSaltHex) {
  if (!passwordHashHex || !passwordSaltHex) return false;
  const salt = Buffer.from(passwordSaltHex, "hex");
  const expected = Buffer.from(passwordHashHex, "hex");
  const got = scryptSync(password, salt, expected.length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function newToken() {
  return randomBytes(32).toString("hex");
}

function newUserId() {
  return "u_" + randomBytes(8).toString("hex");
}

// ---------- token issuance ----------

export function issueSession(userId) {
  const token = newToken();
  const refreshToken = newToken();
  const now = Date.now();
  return store.createSession({
    token,
    refreshToken,
    userId,
    expiresAt: now + ACCESS_TTL_MS,
    refreshExpiresAt: now + REFRESH_TTL_MS,
    createdAt: now,
  }).then(() => ({ token, refreshToken, expiresAt: now + ACCESS_TTL_MS }));
}

export function rotateSession(oldRefreshToken) {
  const sess = store.findSessionByRefresh(oldRefreshToken);
  if (!sess) return null;
  // Invalidate old, issue new (token rotation)
  return store.deleteSession(sess.token).then(() => issueSession(sess.userId));
}

export function revokeSession(token) {
  return store.deleteSession(token);
}

export function tokenToUser(token) {
  const sess = store.findSessionByToken(token);
  if (!sess) return null;
  return store.findUserById(sess.userId);
}

// ---------- HTTP route handlers ----------
// Each handler takes (req, res) and resolves the body. JSON in/out.

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = body === undefined ? null : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(json);
}

function getBearer(req) {
  const h = req.headers["authorization"];
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  return "";
}

function requireAuth(req, res) {
  const token = getBearer(req);
  const user = tokenToUser(token);
  if (!user) {
    send(res, 401, { error: "unauthorized" });
    return null;
  }
  return { token, user };
}

// POST /api/auth/register
//
// 闸门顺序（**别改**）：
//   1) 按 IP 限流 —— 必须排在参数校验之前，否则非法 body 就能无限打进来；
//   2) 邀请码 —— 启用 INVITE_CODE 时必须带对的 inviteCode；
//   3) 参数校验 —— 最后才是 username / password 的形状。
export async function handleRegister(req, res) {
  const ip = clientIp(req);

  // 1) 限流
  const slot = takeRegisterSlot(ip);
  res.setHeader("X-RateLimit-Limit", String(Number.isFinite(REGISTER_RATE_LIMIT) ? REGISTER_RATE_LIMIT : 0));
  res.setHeader(
    "X-RateLimit-Remaining",
    String(Number.isFinite(slot.remaining) ? slot.remaining : 0)
  );
  if (!slot.allowed) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(slot.retryAfterMs / 1000))));
    logger.warn("register rate limited", { ip, limit: REGISTER_RATE_LIMIT });
    return send(res, 429, { error: "too many registration attempts" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }

  // 2) 邀请码
  if (!inviteCodeMatches(body.inviteCode)) {
    logger.warn("register rejected: invalid invite code", { ip });
    return send(res, 403, { error: "invite code required" });
  }

  // 3) 参数校验
  const { username, password } = body;
  if (
    typeof username !== "string" ||
    !/^[a-zA-Z0-9_\-]{3,32}$/.test(username)
  ) {
    return send(res, 400, { error: "username must match /^[a-zA-Z0-9_-]{3,32}$/" });
  }
  if (typeof password !== "string" || password.length < 6 || password.length > 200) {
    return send(res, 400, { error: "password must be 6-200 chars" });
  }
  if (store.findUserByUsername(username)) {
    return send(res, 409, { error: "username already taken" });
  }
  const { passwordHash, passwordSalt } = hashPassword(password);
  const id = newUserId();
  const now = Date.now();
  await store.createUser({ id, username, passwordHash, passwordSalt, createdAt: now });
  const sess = await issueSession(id);
  logger.info("user registered", { userId: id, username });
  send(res, 201, {
    user: { id, username, createdAt: now },
    accessToken: sess.token,
    refreshToken: sess.refreshToken,
    expiresAt: sess.expiresAt,
  });
}

// POST /api/auth/login
export async function handleLogin(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  const { username, password } = body;
  if (typeof username !== "string" || typeof password !== "string") {
    return send(res, 400, { error: "username and password required" });
  }
  const user = store.findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
    return send(res, 401, { error: "invalid username or password" });
  }
  const sess = await issueSession(user.id);
  logger.info("user login", { userId: user.id, username });
  send(res, 200, {
    user: { id: user.id, username: user.username, createdAt: user.createdAt },
    accessToken: sess.token,
    refreshToken: sess.refreshToken,
    expiresAt: sess.expiresAt,
  });
}

// ---------- ctc SSO ----------
//
// 信任模型（**别改**）：客户端只拿 ctc 的 access_token 过来，服务端**自己**拿它
// 去 ctc 的 userinfo 端点换身份。
//
// 为什么服务端必须自己去换：若客户端直接上报「我是 u_123」，那任何人都能冒充
// 任何人 —— 客户端上报的字段没有任何可信度。access_token 本身是 bearer 凭据，
// 只有 ctc 的 userinfo 能证明它此刻属于谁。
//
// 与账号密码登录的关系：两条路都发本服务自己的 session token。
// SSO 只是**多一种入口**，不是替代 —— ctc 挂了、没配、或者用户更习惯密码，
// 都不该让 remote 登不进去。这也正是「SSO 是可选的」在服务端的含义。

const SSO_AUTHORIZE_URL = process.env.SSO_AUTHORIZE_URL || "";
const SSO_TOKEN_URL = process.env.SSO_TOKEN_URL || "";
const SSO_USERINFO_URL = process.env.SSO_USERINFO_URL || "";
const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID || "";
const SSO_SCOPE = process.env.SSO_SCOPE || "openid profile email";

/** ctc 请求的超时。10 秒：SSO 是登录路径，挂住比失败更糟。 */
const SSO_TIMEOUT_MS = Number(process.env.SSO_TIMEOUT_MS || 10_000);

/** SSO 是否已启用（服务端配置齐全才算）。 */
export function ssoEnabled() {
  return Boolean(SSO_AUTHORIZE_URL && SSO_TOKEN_URL && SSO_USERINFO_URL && SSO_CLIENT_ID);
}

/**
 * GET /api/sso/config —— 下发 SSO 配置给客户端。
 *
 * 未启用时返回 204：客户端据此**不显示登录入口**，
 * 而不是显示一个点了必失败的按钮。
 *
 * 配置放服务端而不是烧进客户端二进制：ctc 换个域名不该需要给全家族客户端发版。
 */
export function handleSsoConfig(req, res) {
  if (!ssoEnabled()) {
    res.writeHead(204, { "cache-control": "no-store" });
    return res.end();
  }
  send(res, 200, {
    authorizeUrl: SSO_AUTHORIZE_URL,
    tokenUrl: SSO_TOKEN_URL,
    userInfoUrl: SSO_USERINFO_URL,
    clientId: SSO_CLIENT_ID,
    scope: SSO_SCOPE,
  });
}

/** 从 ctc 的 userinfo 响应里取出「能当用户名的」那段。 */
function deriveUsername(claims, id) {
  const fromClaims = claims.preferred_username || claims.username || claims.nickname;
  if (typeof fromClaims === "string" && /^[a-zA-Z0-9_\-]{3,32}$/.test(fromClaims)) {
    return fromClaims;
  }
  // claims 里的名字不合 remote 的用户名规则（中文名、带空格的显示名都很常见）——
  // 回退到基于 sub 的稳定后缀。稳定很重要：同一个 ctc 账号必须每次都得到
  // 同一个 remote 用户名，否则会重复建号。
  const suffix = String(id).replace(/[^a-zA-Z0-9]/g, "").slice(-12) || "sso";
  return `sso_${suffix}`;
}

/** 按 ctc 的 sub 找 / 建本地用户。sub 可能同时出现在 `ctcSubject` 字段里。 */
function findOrCreateSsoUser(claims, id) {
  const existing =
    store.findUserByCtcSubject(id) || store.findUserByUsername(deriveUsername(claims, id));
  if (existing) {
    // 已有账号但还没绑过 ctc subject（老账号用同一个用户名先注册过）——
    // 补绑，把这两条身份合成一个用户。
    if (!existing.ctcSubject) return store.updateUser(existing.id, { ctcSubject: id });
    return Promise.resolve(existing);
  }

  const now = Date.now();
  const newUser = {
    id: newUserId(),
    username: deriveUsername(claims, id),
    // SSO 用户没有密码 —— 两个字段都留空。
    // `verifyPassword` 在 hash 为空时返回 false，所以这类账号不能用密码登录，
    // 那正是我们想要的：凭证只在 ctc 那边。
    passwordHash: "",
    passwordSalt: "",
    ctcSubject: id,
    createdAt: now,
  };
  return store.createUser(newUser).then(() => newUser);
}

/**
 * POST /api/auth/sso —— 用 ctc 的 access_token 换 remote 的会话。
 *
 * 这条端点**不经过**注册闸门（限流 + 邀请码）：能通过 ctc 验证就说明
 * 这个人已经是 ctc 的成员了，而邀请码挡的是「陌生人自助注册」。
 * 限流仍由上游的 SSO_TIMEOUT / 常规 HTTP 层兜底。
 */
export async function handleSsoLogin(req, res) {
  if (!ssoEnabled()) {
    return send(res, 503, { error: "sso is not configured on this server" });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  const { ctcAccessToken } = body;
  if (typeof ctcAccessToken !== "string" || !ctcAccessToken) {
    return send(res, 400, { error: "ctcAccessToken required" });
  }

  // 服务端自己去 ctc 换身份 —— 见文件顶部的信任模型说明。
  let infoRes;
  try {
    infoRes = await fetch(SSO_USERINFO_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${ctcAccessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(SSO_TIMEOUT_MS),
    });
  } catch (e) {
    logger.warn("sso userinfo unreachable", { err: String(e) });
    return send(res, 502, { error: "sso identity service unreachable" });
  }

  if (!infoRes.ok) {
    // 401/403 = token 无效或已过期。这是**用户该看到的信息**，
    // 不是「服务器坏了」—— 前端据此提示「重新登录」。
    logger.warn("sso userinfo rejected token", { status: infoRes.status });
    return send(res, 401, { error: "sso token invalid or expired" });
  }

  let claims;
  try {
    claims = await infoRes.json();
  } catch {
    return send(res, 502, { error: "sso userinfo returned non-json" });
  }
  const sub = claims && claims.sub;
  if (typeof sub !== "string" || !sub) {
    logger.warn("sso userinfo missing sub", {});
    return send(res, 502, { error: "sso identity has no subject" });
  }

  const user = await findOrCreateSsoUser(claims, sub);
  const sess = await issueSession(user.id);
  logger.info("sso login", { userId: user.id, username: user.username });
  send(res, 200, {
    user: { id: user.id, username: user.username, createdAt: user.createdAt || Date.now() },
    accessToken: sess.token,
    refreshToken: sess.refreshToken,
    expiresAt: sess.expiresAt,
  });
}

// POST /api/auth/refresh
export async function handleRefresh(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  const { refreshToken } = body;
  if (typeof refreshToken !== "string") {
    return send(res, 400, { error: "refreshToken required" });
  }
  const rotated = await rotateSession(refreshToken);
  if (!rotated) return send(res, 401, { error: "invalid or expired refresh token" });
  send(res, 200, {
    accessToken: rotated.token,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
  });
}

// POST /api/auth/logout
export async function handleLogout(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  await revokeSession(auth.token);
  send(res, 204);
}

// GET /api/me
export async function handleMe(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const devices = store.listDevicesByUser(auth.user.id).map((d) => ({
    id: d.id,
    name: d.name || d.id,
    lastSeen: d.lastSeen,
    createdAt: d.createdAt,
  }));
  send(res, 200, {
    user: { id: auth.user.id, username: auth.user.username, createdAt: auth.user.createdAt },
    devices,
  });
}

// PATCH /api/devices/:id  { name }
export async function handlePatchDevice(req, res, deviceId) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!store.findDeviceByUserAndId(auth.user.id, deviceId)) {
    return send(res, 404, { error: "device not found" });
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
  const patch = {};
  if (typeof body.name === "string" && body.name.length > 0 && body.name.length <= 64) {
    patch.name = body.name;
  }
  await store.updateDevice(deviceId, patch);
  send(res, 200, { id: deviceId, ...patch });
}

// DELETE /api/devices/:id
export async function handleDeleteDevice(req, res, deviceId) {
  const auth = requireAuth(req, res);
  if (!auth) return;
  if (!store.findDeviceByUserAndId(auth.user.id, deviceId)) {
    return send(res, 404, { error: "device not found" });
  }
  await store.deleteDevice(deviceId);
  send(res, 204);
}

// Apply a device claim: called from WS REGISTER. Returns the device row.
export function claimDevice({ id, userId, name }) {
  const now = Date.now();
  const existing = store.findDevice(id);
  return store.upsertDevice({
    id,
    userId,
    name: name || (existing ? existing.name : null) || id,
    lastSeen: now,
    createdAt: existing ? existing.createdAt : now,
  });
}

export function touchDevice(id) {
  return store.updateDevice(id, { lastSeen: Date.now() });
}
