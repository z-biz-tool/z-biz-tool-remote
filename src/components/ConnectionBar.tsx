import { Tooltip } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useSessionStore } from "../stores/sessionStore";
import { t } from "../i18n";

export function ConnectionBar() {
  const { connection, deviceId } = useSessionStore();
  const dotClass =
    connection === "online"
      ? "connection-dot online"
      : connection === "connecting"
        ? "connection-dot connecting"
        : "connection-dot offline";
  const label =
    connection === "online"
      ? t("header.connected")
      : connection === "connecting"
        ? t("header.connecting")
        : t("header.offline");

  return (
    <div className="app-header">
      <div className="app-header-title">
        <span>{t("app.title")}</span>
        <span style={{ color: "#999", fontWeight: 400, fontSize: 12 }}>
          {t("app.subtitle")}
        </span>
      </div>
      <div className="app-header-meta">
        <span>
          <span className={dotClass} />
          {label}
        </span>
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
