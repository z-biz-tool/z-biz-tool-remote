import { App as AntdApp, Modal, message } from "antd";
import { useEffect } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { LoginView } from "./components/LoginView";
import { MainView } from "./components/MainView";
import { HostingView } from "./components/HostingView";
import { ControlView } from "./components/ControlView";
import { useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { signaling } from "./services/signaling";
import { addHistory, addTrusted, isTrusted } from "./services/storage";
import { t } from "./i18n";
import { invoke } from "@tauri-apps/api/core";

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

  useEffect(() => {
    // Auto-connect is handled by LoginView (it owns the auth token).
    // Here we only wire up signaling event listeners.

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
            useSessionStore.setState({ deviceId: msg.deviceId });
            try {
              localStorage.setItem("zbt-remote:deviceId", msg.deviceId);
            } catch {
              // ignore
            }
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
  // Use view.kind, NOT connection state, to decide which view to render.
  // Otherwise every WS disconnect (e.g. during 401 retry loop) would unmount
  // <LoginView/> and reset its useState(serverUrl) back to the stored URL,
  // clobbering whatever the user had just typed.
  if (view.kind === "login") {
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
