import { useEffect, useState } from "react";
import { Button, Modal, Tooltip, message, theme } from "antd";
import { CopyOutlined, ReloadOutlined, PoweroffOutlined } from "@ant-design/icons";
import { useSessionStore } from "../stores/sessionStore";
import { signaling, type SocketState } from "../services/signaling";
import { t } from "../i18n";

export function ConnectionBar() {
  const { token } = theme.useToken();
  const { connection, deviceId, setView } = useSessionStore();
  const [state, setState] = useState<SocketState>(() => signaling.state);

  useEffect(() => {
    const off = signaling.on("state", setState);
    // 500ms 只刷这一小块，不牵动业务视图
    const id = window.setInterval(() => setState({ ...signaling.state }), 500);
    return () => {
      off();
      clearInterval(id);
    };
  }, []);

  const dotClass =
    connection === "online"
      ? "connection-dot online"
      : connection === "connecting" || connection === "reconnecting"
        ? "connection-dot connecting"
        : "connection-dot offline";

  let label =
    connection === "online"
      ? t("header.connected")
      : connection === "connecting"
        ? t("header.connecting")
        : t("header.offline");
  if (connection === "reconnecting") {
    const sec = Math.max(0, Math.ceil((state.retryInMs ?? 0) / 1000));
    label = state.reason?.includes("后台")
      ? t("header.pausedBackground")
      : t("header.reconnecting", { sec, n: state.attempt });
  } else if (connection === "failed") {
    label = `${t("header.failed")}${state.reason ? `：${state.reason}` : ""}`;
  }

  const doDisconnect = () => {
    signaling.disconnect();
    useSessionStore.getState().setConnection("offline");
    useSessionStore.getState().clearSession();
    setView({ kind: "login" });
  };

  // 断开是要重登的动作，先确认；取消是默认焦点，避免误触
  const onDisconnect = () => {
    Modal.confirm({
      title: "断开服务器连接？",
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          当前会话将立即结束，本机屏幕共享/远程控制都会停止；重新连接需要再次登录。
        </div>
      ),
      okText: "断开",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: doDisconnect,
    });
  };

  const onCopyDeviceId = async () => {
    if (!deviceId) {
      message.warning("设备ID尚未就绪，请等待注册完成");
      return;
    }
    try {
      await navigator.clipboard.writeText(deviceId);
      message.success("设备ID已复制到剪贴板");
    } catch (e) {
      // 浏览器剪贴板在非安全上下文会被拒；如实说，并把完整 ID 给出来
      message.error(
        `复制失败：${e instanceof Error ? e.message : String(e)}。完整设备ID：${deviceId}`,
        8
      );
    }
  };

  return (
    <div className="app-header">
      <div className="app-header-title">
        <span>{t("app.title")}</span>
        <span style={{ color: token.colorTextTertiary, fontWeight: 400, fontSize: 12 }}>{t("app.subtitle")}</span>
      </div>
      <div className="app-header-meta">
        <Tooltip title={state.reason ?? ""}>
          <span>
            <span className={dotClass} />
            {label}
            {state.rttMs != null && connection === "online" ? ` · ${state.rttMs}ms` : ""}
          </span>
        </Tooltip>
        {connection === "reconnecting" && (
          <Button size="small" icon={<ReloadOutlined />} onClick={() => signaling.retryNow()}>
            {t("header.retry")}
          </Button>
        )}
        {connection === "failed" && (
          <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => signaling.retryNow()}>
            {t("header.retry")}
          </Button>
        )}
        {(connection === "online" || connection === "reconnecting" || connection === "failed") && (
          <Button size="small" danger icon={<PoweroffOutlined />} onClick={onDisconnect}>
            {t("header.disconnect")}
          </Button>
        )}
        <Tooltip title={`复制设备ID：${deviceId || "—"}`}>
          <Button
            size="small"
            type="text"
            icon={<CopyOutlined />}
            onClick={onCopyDeviceId}
            aria-label="复制完整设备ID"
          >
            <span style={{ color: token.colorTextTertiary }}>{t("header.device")}:</span>
            <span style={{ fontFamily: "monospace", marginLeft: 4 }}>
              {deviceId ? `${deviceId.slice(0, 12)}…` : "—"}
            </span>
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
