import { create } from "zustand";
import type { ConnectionState, OnlineDevice, View } from "../types";
import { getDeviceId } from "../services/storage";

interface SessionStore {
  deviceId: string;
  view: View;
  connection: ConnectionState;
  onlineDevices: OnlineDevice[];
  encryptionKey: string | null;

  // 当前会话上下文
  sessionId: string | null;
  sessionToken: string | null;
  role: "host" | "client" | null;
  targetDeviceId: string | null;

  // 截屏 / 输入节流
  isHosting: boolean; // 自己是被控端，正在广播屏幕
  isControlling: boolean; // 自己是控制端，正在控制别人
  isPaused: boolean; // 控制端暂停接收帧

  setView: (v: View) => void;
  setConnection: (s: ConnectionState) => void;
  setOnlineDevices: (d: OnlineDevice[]) => void;
  setEncryptionKey: (k: string | null) => void;
  setSession: (info: { sessionId: string; sessionToken?: string; role: "host" | "client"; targetDeviceId?: string }) => void;
  clearSession: () => void;
  setHosting: (v: boolean) => void;
  setControlling: (v: boolean) => void;
  setPaused: (v: boolean) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  deviceId: getDeviceId(),
  view: { kind: "login" },
  connection: "offline",
  onlineDevices: [],
  encryptionKey: null,
  sessionId: null,
  sessionToken: null,
  role: null,
  targetDeviceId: null,
  isHosting: false,
  isControlling: false,
  isPaused: false,

  setView: (view) => set({ view }),
  setConnection: (connection) => set({ connection }),
  setOnlineDevices: (onlineDevices) => set({ onlineDevices }),
  setEncryptionKey: (encryptionKey) => set({ encryptionKey }),
  setSession: ({ sessionId, sessionToken, role, targetDeviceId }) =>
    set({ sessionId, sessionToken: sessionToken ?? null, role, targetDeviceId: targetDeviceId ?? null }),
  clearSession: () =>
    set({ sessionId: null, sessionToken: null, role: null, targetDeviceId: null, isHosting: false, isControlling: false, isPaused: false }),
  setHosting: (isHosting) => set({ isHosting }),
  setControlling: (isControlling) => set({ isControlling }),
  setPaused: (isPaused) => set({ isPaused }),
}));
