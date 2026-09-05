// 简单的 localStorage 包装，带 JSON 解析
//
// 在 localStorage 之外，关键状态还会写穿到 ~/.z-biz-tool-remote/state.json
// （见 services/persistentStorage.ts），确保 Tauri WebView 存储被清空后
// 下次启动依然能恢复登录态。

import {
  loadPersistentState,
  savePersistentState,
  type PersistentState,
} from "./persistentStorage";

const KEY_DEVICE_ID = "zbt-remote:deviceId";
const KEY_SETTINGS = "zbt-remote:settings";
const KEY_HISTORY = "zbt-remote:history";
const KEY_TRUSTED = "zbt-remote:trusted";
const KEY_AUTH = "zbt-remote:auth";
const KEY_SERVERS = "zbt-remote:servers";
const MAX_SERVER_PRESETS = 10;

let _persistReady = false;
let _persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 250;

function schedulePersist() {
  if (!_persistReady) return;
  if (typeof window === "undefined") return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    void persistNowInner();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistNowInner() {
  const state = snapshotState();
  await savePersistentState(state);
}

function snapshotState(): PersistentState {
  return {
    version: 1,
    auth: getAuth(),
    deviceId: getDeviceId() || null,
    serverUrl: getSettings().serverUrl || null,
    serverPresets: readServerPresets(),
    history: getHistory(),
    trusted: getTrusted(),
    settings: getSettings(),
    updatedAt: Date.now(),
  };
}

/**
 * Hydrate localStorage from ~/.z-biz-tool-remote/state.json.
 * Call this ONCE at app startup, before any other storage call.
 *
 * - If the disk has state: copy it into localStorage, return the loaded
 *   auth (or null) so the caller can decide whether to auto-restore.
 * - If the disk is empty: keep whatever is in localStorage (legacy data
 *   from older builds). The caller MUST then call persistNow() to seed
 *   the disk with the final state (after the deviceId is decided).
 *
 * Note: this function does NOT trigger an initial persist. The caller
 * owns that responsibility, because it must finalize the deviceId
 * before any disk write.
 */
export async function hydrateStorage(): Promise<{
  auth: AuthSession | null;
  deviceId: string | null;
}> {
  const disk = await loadPersistentState();
  if (disk) {
    if (disk.auth) localStorage.setItem(KEY_AUTH, JSON.stringify(disk.auth));
    if (disk.deviceId) localStorage.setItem(KEY_DEVICE_ID, disk.deviceId);
    if (disk.serverPresets && disk.serverPresets.length > 0) {
      // Migrate legacy entries that were stored with a ws:// prefix.
      const cleaned = disk.serverPresets.map((p) => ({
        ...p,
        url: displayUrl(p.url),
      })) as ServerPreset[];
      localStorage.setItem(KEY_SERVERS, JSON.stringify(cleaned));
    }
    if (disk.history && disk.history.length > 0) {
      localStorage.setItem(KEY_HISTORY, JSON.stringify(disk.history));
    }
    if (disk.trusted && disk.trusted.length > 0) {
      localStorage.setItem(KEY_TRUSTED, JSON.stringify(disk.trusted));
    }
    if (disk.settings) {
      // Strip the ws:// prefix from legacy serverUrl values so the UI
      // shows bare host:port from now on.
      const s = disk.settings;
      if (s.serverUrl) {
        s.serverUrl = displayUrl(s.serverUrl);
      }
      localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
    }
  }
  // Mark ready so subsequent setters schedule disk writes. Do NOT call
  // persistNowInner here — the caller needs to decide the deviceId first
  // (otherwise we'd snapshot an empty deviceId and lose it on first write).
  _persistReady = true;
  return {
    auth: disk?.auth ?? getAuth(),
    deviceId: disk?.deviceId ?? null,
  };
}

/** For tests / debug. */
export function _resetStorageForTests() {
  _persistReady = false;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = null;
}

/**
 * Force a write to ~/.z-biz-tool-remote/state.json now (no debounce).
 * Useful after synchronous multi-key changes (e.g. the server told us a
 * new deviceId; we need it on disk before the next launch).
 */
export async function persistNow(): Promise<void> {
  if (_persistTimer) {
    clearTimeout(_persistTimer);
    _persistTimer = null;
  }
  await persistNowInner();
}

export interface Settings {
  serverUrl: string;
  frameQuality: number; // 10-100
  fps: number; // 1-30
  language: "zh-CN" | "en-US";
  autoConnect: boolean;
  allowClipboardSync: boolean;
  allowFileTransfer: boolean;
  allowChat: boolean;
  requirePermission: boolean;
  reconnectInterval: number; // ms
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "101.37.80.51:8080",
  frameQuality: 80,
  fps: 15,
  language: "zh-CN",
  autoConnect: true,
  allowClipboardSync: true,
  allowFileTransfer: true,
  allowChat: true,
  requirePermission: true,
  reconnectInterval: 3000,
};

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY_DEVICE_ID);
  if (!id) {
    id = "dev-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem(KEY_DEVICE_ID, id);
    schedulePersist();
  }
  return id;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { id: string; username: string; createdAt: number };
}

