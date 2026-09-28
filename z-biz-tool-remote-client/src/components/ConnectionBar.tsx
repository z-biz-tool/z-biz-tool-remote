import { useEffect, useState } from "react";
import { Button, Tooltip } from "antd";
import { CopyOutlined, ReloadOutlined, PoweroffOutlined } from "@ant-design/icons";
import { useSessionStore } from "../stores/sessionStore";
import { signaling, type SocketState } from "../services/signaling";
import { t } from "../i18n";

export function ConnectionBar() {
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

  const onDisconnect = () => {
    signaling.disconnect();
    useSessionStore.getState().setConnection("offline");
    useSessionStore.getState().clearSession();
    setView({ kind: "login" });
  };

  return (
    <div className="app-header">
      <div className="app-header-title">
        <span>{t("app.title")}</span>
        <span style={{ color: "#999", fontWeight: 400, fontSize: 12 }}>{t("app.subtitle")}</span>
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
        <Tooltip title={t("toast.copied")}>
          <span
            className="device-id-copy"
            onClick={() => {
              navigator.clipboard.writeText(deviceId).catch(() => {
                // ignore
              });
            }}
          >
            <span style={{ color: "#999" }}>{t("header.device")}:</span>
            <span style={{ fontFamily: "monospace" }}>{deviceId.slice(0, 12)}…</span>
            <CopyOutlined />
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
