// 简单的 localStorage 包装，带 JSON 解析

const KEY_DEVICE_ID = "zbt-remote:deviceId";
const KEY_SETTINGS = "zbt-remote:settings";
const KEY_HISTORY = "zbt-remote:history";
const KEY_TRUSTED = "zbt-remote:trusted";
const KEY_AUTH = "zbt-remote:auth";

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
  serverUrl: "ws://101.37.80.51:8080",
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
}

export function clearHistory() {
  localStorage.removeItem(KEY_HISTORY);
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
  }
}

export function removeTrusted(id: string) {
  const list = getTrusted().filter((x) => x !== id);
  localStorage.setItem(KEY_TRUSTED, JSON.stringify(list));
}

export function isTrusted(id: string): boolean {
  return getTrusted().includes(id);
}