export function getAuth(): AuthSession | null {
  const raw = localStorage.getItem(KEY_AUTH);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

export function setAuth(s: AuthSession | null) {
  if (!s) {
    localStorage.removeItem(KEY_AUTH);
  } else {
    localStorage.setItem(KEY_AUTH, JSON.stringify(s));
  }
  schedulePersist();
}

// ---------- server URL presets ----------

export interface ServerPreset {
  url: string;
  label?: string;
  lastUsedAt: number;
}

function readServerPresets(): ServerPreset[] {
  const raw = localStorage.getItem(KEY_SERVERS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p) => p && typeof p.url === "string" && p.url.length > 0
    ) as ServerPreset[];
  } catch {
    return [];
  }
}

function writeServerPresets(arr: ServerPreset[]) {
  localStorage.setItem(KEY_SERVERS, JSON.stringify(arr));
}

export function getServerPresets(): ServerPreset[] {
  return readServerPresets().sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// Bump a server URL to the top of the list. If `label` is provided, store it.
export function touchServer(url: string, label?: string) {
  if (!url) return;
  const clean = stripToken(url);
  if (!clean) return;
  const now = Date.now();
  const existing = readServerPresets();
  const filtered = existing.filter((p) => p.url !== clean);
  filtered.unshift({ url: clean, label, lastUsedAt: now });
  writeServerPresets(filtered.slice(0, MAX_SERVER_PRESETS));
  schedulePersist();
}

export function addServer(url: string, label?: string) {
  if (!url) return;
  const clean = stripToken(url);
  if (!clean) return;
  const existing = readServerPresets();
  if (existing.some((p) => p.url === clean)) {
    touchServer(clean, label);
    return;
  }
  const now = Date.now();
  existing.unshift({ url: clean, label, lastUsedAt: now });
  writeServerPresets(existing.slice(0, MAX_SERVER_PRESETS));
  schedulePersist();
}

export function removeServer(url: string) {
  const clean = stripToken(url);
  const existing = readServerPresets();
  writeServerPresets(existing.filter((p) => p.url !== clean));
  schedulePersist();
}

export function renameServer(url: string, label: string) {
  const clean = stripToken(url);
  const existing = readServerPresets();
  const i = existing.findIndex((p) => p.url === clean);
  if (i < 0) return;
  existing[i] = { ...existing[i], label };
  writeServerPresets(existing);
  schedulePersist();
}

// Strip the ws:// or wss:// protocol prefix. Users see a bare `host:port`
// because this is our private signaling protocol — the underlying transport
// is an internal detail, not something to expose.
function stripProtocol(rawUrl: string): string {
  if (!rawUrl) return "";
  return rawUrl.replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
}

// Strip ?token=… query string. The token is sourced from the auth store
// at connect time, so storing it in the URL is redundant + leaks into logs.
function stripToken(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("token");
    // Normalize: drop trailing "?" if nothing else
    const s = u.toString();
    return s.endsWith("?") ? s.slice(0, -1) : s;
  } catch {
    return rawUrl;
  }
}

// Public helper: present a URL in its display form
// (no ws:// / wss://, no ?token=…). Just `host[:port]`.
export function displayUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  const noToken = stripToken(rawUrl) ?? rawUrl;
  return stripProtocol(noToken);
}

/**
 * Build a `ws://…` URL from a stored `host:port` for the WebSocket client.
 * Always plain ws:// (LAN / self-hosted); for TLS, put a reverse proxy
 * (nginx/caddy) in front of the signaling server.
 */
export function toWsUrl(hostPort: string): string {
  const clean = stripProtocol(hostPort).trim();
  if (!clean) return "";
  return clean.startsWith("ws") ? hostPort : `ws://${clean}`;
}

export function getSettings(): Settings {
  const raw = localStorage.getItem(KEY_SETTINGS);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<Settings>) {
  const current = getSettings();
  const merged = { ...current, ...patch };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(merged));
  schedulePersist();
  return merged;
}

export interface HistoryRecord {
  sessionId: string;
  sessionToken?: string;
  role: "host" | "client";
  targetDeviceId?: string;
  at: number;
}

export function getHistory(): HistoryRecord[] {
  const raw = localStorage.getItem(KEY_HISTORY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function addHistory(rec: HistoryRecord) {
  const list = getHistory();
  list.unshift(rec);
  localStorage.setItem(KEY_HISTORY, JSON.stringify(list.slice(0, 50)));
  schedulePersist();
}

export function clearHistory() {
  localStorage.removeItem(KEY_HISTORY);
  schedulePersist();
}

export function getTrusted(): string[] {
  const raw = localStorage.getItem(KEY_TRUSTED);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function addTrusted(id: string) {
  const list = getTrusted();
  if (!list.includes(id)) {
    list.push(id);
    localStorage.setItem(KEY_TRUSTED, JSON.stringify(list));
    schedulePersist();
  }
}

export function removeTrusted(id: string) {
  const list = getTrusted().filter((x) => x !== id);
  localStorage.setItem(KEY_TRUSTED, JSON.stringify(list));
  schedulePersist();
}

export function isTrusted(id: string): boolean {
  return getTrusted().includes(id);
}
