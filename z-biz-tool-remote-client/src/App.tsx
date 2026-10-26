import { App as AntdApp, ConfigProvider, Modal, message, Spin, theme } from "antd";
import { useEffect, useRef, useState } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { LoginView } from "./components/LoginView";
import { MainView } from "./components/MainView";
import { HostingView } from "./components/HostingView";
import { ControlView } from "./components/ControlView";
import { useSessionStore } from "./stores/sessionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { signaling } from "./services/signaling";
import { bindPeerRuntime, handleIncomingSignal, teardownPeer } from "./services/webrtc";
import { startStatsTicker, stopStatsTicker } from "./stores/statsStore";
import type { ConnectionState } from "./types";
import {
  addHistory,
  addTrusted,
  getAuth,
  getDeviceId,
  getSettings,
  hydrateStorage,
  isTrusted,
  persistNow,
  setAuth,
  describeWsUrl,
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
    setSession,
    setControlling,
    setLastError,
    setUser,
  } = useSessionStore();
  const [hydrated, setHydrated] = useState(false);
  const autoRestoreTried = useRef(false);
  const grantedPeers = useRef(new Set<string>());
  const clipboardWarned = useRef(false);
  // 注入失败（如 macOS 未授权辅助功能）只提示一次/10s，避免每个按键弹一次
  const inputErrorWarnedAt = useRef(0);

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
    // 地址连不了时（格式非法 / 公网地址写了明文 ws://）**不要**去连：
    // 连一个空地址只会得到一句看不懂的「连接失败」。
    const plan = describeWsUrl(settings.serverUrl);
    if (!plan.url) {
      message.warning(`自动连接已跳过：${plan.error ?? "服务器地址不可用"}`, 8);
      return;
    }
    const base = api.serverUrlToHttpBase(plan.url);

    const proceed = (accessToken: string) => {
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: plan.url,
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
    // 自动连接由上面的 auto-restore 处理；这里只挂事件与遥测
    // WebRTC 信令出口：会话内单播给已知对端，否则按 sessionId 广播给其余成员
    bindPeerRuntime({
      sendSignal: (payload) => {
        const s = useSessionStore.getState();
        if (!s.sessionId) return false;
        return signaling.sendWebrtcSignal(s.targetDeviceId ?? "", s.sessionId, payload);
      },
    });

    const offState = signaling.on("state", (st) => {
      const map: Record<string, ConnectionState> = {
        online: "online",
        connecting: "connecting",
        reconnecting: "reconnecting",
        failed: "failed",
        idle: "offline",
      };
      setConnection(map[st.phase] ?? "offline");
      if (st.phase === "failed" && st.reason) setLastError(st.reason);
    });
    const offError = signaling.on("error", (e) => {
      const msg = e instanceof Event ? `type=${e.type}` : String(e);
      console.error("ws error", e);
      setLastError(msg);
    });
    const offSignal = signaling.on("webrtc-signal", (payload) => {
      if (!payload.fromId) return;
      const s = useSessionStore.getState();
      if (payload.sessionId && s.sessionId && payload.sessionId !== s.sessionId) return;
      handleIncomingSignal(payload);
    });
    startStatsTicker();

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
          // ⚠️ 原先这里 `setEncryptionKey(msg.encryptionKey ?? null)` ——
          // 已按台账 S1-B09/B10 删除：那个字段不参与任何加解密，
          // 留着它只会让用户以为链路是加密的（实际是明文 JSON）。
          // 真正的防线是 TLS（wss://）。
          if (msg.userId && msg.username) {
            setUser({ userId: msg.userId, username: msg.username });
          }
          // 服务端改派了新 deviceId：必须如实告诉用户（否则「我的设备」里
          // 会莫名多出一台，而本机 id 悄悄变了）。
          if (msg.deviceIdReassigned) {
            message.warning(
              msg.deviceIdConflict
                ? `本机设备 ID 属于另一个账号，已改用新 ID：${msg.deviceId}`
                : `本机设备 ID 已在其他实例使用，已改用新 ID：${msg.deviceId}`,
              8
            );
          }
          setView({ kind: "main" });
          // 注册后自动请求一次在线列表
          signaling.getOnlineDevices();
          message.success(t("toast.connectedAs", { id: msg.deviceId ?? deviceId }));
          break;
        }
        case "SESSION_CREATED": {
          // For an explicit CREATE_SESSION: role=host, this device is hosting.
          // For an ephemeral "control my device" accept: role=host too, this
          // device accepted and now is the host of the new session.
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
          useSessionStore.getState().setHosting(true);
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
          // 加入成功必须真的进入控制视图（台账 S2-02）：原来只弹一句 toast，
          // 用户停在「远程会话」面板上，以为「加了但看不到画面」。
          setControlling(true);
          setView({
            kind: "controlling",
            sessionId: msg.sessionId,
            targetId: msg.hostId,
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
          // For ephemeral one-click control, the server returns real
          // sessionId/sessionToken/role so the requester can join the
          // session it just created.
          if (msg.sessionId && msg.sessionToken && msg.role === "client") {
            setSession({
              sessionId: msg.sessionId,
              role: "client",
              targetDeviceId: msg.targetId,
            });
            addHistory({
              sessionId: msg.sessionId,
              role: "client",
              targetDeviceId: msg.targetId,
              at: Date.now(),
            });
            // Auto-join the session so the host starts broadcasting and we
            // can start sending input.
            signaling.joinSession(msg.sessionId, msg.sessionToken);
            setControlling(true);
            setView({
              kind: "controlling",
              sessionId: msg.sessionId,
              targetId: msg.targetId,
            });
            message.success(t("toast.controlling", { id: msg.targetId }));
            break;
          }
          // Legacy explicit-session flow
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
          const isEphemeral =
            (msg as { ephemeral?: boolean }).ephemeral === true ||
            sessId.startsWith("auto-") ||
            sessId === "";
          const sameUser = (msg as { sameUser?: boolean }).sameUser === true;
          const accept = () => {
            signaling.acceptControl(fromId, sessId, isEphemeral);
            grantedPeers.current.add(fromId);
            useSessionStore.getState().setHosting(true);
            useSessionStore.getState().setController(fromId);
          };
          // Auto-accept (no dialog) in any of these cases:
          //   1. requester is in our trust list
          //   2. settings say no permission required
          //   3. server confirms both sides are owned by the same account
          //      (i.e. this is "my other device" asking to be controlled)
          if (isTrusted(fromId)) {
            accept();
            addTrusted(fromId);
            break;
          }
          if (!useSettingsStore.getState().settings.requirePermission) {
            accept();
            break;
          }
          if (sameUser) {
            accept();
            message.info(`已自动接受来自同账号设备 ${fromId} 的控制请求`);
            break;
          }
          Modal.confirm({
            title: t("dialog.controlRequest", { id: fromId }),
            okText: t("dialog.accept"),
            cancelText: t("dialog.reject"),
            // 放行陌生人控制整台电脑是高风险动作：默认焦点落在「拒绝」
            focusable: { autoFocusButton: "cancel" },
            onOk: accept,
            onCancel: () => {
              signaling.rejectControl(fromId, sessId, t("errors.permissionDenied"));
            },
          });
          break;
        }
        case "CLIENT_JOINED": {
          // 对方持有效 sessionToken 进来，服务端已验过；记为可投递输入的对端
          grantedPeers.current.add(msg.clientId);
          useSessionStore.getState().setController(msg.clientId);
          break;
        }
        case "CLIENT_LEFT": {
          // 对端主动离开（LEAVE_SESSION）：必须立刻收回它的输入资格，
          // 并让被控端看到「谁走了」，而不是继续显示「正在被控制」。
          grantedPeers.current.delete(msg.clientId);
          const st = useSessionStore.getState();
          if (st.controllerId === msg.clientId) st.setController(null);
          message.info(`对端 ${msg.clientId} 已离开会话${msg.reason ? `：${msg.reason}` : ""}`, 5);
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
          grantedPeers.current.clear();
          setView({ kind: "main" });
          message.info(msg.message ?? "会话已结束");
          break;
        }
        default:
          break;
      }
    });

    return () => {
      offState();
      offError();
      offSignal();
      offMessage();
      stopStatsTicker();
      teardownPeer("app-unmount");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 服务端没单独发 INPUT_EVENT 处理函数，这里在 host 端把收到的事件直接派发给 Rust
  useEffect(() => {
    const off = signaling.on("message", (msg) => {
      if (msg.type !== "INPUT_EVENT") return;
      const s = useSessionStore.getState();
      if (!s.isHosting) return;
      // 会话归属：事件必须属于**当前**会话（台账 C-19：原来只判 isHosting）
      if (msg.sessionId && s.sessionId && msg.sessionId !== s.sessionId) {
        console.warn("dropped INPUT_EVENT from another session", msg.sessionId);
        return;
      }
      // 已被控端「暂停输入」：必须真的挡住（台账 G4-6）
      if (s.inputPaused) return;
      // simulate_input 是真往操作系统里注事件，不能只信中继：只有这台机器明确
      // 接受过（CONTROL_ACCEPT）或验证过令牌（CLIENT_JOINED）的那个对端才行
      if (!msg.fromId || !grantedPeers.current.has(msg.fromId)) {
        console.warn("dropped INPUT_EVENT from ungranted peer", msg.fromId);
        return;
      }
      // 隐私开关要有真实效果（台账 C-07 / S2-08）：关掉剪贴板同步后，
      // 远端「粘贴」的文本不再注入；鼠标键盘不受影响。
      if (msg.event?.type === "key-type" && getSettings().allowClipboardSync === false) {
        if (!clipboardWarned.current) {
          clipboardWarned.current = true;
          message.warning("设置里已关闭「剪贴板同步」，远端粘贴内容已丢弃");
        }
        return;
      }
      invoke("simulate_input", { event: msg.event }).catch((e) => {
        // 注入失败必须让被控端看见：否则控制端"按键没反应"，两边都不知道为什么
        const now = Date.now();
        if (now - inputErrorWarnedAt.current > 10000) {
          inputErrorWarnedAt.current = now;
          message.error(
            `远端输入注入失败：${e instanceof Error ? e.message : String(e)}` +
              "（请检查系统辅助功能/输入监控权限）",
            8
          );
        }
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
        <Spin description="加载中..." />
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
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          colorBgBase: "#1a1a1a",
          colorBgContainer: "#232323",
          colorBgElevated: "#2a2a2a",
          colorBorder: "#333333",
          borderRadius: 6,
        },
      }}
    >
      <AntdApp>
        <div className="app-shell">
          <ConnectionBar />
          <div className="app-content">{content}</div>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}

function deviceNameHint(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return nav.userAgentData?.platform || nav.platform || "";
}
