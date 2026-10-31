import { create } from "zustand";
import type { ConnectionState, OnlineDevice, View } from "../types";

interface SessionStore {
  deviceId: string;
  view: View;
  connection: ConnectionState;
  onlineDevices: OnlineDevice[];
  lastError: string | null;
  // User account (after login)
  userId: string | null;
  username: string | null;

  // 当前会话上下文
  sessionId: string | null;
  sessionToken: string | null;
  role: "host" | "client" | null;
  targetDeviceId: string | null;

  // 截屏 / 输入节流
  isHosting: boolean; // 自己是被控端，正在广播屏幕
  isControlling: boolean; // 自己是控制端，正在控制别人
  isPaused: boolean; // 控制端暂停接收帧
  // 被控端「暂停输入」：置真时丢弃远端发来的键鼠事件（本机夺回控制权）
  inputPaused: boolean;
  // 被控端视角：当前被哪个对端控制（null = 尚无对端）
  controllerId: string | null;
  controllerSince: number | null;

  setView: (v: View) => void;
  setConnection: (s: ConnectionState) => void;
  setOnlineDevices: (d: OnlineDevice[]) => void;
  setLastError: (e: string | null) => void;
  setUser: (u: { userId: string; username: string } | null) => void;
  setDeviceId: (id: string) => void;
  setSession: (info: { sessionId: string; sessionToken?: string; role: "host" | "client"; targetDeviceId?: string }) => void;
  clearSession: () => void;
  setHosting: (v: boolean) => void;
  setControlling: (v: boolean) => void;
  setPaused: (v: boolean) => void;
  setInputPaused: (v: boolean) => void;
  setController: (id: string | null, since?: number | null) => void;
  /**
   * 深链（zbiz://remote/open?device=…）带来的设备定位意图。
   *
   * 主界面 MainView 消费它：把设备列表的搜索框填成这个值，然后清掉。
   * 放在 store 里而不是 App 本地 state，是因为 MainView 是被条件渲染的
   * （view.kind === "main" 才挂载）——深链可能比它更早到达。
   */
  deepLinkDeviceQuery: string | null;
  setDeepLinkDeviceQuery: (q: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  // deviceId is empty at module load and is filled in by App.tsx after
  // hydration (so that the disk-loaded id wins over a fresh random one).
  deviceId: "",
  view: { kind: "login" },
  connection: "offline",
  onlineDevices: [],
  lastError: null,
  userId: null,
  username: null,
  sessionId: null,
  sessionToken: null,
  role: null,
  targetDeviceId: null,
  isHosting: false,
  isControlling: false,
  isPaused: false,
  inputPaused: false,
  controllerId: null,
  controllerSince: null,
  deepLinkDeviceQuery: null,

  setView: (view) => set({ view }),
  setConnection: (connection) => set({ connection }),
  setOnlineDevices: (onlineDevices) => set({ onlineDevices }),
  setLastError: (lastError) => set({ lastError }),
  setUser: (u) => set(u ? { userId: u.userId, username: u.username } : { userId: null, username: null }),
  setDeviceId: (deviceId) => set({ deviceId }),
  setSession: ({ sessionId, sessionToken, role, targetDeviceId }) =>
    set({ sessionId, sessionToken: sessionToken ?? null, role, targetDeviceId: targetDeviceId ?? null }),
  clearSession: () =>
    set({
      sessionId: null,
      sessionToken: null,
      role: null,
      targetDeviceId: null,
      isHosting: false,
      isControlling: false,
      isPaused: false,
      inputPaused: false,
      controllerId: null,
      controllerSince: null,
    }),
  setHosting: (isHosting) => set({ isHosting }),
  setControlling: (isControlling) => set({ isControlling }),
  setPaused: (isPaused) => set({ isPaused }),
  setInputPaused: (inputPaused) => set({ inputPaused }),
  setController: (controllerId, since) =>
    set({ controllerId, controllerSince: controllerId ? (since ?? Date.now()) : null }),
  setDeepLinkDeviceQuery: (deepLinkDeviceQuery) => set({ deepLinkDeviceQuery }),
}));
