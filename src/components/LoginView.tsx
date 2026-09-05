import { AutoComplete, Button, Card, Form, Input, Space, Switch, Tabs, Tag, Typography, message } from "antd";
import { ApiOutlined, DisconnectOutlined, UserAddOutlined, LoginOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { signaling } from "../services/signaling";
import { getAuth, getServerPresets, touchServer, displayUrl, type ServerPreset } from "../services/storage";
import * as api from "../services/api";
import { t } from "../i18n";

export function LoginView() {
  const { connection, deviceId, setConnection, lastError } = useSessionStore();
  const { settings, update } = useSettingsStore();
  // Always show the URL without any ?token=… (the token is sourced
  // from the auth store at connect time).
  const [serverUrl, setServerUrl] = useState(displayUrl(settings.serverUrl));
  const [autoConnect, setAutoConnect] = useState(settings.autoConnect);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(
    typeof navigator !== "undefined" ? (navigator as any).userAgentData?.platform || navigator.platform || "" : ""
  );
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [presets, setPresets] = useState<ServerPreset[]>([]);
  const lastConn = useRef<string | null>(null);

  // Refresh preset list whenever the field changes (so we can pick from the dropdown)
  useEffect(() => {
    setPresets(getServerPresets());
  }, [serverUrl]);

  useEffect(() => {
    const prev = lastConn.current;
    if (connection === "online" && prev !== "online") {
      message.success(t("toast.connected"));
    } else if (connection === "offline" && (prev === "online" || prev === "connecting")) {
      const detail = lastError ? `: ${lastError}` : "";
      message.error(t("toast.connectFailed") + detail, 6);
    }
    lastConn.current = connection;
  }, [connection, lastError]);

  // If we already have a saved auth + saved serverUrl, try to connect silently on mount.
  useEffect(() => {
    const auth = getAuth();
    if (auth && settings.autoConnect && connection === "offline") {
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: settings.serverUrl,
        deviceId,
        deviceName: deviceName || undefined,
        token: auth.accessToken,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const autoCompleteOptions = useMemo(
    () =>
      presets.map((p) => ({
        value: p.url,
        label: p.label ? `${p.label}  (${p.url})` : p.url,
      })),
    [presets]
  );

  async function doAuth() {
    const url = serverUrl.trim();
    if (!url) {
      message.error("请填写服务器地址");
      return;
    }
    // Must be ws:// or wss://. Just the host[:port], no path / token.
    if (!/^wss?:\/\/[^\s/?#]+(?::\d+)?\/?$/.test(url)) {
      message.error("服务器地址格式: ws://host:port 或 wss://host:port(或域名,如 wss://signaling.example.com)");
      return;
    }
    if (!/^[a-zA-Z0-9_\-]{3,32}$/.test(username)) {
      message.error("用户名 3-32 字符,只能含字母数字 _ -");
      return;
    }
    if (password.length < 6) {
      message.error("密码至少 6 位");
      return;
    }
    setBusy(true);
    try {
      const base = api.serverUrlToHttpBase(url);
      const sess =
        mode === "register"
          ? await api.register(base, username, password)
          : await api.login(base, username, password);
      // Bump this server to the top of the preset list so it shows up first next time
      touchServer(url, username.includes("@") ? undefined : undefined);
      update({ serverUrl: displayUrl(url), autoConnect });
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url,
        deviceId,
        deviceName: deviceName || sess.user.username,
        token: sess.accessToken,
      });
    } catch (e: any) {
      const status = e?.status;
      const body = e?.body as { error?: string } | undefined;
      const reason = body?.error || e?.message || "unknown";
      const hint = status === 401 ? "用户名或密码错" : status === 409 ? "用户名已存在" : "";
      message.error(`认证失败 (HTTP ${status ?? "?"}): ${reason}${hint ? " — " + hint : ""}`);
      setConnection("offline");
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doAuth();
  };

  const onDisconnect = () => {
    signaling.disconnect();
    setConnection("offline");
    message.info(t("toast.disconnected"));
  };

  return (
    <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Card style={{ width: 480 }} title={<Space><ApiOutlined /><span>{t("login.title")}</span></Space>}>
        <Form layout="vertical" onSubmitCapture={onSubmit}>
          <Form.Item label={t("login.server")} extra="下拉选择历史服务器,或直接输入新地址 (ws://host:port 或 wss://domain)">
            <AutoComplete
              value={serverUrl}
              onChange={(v) => setServerUrl(v)}
              options={autoCompleteOptions}
              disabled={connection === "online"}
              placeholder="ws://101.37.80.51:8080"
              filterOption={(input, opt) =>
                (opt?.value as string).toLowerCase().includes(input.toLowerCase()) ||
                (opt?.label as string || "").toLowerCase().includes(input.toLowerCase())
              }
              allowClear
            />
          </Form.Item>

          <Tabs
            activeKey={mode}
            onChange={(k) => setMode(k as "login" | "register")}
            items={[
              {
                key: "login",
                label: <span><LoginOutlined /> 登录</span>,
                children: null,
              },
              {
                key: "register",
                label: <span><UserAddOutlined /> 注册</span>,
                children: null,
              },
            ]}
          />

          <Form.Item label="用户名">
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice"
              autoComplete="username"
              disabled={connection === "online"}
            />
          </Form.Item>
          <Form.Item label="密码">
            <Input.Password
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              disabled={connection === "online"}
            />
          </Form.Item>
          {mode === "register" && (
            <Form.Item label="本机名称 (可选)">
              <Input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Alice 的 MacBook"
                maxLength={64}
                disabled={connection === "online"}
              />
            </Form.Item>
          )}

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
                htmlType="submit"
                icon={mode === "register" ? <UserAddOutlined /> : <LoginOutlined />}
                loading={busy}
                block
              >
                {mode === "register" ? "注册并连接" : "登录并连接"}
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
