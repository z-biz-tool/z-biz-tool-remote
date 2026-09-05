// 持久化到 ~/.z-biz-tool-remote/state.json 的能力
//
// 之所以不只用 localStorage: Tauri WebView 的 localStorage 在
// tauri.conf.json 的 origin 变化 / 某些重装场景下会被清空。把关键状态
// 写到 home 目录,即使 localStorage 没了,下次启动也能恢复登录态。

import { invoke } from "@tauri-apps/api/core";
import type {
  AuthSession,
  HistoryRecord,
  ServerPreset,
  Settings,
} from "./storage";

const STATE_VERSION = 1;

export interface PersistentState {
  version: number;
  auth: AuthSession | null;
  deviceId: string | null;
  serverUrl: string | null;
  serverPresets: ServerPreset[];
  history: HistoryRecord[];
  trusted: string[];
  settings: Partial<Settings> | null;
  updatedAt: number;
}

export const DEFAULT_STATE: PersistentState = {
  version: STATE_VERSION,
  auth: null,
  deviceId: null,
  serverUrl: null,
  serverPresets: [],
  history: [],
  trusted: [],
  settings: null,
  updatedAt: 0,
};

/**
 * Read state from ~/.z-biz-tool-remote/state.json.
 * Returns null if the file does not exist or is corrupt.
 *
 * Safe to call before the Tauri runtime is ready — if `invoke` throws
 * (e.g. running in plain `vite dev` without Tauri), returns null.
 */
export async function loadPersistentState(): Promise<PersistentState | null> {
  try {
    const raw = await invoke<PersistentStateRaw | null>("read_persistent_state");
    if (!raw) return null;
    return normalize(raw);
  } catch (e) {
    // Most likely running outside Tauri (vite dev / unit test).
    console.warn("[persistentStorage] load failed, falling back to localStorage", e);
    return null;
  }
}

export async function savePersistentState(state: PersistentState): Promise<void> {
  try {
    await invoke("write_persistent_state", { state });
  } catch (e) {
    console.error("[persistentStorage] save failed", e);
  }
}

export async function clearPersistentState(): Promise<void> {
  try {
    await invoke("clear_persistent_state");
  } catch (e) {
    console.error("[persistentStorage] clear failed", e);
  }
}

export async function getStatePath(): Promise<string | null> {
  try {
    return await invoke<string>("get_state_path");
  } catch {
    return null;
  }
}

// ----------------- internal -----------------

interface PersistentStateRaw {
  version?: number;
  auth?: AuthSession | null;
  // Rust uses #[serde(rename_all = "camelCase")] so these come back camelCase.
  deviceId?: string | null;
  serverUrl?: string | null;
  serverPresets?: ServerPreset[] | null;
  history?: HistoryRecord[] | null;
  trusted?: string[] | null;
  settings?: Partial<Settings> | null;
  updatedAt?: number;
}

function normalize(raw: PersistentStateRaw): PersistentState {
  return {
    version: typeof raw.version === "number" ? raw.version : STATE_VERSION,
    auth: raw.auth ?? null,
    deviceId: raw.deviceId ?? null,
    serverUrl: raw.serverUrl ?? null,
    serverPresets: Array.isArray(raw.serverPresets) ? raw.serverPresets : [],
    history: Array.isArray(raw.history) ? raw.history : [],
    trusted: Array.isArray(raw.trusted) ? raw.trusted : [],
    settings: raw.settings ?? null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}
