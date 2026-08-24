import { Button, Card, Form, Input, Space, Switch, Tag, Typography, message } from "antd";
import { ApiOutlined, DisconnectOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { signaling } from "../services/signaling";
import { t } from "../i18n";

export function LoginView() {
  const { connection, deviceId, setConnection } = useSessionStore();
  const { settings, update } = useSettingsStore();
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [autoConnect, setAutoConnect] = useState(settings.autoConnect);
  const [busy, setBusy] = useState(false);

  const onConnect = () => {
    update({ serverUrl: serverUrl.trim(), autoConnect });
    setConnection("connecting");
    setBusy(true);
    try {
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect(serverUrl.trim(), deviceId);
      message.success(t("toast.connected"));
    } catch (e) {
      message.error(t("toast.failed", { msg: String(e) }));
      setConnection("offline");
    } finally {
      setBusy(false);
    }
  };

  const onDisconnect = () => {
    signaling.disconnect();
    setConnection("offline");
    message.info(t("toast.disconnected"));
  };

  return (
    <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 480 }} title={<Space><ApiOutlined /><span>{t("login.title")}</span></Space>}>
        <Form layout="vertical">
          <Form.Item label={t("login.server")}>
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="ws://host:port"
              disabled={connection === "online"}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Switch checked={autoConnect} onChange={setAutoConnect} />
              <span>{t("login.autoConnect")}</span>
            </Space>
          </Form.Item>
          <Form.Item label={t("header.device")}>
            <Tag style={{ fontFamily: "monospace" }}>{deviceId}</Tag>
          </Form.Item>
          <Form.Item>
            {connection === "online" ? (
              <Button icon={<DisconnectOutlined />} onClick={onDisconnect} block>
                {t("login.disconnect")}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<ApiOutlined />}
                onClick={onConnect}
                loading={busy}
                block
              >
                {t("login.connect")}
              </Button>
            )}
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t("toast.connectedAs", { id: deviceId })}
          </Typography.Text>
        </Form>
      </Card>
    </div>
  );
}
