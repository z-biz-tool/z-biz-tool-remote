// JSON file persistence for z-biz-tool-remote-server.
//
// Single file at $DATA_FILE (default: ./data.json) holding users, sessions,
// and devices. Atomic writes via temp + rename so the file is never half-written
// even on crash. On startup, expired sessions are pruned.
//
// Schema:
//   {
//     version: 1,
//     users:   [{ id, username, passwordHash, passwordSalt, createdAt }],
//     sessions:[{ token, userId, refreshToken, expiresAt, refreshExpiresAt }],
//     devices: [{ id, userId, name, lastSeen, createdAt }],
//   }

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger.js";

const DATA_FILE = process.env.DATA_FILE || "";
const DEFAULT_PATH = "data.json";
const ACTIVE_FILE = DATA_FILE || DEFAULT_PATH;

const SCHEMA_VERSION = 1;

function emptyState() {
  return { version: SCHEMA_VERSION, users: [], sessions: [], devices: [] };
}

let state = emptyState();
let writeQueue = Promise.resolve();

function load() {
  if (!existsSync(ACTIVE_FILE)) {
    state = emptyState();
    persist();
    return;
  }
  try {
    const raw = readFileSync(ACTIVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    state = {
      version: parsed.version || SCHEMA_VERSION,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
    };
    logger.info("storage loaded", {
      file: ACTIVE_FILE,
      users: state.users.length,
      sessions: state.sessions.length,
      devices: state.devices.length,
    });
  } catch (e) {
    logger.error("storage load failed, starting empty", { err: String(e) });
    state = emptyState();
  }
}

function persist() {
  // Serialize writes — never overlap two fsyncs.
  writeQueue = writeQueue.then(() => doWrite()).catch((e) => {
    logger.error("storage write failed", { err: String(e) });
  });
  return writeQueue;
}

function doWrite() {
  mkdirSync(dirname(ACTIVE_FILE), { recursive: true });
  const tmp = ACTIVE_FILE + ".tmp." + process.pid + "." + Date.now();
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, ACTIVE_FILE);
}

load();

// ---------- public API ----------

export function getState() {
  return state;
}

// Users
export function findUserByUsername(username) {
  return state.users.find((u) => u.username === username) || null;
}
export function findUserById(id) {
  return state.users.find((u) => u.id === id) || null;
}
export function createUser({ id, username, passwordHash, passwordSalt, createdAt }) {
  state.users.push({ id, username, passwordHash, passwordSalt, createdAt });
  return persist().then(() => ({ id, username, createdAt }));
}

// Sessions
export function findSessionByToken(token) {
  if (!token) return null;
  const now = Date.now();
  return state.sessions.find((s) => s.token === token && s.expiresAt > now) || null;
}
export function findSessionByRefresh(refreshToken) {
  if (!refreshToken) return null;
  const now = Date.now();
  return state.sessions.find(
    (s) => s.refreshToken === refreshToken && s.refreshExpiresAt > now
  ) || null;
}
export function createSession(sess) {
  state.sessions.push(sess);
  return persist();
}
export function deleteSession(token) {
  state.sessions = state.sessions.filter((s) => s.token !== token);
  return persist();
}
export function pruneExpiredSessions() {
  const now = Date.now();
  const before = state.sessions.length;
  state.sessions = state.sessions.filter(
    (s) => s.expiresAt > now || s.refreshExpiresAt > now
  );
  if (state.sessions.length !== before) return persist();
  return Promise.resolve();
}

// Devices
export function findDevice(id) {
  return state.devices.find((d) => d.id === id) || null;
}
export function findDeviceByUserAndId(userId, deviceId) {
  return state.devices.find((d) => d.id === deviceId && d.userId === userId) || null;
}
export function listDevicesByUser(userId) {
  return state.devices.filter((d) => d.userId === userId);
}
export function upsertDevice({ id, userId, name, lastSeen, createdAt }) {
  const existing = state.devices.find((d) => d.id === id);
  if (existing) {
    existing.userId = userId;
    existing.name = name || existing.name;
    existing.lastSeen = lastSeen;
    if (!existing.createdAt) existing.createdAt = createdAt;
  } else {
    state.devices.push({ id, userId, name, lastSeen, createdAt });
  }
  return persist();
}
export function updateDevice(id, patch) {
  const d = state.devices.find((x) => x.id === id);
  if (!d) return Promise.resolve();
  Object.assign(d, patch);
  return persist();
}
export function deleteDevice(id) {
  state.devices = state.devices.filter((d) => d.id !== id);
  return persist();
}

// Background sweeper
export function startSweeper(intervalMs = 60_000) {
  setInterval(() => {
    pruneExpiredSessions().catch((e) =>
      logger.warn("sweeper error", { err: String(e) })
    );
  }, intervalMs).unref();
}
