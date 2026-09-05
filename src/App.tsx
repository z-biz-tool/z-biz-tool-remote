import { App as AntdApp, Modal, message, Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { LoginView } from "./components/LoginView";
import { MainView } from "./components/MainView";
import { HostingView } from "./components/HostingView";
import { ControlView } from "./components/ControlView";
import { useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { signaling } from "./services/signaling";
import {
  addHistory,
  addTrusted,
  getAuth,
  getDeviceId,
  hydrateStorage,
  isTrusted,
  persistNow,
  setAuth,
  toWsUrl,
} from "./services/storage";
import * as api from "./services/api";
import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";

const REFRESH_SKEW_MS = 30_000; // refresh 30s before actual expiry to avoid races

export default function App() {
  const {
    deviceId,
    view,
    setView,
    setConnection,
    setEncryptionKey,
    setSession,
    setControlling,
    setLastError,
    setUser,
  } = useSessionStore();
  const [hydrated, setHydrated] = useState(false);
  const autoRestoreTried = useRef(false);

  useEffect(() => {
    // 1) Hydrate from ~/.z-biz-tool-remote/state.json BEFORE showing
    //    any view, so LoginView's auto-connect effect sees the restored auth.
    let cancelled = false;
    (async () => {
      try {
        const { deviceId: diskId } = await hydrateStorage();
        // If the disk has a deviceId, use it. Otherwise generate one and
        // let getDeviceId() persist it via schedulePersist (called inside
        // the function). getDeviceId() reads localStorage first, so if
        // the disk was empty, the new id flows to disk on next persist.
        let id = diskId;
        if (!id) {
          id = getDeviceId();
        } else {
          // Make sure localStorage is in sync (in case it was wiped between
          // launches by the WebView).
          try {
            localStorage.setItem("zbt-remote:deviceId", id);
          } catch {
            // ignore
          }
        }
        if (!cancelled) useSessionStore.getState().setDeviceId(id);
        // First persist: seeds the disk with the post-hydration state
        // (including the deviceId we just decided). This must happen
        // AFTER setDeviceId, otherwise the disk would snapshot an empty
        // deviceId.
        void persistNow();
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2) Once hydration is done, if we have an auth token + saved server,
  //    try to auto-restore the connection.
  useEffect(() => {
    if (!hydrated || autoRestoreTried.current) return;
    autoRestoreTried.current = true;
    const auth = getAuth();
    if (!auth) return;
    const settings = useSettingsStore.getState().settings;
    if (!settings.autoConnect) return;
    if (!auth.refreshToken) return;

    // The access token may be expired. If so, refresh first so the WS
    // upgrade (which sends the access token) doesn't 401.
    const needsRefresh = !auth.accessToken || auth.expiresAt - REFRESH_SKEW_MS <= Date.now();
    const base = api.serverUrlToHttpBase(toWsUrl(settings.serverUrl));

    const proceed = (accessToken: string) => {
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: toWsUrl(settings.serverUrl),
        deviceId,
        deviceName: deviceNameHint() || undefined,
        token: accessToken,
      });
    };

    if (needsRefresh) {
      api
        .refresh(base, auth.refreshToken)
        .then((next) => {
          if (next) proceed(next.accessToken);
          else {
            setAuth(null);
            setConnection("offline");
            message.warning("登录已过期,请重新登录");
          }
        })
        .catch(() => {
          setConnection("offline");
        });
    } else {
      proceed(auth.accessToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  useEffect(() => {
    // Auto-connect is handled by App.tsx (see auto-restore above) after
    // hydration. Here we only wire up signaling event listeners.

    const offOpen = signaling.on("open", () => {
      setConnection("online");
    });
    const offClose = signaling.on("close", () => {
      setConnection("offline");
    });
    const offError = signaling.on("error", (e) => {
      const msg = e instanceof Event ? `type=${e.type}` : String(e);
      console.error("ws error", e);
      setLastError(msg);
    });

    const offMessage = signaling.on("message", (msg) => {
      switch (msg.type) {
        case "REGISTER_SUCCESS": {
          if (msg.deviceId) {
            useSessionStore.getState().setDeviceId(msg.deviceId);
            try {
              localStorage.setItem("zbt-remote:deviceId", msg.deviceId);
            } catch {
              // ignore
            }
            // Persist to ~/.z-biz-tool-remote/state.json so the deviceId
            // survives a Tauri WebView storage wipe.
            void persistNow();
          }
          setEncryptionKey(msg.encryptionKey ?? null);
          if (msg.userId && msg.username) {
            setUser({ userId: msg.userId, username: msg.username });
          }
          setView({ kind: "main" });
          // 注册后自动请求一次在线列表
          signaling.getOnlineDevices();
          message.success(t("toast.connectedAs", { id: msg.deviceId ?? deviceId }));
          break;
        }
        case "SESSION_CREATED": {
          setSession({
            sessionId: msg.sessionId,
            sessionToken: msg.sessionToken,
            role: "host",
          });
          addHistory({
            sessionId: msg.sessionId,
            sessionToken: msg.sessionToken,
            role: "host",
            at: Date.now(),
          });
          setView({ kind: "hosting", sessionId: msg.sessionId, sessionToken: msg.sessionToken });
          message.success(t("toast.hosting", { id: msg.sessionId }));
          break;
        }
        case "JOIN_SUCCESS": {
          setSession({
            sessionId: msg.sessionId,
            role: "client",
            targetDeviceId: msg.hostId,
          });
          addHistory({
            sessionId: msg.sessionId,
            role: "client",
            targetDeviceId: msg.hostId,
            at: Date.now(),
          });
          message.success(t("toast.controlling", { id: msg.hostId }));
          break;
        }
        case "JOIN_FAILED": {
          setSession({ sessionId: "", role: "client" });
          message.error(t("toast.failed", { msg: msg.message }));
          break;
        }
        case "CONTROL_ACCEPTED": {
          setSession({
            sessionId: useSessionStore.getState().sessionId ?? "",
            role: "client",
            targetDeviceId: msg.targetId,
          });
          setControlling(true);
          setView({ kind: "controlling", sessionId: useSessionStore.getState().sessionId ?? "", targetId: msg.targetId });
          break;
        }
        case "CONTROL_REJECTED": {
          message.warning(t("toast.rejected") + (msg.message ? `: ${msg.message}` : ""));
          break;
        }
        case "CONTROL_FAILED": {
          message.error(t("toast.failed", { msg: msg.message }));
          break;
        }
        case "CONTROL_REQUEST": {
          // 服务端推过来的"有人请求控制我"
          const fromId = (msg as { fromId?: string }).fromId;
          if (!fromId) break;
          const sessId = (msg as { sessionId?: string }).sessionId ?? "";
          if (isTrusted(fromId)) {
            signaling.acceptControl(fromId, sessId);
            useSessionStore.getState().setHosting(true);
            addTrusted(fromId);
            break;
          }
          if (!useSettingsStore.getState().settings.requirePermission) {
            signaling.acceptControl(fromId, sessId);
            useSessionStore.getState().setHosting(true);
            break;
          }
          Modal.confirm({
            title: t("dialog.controlRequest", { id: fromId }),
            okText: t("dialog.accept"),
            cancelText: t("dialog.reject"),
            onOk: () => {
              signaling.acceptControl(fromId, sessId);
              useSessionStore.getState().setHosting(true);
            },
            onCancel: () => {
              signaling.rejectControl(fromId, sessId, t("errors.permissionDenied"));
            },
          });
          break;
        }
        case "ONLINE_DEVICES": {
          useSessionStore.getState().setOnlineDevices(
            msg.devices
              .filter((d) => d.id !== useSessionStore.getState().deviceId)
              .map((d) => ({ id: d.id, name: d.name ?? d.id, online: d.online })),
          );
          break;
        }
        case "SESSION_CLOSED": {
          useSessionStore.getState().clearSession();
          setView({ kind: "main" });
          message.info(msg.message ?? "会话已结束");
          break;
        }
        default:
          break;
      }
    });

    return () => {
      offOpen();
      offClose();
      offError();
      offMessage();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 服务端没单独发 INPUT_EVENT 处理函数，这里在 host 端把收到的事件直接派发给 Rust
  useEffect(() => {
    const off = signaling.on("message", (msg) => {
      if (msg.type !== "INPUT_EVENT") return;
      const isHosting = useSessionStore.getState().isHosting;
      const requirePermission = useSettingsStore.getState().settings.requirePermission;
      if (!isHosting) return;
      if (requirePermission) {
        // 已在 CONTROL_REQUEST 阶段确认过；这里只信任已建立的会话
        // no-op
      }
      invoke("simulate_input", { event: msg.event }).catch((e) => {
        console.error("simulate_input failed", e);
      });
    });
    return off;
  }, []);

  let content: React.ReactNode;
  // While hydration is in flight, show a spinner so we never render the
  // login form with stale localStorage and immediately re-render it after
  // disk has been written.
  if (!hydrated) {
    content = (
      <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Spin tip="加载中..." />
      </div>
    );
  } else if (view.kind === "login") {
    content = <LoginView />;
  } else if (view.kind === "hosting") {
    content = <HostingView />;
  } else if (view.kind === "controlling") {
    content = <ControlView />;
  } else {
    content = <MainView />;
  }

  return (
    <AntdApp>
      <div className="app-shell">
        <ConnectionBar />
        <div className="app-content">{content}</div>
      </div>
    </AntdApp>
  );
}

function deviceNameHint(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return nav.userAgentData?.platform || nav.platform || "";
}
