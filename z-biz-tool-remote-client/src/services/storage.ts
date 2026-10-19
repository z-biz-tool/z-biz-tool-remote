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
      // ⚠️ 同样**保留协议**（只清 token / 末尾斜杠）：
      // 剥掉协议会把显式的 `wss://` 抹成本机默认的 `ws://`。
      const cleaned = disk.serverPresets.map((p) => ({
        ...p,
        url: cleanAddress(p.url),
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
      const s = disk.settings;
      if (s.serverUrl) {
        // ⚠️ 这里**不能**剥掉协议。
        // 老实现用 `displayUrl` 剥协议，等于把用户显式写的 `wss://` 抹掉；
        // 而协议一旦丢了，本机地址会按默认回落成 `ws://`（明文）——
        // 正是「用户以为在用 TLS、实际连的是明文」那条老坑。
        // 现在只清掉 token / 末尾斜杠，协议原样保留。
        s.serverUrl = cleanAddress(s.serverUrl);
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
  /**
   * 单帧最大宽度(像素)。超过此宽度会按等比例缩放,显著降低带宽/卡顿。
   * 0 表示不缩放,直接输出显示器原生分辨率。
   */
  maxFrameWidth: number;
  language: "zh-CN" | "en-US";
  autoConnect: boolean;
  allowClipboardSync: boolean;
  allowFileTransfer: boolean;
  allowChat: boolean;
  requirePermission: boolean;
  reconnectInterval: number; // ms
}

/** 用户可选的"最大宽度"档位。0 = 原生(不缩放)。 */
export const FRAME_WIDTH_OPTIONS = [640, 960, 1280, 1600, 1920, 0] as const;
export type FrameWidthOption = (typeof FRAME_WIDTH_OPTIONS)[number];

export const DEFAULT_SETTINGS: Settings = {
  // ⚠️ 不要在这里写死任何公网地址（台账 S1-B11）：
  // 写死了一个公网 IP，等于把「所有安装都默认连到某台机器」这件事
  // 固化进每一个二进制。服务端地址由用户在登录界面填写。
  serverUrl: "",
  frameQuality: 80,
  fps: 15,
  // 2K/Retina 显示器原生分辨率单帧可达 200~500KB,经 WebSocket 传输后带宽吃紧。
  // 默认降到 1280 宽,大多数场景下画质肉眼无差、帧大小通常 <60KB。
  maxFrameWidth: 1280,
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
  const clean = cleanAddress(url);
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
  const clean = cleanAddress(url);
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
  const clean = cleanAddress(url);
  const existing = readServerPresets();
  writeServerPresets(existing.filter((p) => p.url !== clean));
  schedulePersist();
}

export function renameServer(url: string, label: string) {
  const clean = cleanAddress(url);
  const existing = readServerPresets();
  const i = existing.findIndex((p) => p.url === clean);
  if (i < 0) return;
  existing[i] = { ...existing[i], label };
  writeServerPresets(existing);
  schedulePersist();
}

// ---------- 服务器地址 ----------
//
// ⚠️ 这里是本仓最大的安全缺口所在（台账 P0-1 / S1-B11）。
//
// 原实现把「协议」当成不可见的内部细节：显示时剥掉、存储时剥掉、
// 连接时恒定拼 `ws://` —— 于是**用户没有任何地方能表达「用 TLS」**：
// 哪怕在设置里显式填 `wss://example.com`，实际连的仍是明文 `ws://`。
// 而屏幕像素与键鼠事件都走这条链路，账号令牌也在同一条链路的 URL 查询串里，
// 公网上的明文等于把画面、按键、令牌一起裸奔给旁路监听。
//
// 现在按台账 S1-B11 的验收标准执行：
//   · **公网地址默认 wss://**（安全默认）
//   · **明文 ws:// 只允许本机**（localhost / 127.0.0.0/8 / ::1 / *.local）—— 本地开发豁免
//   · 其余情况写明文 ws:// → **拒绝并提示**（返回空串 + 可读的拒绝原因）
//   · 用户显式写了 wss:// → **原样保留**，绝不降级
//   · 非法输入 → 空串

/** 剥掉 ws:// / wss:// 前缀。 */
function stripProtocol(rawUrl: string): string {
  if (!rawUrl) return "";
  return rawUrl.trim().replace(/^wss?:\/\//i, "").replace(/^\/+|\/+$/g, "");
}

/** 取出地址里**显式写出的**协议；没写返回 null。 */
export function parseScheme(rawUrl: string): "ws" | "wss" | null {
  const m = /^(wss?):\/\//i.exec((rawUrl ?? "").trim());
  if (!m) return null;
  return m[1].toLowerCase() === "wss" ? "wss" : "ws";
}

/** 去掉查询串（?token=… 之类）与末尾斜杠；**保留协议**。 */
export function cleanAddress(rawUrl: string): string {
  const s = (rawUrl ?? "").trim();
  if (!s) return "";
  const q = s.indexOf("?");
  return (q >= 0 ? s.slice(0, q) : s).replace(/\/+$/, "");
}

/** 只取主机名部分（去掉端口与 IPv6 方括号）。 */
function hostOnly(address: string): string {
  let h = stripProtocol(address).toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  const i = h.indexOf(":");
  return i > 0 ? h.slice(0, i) : h;
}

/**
 * 是不是**本机**（明文 ws:// 的唯一合法豁免范围）。
 *
 * 覆盖：localhost、127.0.0.0/8 整个回环段、::1、以及 *.local（mDNS 自建服务）。
 */
export function isLocalHost(address: string): boolean {
  const h = hostOnly(address);
  if (!h) return false;
  if (h === "localhost" || h === "::1") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

/** 端口是否在合法区间（1–65535）。 */
function isValidPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** 地址本体（主机名[:端口]）是否合法。 */
function isValidAddress(bare: string): boolean {
  if (!bare) return false;
  // IPv6：[::1]:8080
  // ⚠️ 端口的捕获组**不能**把冒号一起吃掉：`:(\d+)` 捕获到的是 "8443"，
  //    而 `(:\d+)` 捕获到的是 ":8443" —— 后者 `Number()` 得 NaN，
  //    会让所有带端口的合法地址都被判为「格式不正确」。
  const v6 = /^\[([0-9a-fA-F:]+)\](?::(\d{1,5}))?$/.exec(bare);
  if (v6) return v6[2] === undefined || isValidPort(v6[2]);
  const m = /^([a-zA-Z0-9._-]+)(?::(\d{1,5}))?$/.exec(bare);
  if (!m) return false;
  return m[2] === undefined || isValidPort(m[2]);
}

// Public helper: present a URL in its display form
// (no ws:// / wss://, no ?token=…). Just `host[:port]`.
export function displayUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  return stripProtocol(cleanAddress(rawUrl));
}

export interface WsUrlPlan {
  /** 实际要连的地址；空串表示连不了。 */
  url: string;
  /** 是否受 TLS 保护。 */
  secure: boolean;
  /** 连不了的原因（给界面提示用）；null 表示没问题。 */
  error: string | null;
}

/**
 * 决定「这个地址到底该怎么连」——**全仓唯一**决定 WebSocket 协议的地方。
 *
 * 规则见本文件头（S1-B11）：
 *   · 显式 `wss://` → 原样保留
 *   · 显式 `ws://`  → 仅本机允许；其它一律拒绝并给出可操作的提示
 *   · 没写协议      → 本机 `ws://`，公网 `wss://`（安全默认）
 *   · 非法输入      → 拒绝
 */
export function describeWsUrl(address: string): WsUrlPlan {
  const raw = cleanAddress(address);
  if (!raw) {
    return { url: "", secure: false, error: "请填写服务器地址" };
  }
  const scheme = parseScheme(raw);
  const bare = stripProtocol(raw);
  if (!isValidAddress(bare)) {
    return {
      url: "",
      secure: false,
      error: "地址格式不正确：应为 host:port（如 example.com:8443）或 IP:端口",
    };
  }
  if (scheme === "wss") {
    return { url: `wss://${bare}`, secure: true, error: null };
  }
  if (scheme === "ws") {
    if (!isLocalHost(bare)) {
      return {
        url: "",
        secure: false,
        error:
          "公网地址不允许明文 ws://：屏幕画面与键鼠事件会明文过网。" +
          "请去掉 ws:// 改用 TLS（wss://），或把服务端的 TLS_KEY_PATH / TLS_CERT_PATH 配好。",
      };
    }
    return { url: `ws://${bare}`, secure: false, error: null };
  }
  // 没写协议：公网默认 TLS（安全默认），本机默认明文（本地开发豁免）
  if (isLocalHost(bare)) {
    return { url: `ws://${bare}`, secure: false, error: null };
  }
  return { url: `wss://${bare}`, secure: true, error: null };
}

/**
 * 由地址算出实际要连的 WebSocket URL；连不了时返回空串。
 *
 * ⚠️ 不要再写「先剥协议、再恒拼 `ws://`」那种实现 —— 那正是 P0-1 的根因：
 * 用户显式填 `wss://example.com` 也会被降级成明文，而屏幕画面与键鼠事件
 * 都走这条链路。协议由 `describeWsUrl` 统一裁决。
 */
export function toWsUrl(address: string): string {
  return describeWsUrl(address).url;
}

/**
 * 这条信令连接**是否受 TLS 保护**。
 *
 * 为什么需要它：屏幕像素与键鼠事件都走这条 WebSocket。
 * 没有 TLS 时它们是**明文过公网**的 —— 而账号令牌也在同一条链路的 URL 查询串里，
 * 所以「在带内再套一层加密」是自欺欺人（窃听者连密钥一起看到）。
 * **唯一真正的防线是 TLS**，界面必须把这件事如实告诉用户。
 */
export function isSecureTransport(wsUrl: string): boolean {
  return /^wss:\/\//i.test((wsUrl ?? "").trim());
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
