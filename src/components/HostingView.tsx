import { Button, message } from "antd";
import { PoweroffOutlined, CopyOutlined } from "@ant-design/icons";
import { useEffect } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { startCaptureLoop, stopCaptureLoop } from "../services/capture";
import { t } from "../i18n";

export function HostingView() {
  const { sessionId, sessionToken, setView, setSession, setHosting } = useSessionStore();

  useEffect(() => {
    setHosting(true);
    startCaptureLoop();
    return () => {
      stopCaptureLoop();
      setHosting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStop = () => {
    stopCaptureLoop();
    setHosting(false);
    setSession({ sessionId: "", role: "host" });
    setView({ kind: "main" });
    message.info("会话已结束");
  };

  return (
    <div className="view-hosting">
      <h2>{t("hosting.title")}</h2>
      <div style={{ opacity: 0.85 }}>{t("hosting.shareHint")}</div>
      <div className="session-code">{sessionId || "—"}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ opacity: 0.85 }}>Token:</span>
        <span className="session-code" style={{ fontSize: 18, padding: "6px 12px" }}>
          {sessionToken || "—"}
        </span>
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (sessionToken) {
              navigator.clipboard.writeText(sessionToken).catch(() => {
                // ignore
              });
              message.success(t("toast.copied"));
            }
          }}
        />
      </div>
      <Button
        danger
        type="primary"
        icon={<PoweroffOutlined />}
        onClick={onStop}
        style={{ marginTop: 16 }}
      >
        {t("hosting.stop")}
      </Button>
    </div>
  );
}
