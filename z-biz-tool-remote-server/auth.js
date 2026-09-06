// User account layer for z-biz-tool-remote-server.
//
// Provides:
//   - password hashing (scrypt)
//   - access + refresh token generation
//   - HTTP route handlers for /api/auth/* and /api/me, /api/devices/:id
//   - WS upgrade token validation (replaces legacy AUTH_TOKEN env)
//
// Tokens are random 32-byte hex strings. Access token: 1h, refresh: 30d.
// Storage is delegated to storage.js (JSON file).

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";
import * as store from "./storage.js";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
export async function handleRegister(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "invalid json" });
  }
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
