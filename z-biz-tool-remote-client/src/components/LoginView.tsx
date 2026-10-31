import { Alert, AutoComplete, Button, Card, Form, Input, Space, Switch, Tabs, Tag, Typography, message } from "antd";
import { ApiOutlined, DisconnectOutlined, UserAddOutlined, LoginOutlined, IdcardOutlined } from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { signaling } from "../services/signaling";
import { getAuth, getServerPresets, touchServer, displayUrl, cleanAddress, describeWsUrl, type ServerPreset } from "../services/storage";
import * as api from "../services/api";
import {
  exchangeForRemoteSession,
  fetchSsoConfig,
  secureStoreAvailable,
  ssoSessionStore,
  startSsoLogin,
  type SsoServerConfig,
} from "../services/sso";
import { t } from "../i18n";

export function LoginView() {
  const { connection, deviceId, setConnection, lastError } = useSessionStore();
  const { settings, update } = useSettingsStore();
  // 服务器地址。**按用户写的原样保留**（可以带 wss:// / ws:// 前缀）：
  // 剥掉协议就等于抹掉「用户主动要求了 TLS」这件事，
  // 而本机地址在缺省时会回落成 ws://（明文）—— 那就又回到老坑了。
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  /**
   * 传输方式**不是**"内部实现细节"，也不是可以随便勾的开关。
   *
   * 屏幕像素与键鼠事件都走这条 WebSocket，公网上的明文 ws:// 等于把画面和按键
   * 直接暴露给旁路监听；账号令牌也在同一条链路的 URL 查询串里，所以"带内再套
   * 一层加密"是自欺欺人 —— **唯一真正的防线是 TLS**。
   *
   * 所以这里**如实显示**「按这个地址实际会怎么连」，而不是让用户选一个
   * 与实际连接不一致的选项。裁决规则见 storage.ts::describeWsUrl。
   */
  const transport = useMemo(() => describeWsUrl(serverUrl), [serverUrl]);
  const [autoConnect, setAutoConnect] = useState(settings.autoConnect);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // 邀请码：服务端开了 INVITE_CODE 时注册必须带上；没开就留空
  const [inviteCode, setInviteCode] = useState("");
  const [deviceName, setDeviceName] = useState(
    typeof navigator !== "undefined" ? (navigator as any).userAgentData?.platform || navigator.platform || "" : ""
  );
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [presets, setPresets] = useState<ServerPreset[]>([]);
  const lastConn = useRef<string | null>(null);

  // ctc SSO —— **可选**：只有服务端配了 SSO 且本机能安全存 token 时才显示。
  // 「能不能用」是探测出来的，不是写死的开关 —— 写死一个 true 会让
  // ctc 没配好的服务器上出现一个点了必失败的按钮。
  const [ssoConfig, setSsoConfig] = useState<SsoServerConfig | null>(null);
  const [ssoBusy, setSsoBusy] = useState(false);

  // 拉 SSO 配置：地址变了就重拉（不同服务器配不配 SSO 是各自的事）。
  useEffect(() => {
    let alive = true;
    setSsoConfig(null);
    const base = api.serverUrlToHttpBase(describeWsUrl(serverUrl).url || "");
    if (!base) return;
    void fetchSsoConfig(base).then((cfg) => {
      if (alive && cfg) setSsoConfig(cfg);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [serverUrl]);

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
      // 地址连不了时（格式非法 / 公网地址写了明文 ws://）**不要**去连：
      // 连一个空地址只会得到一句看不懂的 "连接失败"。
      const plan = describeWsUrl(settings.serverUrl);
      if (!plan.url) {
        message.warning(`自动连接已跳过：${plan.error ?? "服务器地址不可用"}`, 8);
        return;
      }
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: plan.url,
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
        label: p.label ? `${p.label}  (${displayUrl(p.url)})` : displayUrl(p.url),
      })),
    [presets]
  );

  async function doAuth() {
    const raw = serverUrl.trim();
    // 协议不再是"误输入"：原实现把 ws:// / wss:// 当作手滑**主动剥掉**，
    // 于是用户即便显式填了 wss:// 也会连成明文 ws://，而屏幕像素与键鼠事件
    // 都走这条链路 —— 公网上的明文等于把画面与按键直接暴露给旁路监听。
    // 现在由 describeWsUrl 统一裁决：公网默认 wss，本机可用 ws，
    // 公网写明文 ws:// 一律拒绝并说明原因。
    const plan = describeWsUrl(raw);
    if (plan.error) {
      message.error(plan.error, 8);
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
      const base = api.serverUrlToHttpBase(plan.url);
      const sess =
        mode === "register"
          ? await api.register(base, username, password, inviteCode.trim() || undefined)
          : await api.login(base, username, password);
      // Bump this server to the top of the preset list so it shows up first next time
      touchServer(plan.url, username.includes("@") ? undefined : undefined);
      // 存**实际会用到的**地址（含协议）：
      // 存裸主机名会让「本机 + 显式 wss://」在下次自动连接时回落成明文 ws://。
      update({ serverUrl: cleanAddress(raw), autoConnect });
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: plan.url,
        deviceId,
        deviceName: deviceName || sess.user.username,
        token: sess.accessToken,
      });
      if (!plan.secure) {
        message.warning(
          "当前使用明文连接（ws://）：屏幕画面与键鼠事件在链路上是明文。公网使用请改用 TLS（wss://）。",
          8
        );
      }
    } catch (e: any) {
      const status = e?.status;
      const body = e?.body as { error?: string } | undefined;
      const reason = body?.error || e?.message || "unknown";
      const hint =
        status === 401
          ? "用户名或密码错"
          : status === 409
            ? "用户名已存在"
            : status === 403
              ? "需要邀请码（服务端要求 INVITE_CODE）"
              : status === 429
                ? "注册过于频繁，稍后再试"
                : "";
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

  /**
   * 用 ctc 账号登录。
   *
   * 与账号密码登录是**两条平行的路**：SSO 只是多一种入口，不是替代。
   * 拿到 ctc 的 access_token 后仍要向本服务端换一次会话 ——
   * 本服务端的 session token 才是后续 WebSocket 与 API 用的凭据。
   */
  async function doSsoLogin() {
    if (!ssoConfig) return;
    const raw = serverUrl.trim();
    const plan = describeWsUrl(raw);
    if (plan.error) {
      message.error(plan.error, 8);
      return;
    }
    // OS 密钥库不可用就不让走这条路：token 只能落明文存储，
    // 那比没有 SSO 更糟 —— 与其做了个假的安全，不如不做。
    if (!(await secureStoreAvailable())) {
      message.error("本机没有可用的系统密钥库，无法安全保存登录态 —— 请改用账号密码登录");
      return;
    }

    setSsoBusy(true);
    try {
      const result = await startSsoLogin(ssoConfig);
      if (!result.ok) {
        message.error(result.reason, 8);
        setConnection("offline");
        return;
      }

      // 拿 ctc 的 token 换本服务端的会话 —— 服务端会自己去 ctc 核实身份。
      const base = api.serverUrlToHttpBase(plan.url);
      const sess = await exchangeForRemoteSession(base, result.value.accessToken);

      await ssoSessionStore.save(result.value);
      touchServer(plan.url);
      update({ serverUrl: cleanAddress(raw), autoConnect });
      setConnection("connecting");
      signaling.setReconnectInterval(settings.reconnectInterval);
      signaling.connect({
        url: plan.url,
        deviceId,
        deviceName: deviceName || sess.user.username,
        token: sess.accessToken,
      });
      if (!plan.secure) {
        message.warning(
          "当前使用明文连接（ws://）：屏幕画面与键鼠事件在链路上是明文。公网使用请改用 TLS（wss://）。",
          8
        );
      }
    } catch (e: any) {
      const reason = e?.message || "unknown";
      message.error(`用 ctc 账号登录失败：${reason}`);
      setConnection("offline");
    } finally {
      setSsoBusy(false);
    }
  }

  const onDisconnect = () => {
    signaling.disconnect();
    setConnection("offline");
    message.info(t("toast.disconnected"));
  };

  return (
    // 900x600 的窗口下登录卡片（尤其注册模式）比可视区高：只给 overflow:hidden
    // 的居中容器会把顶部地址栏和底部主按钮一起裁成不可达。这里让容器可纵向滚动，
    // 并用 auto 外边距做"够高才居中、不够高就贴顶可滚"的安全居中。
    <div
      style={{
        width: "100%",
        height: "100%",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        padding: "16px 16px 24px",
      }}
    >
      <Card
        style={{ width: 480, maxWidth: "100%", margin: "auto" }}
        title={<Space><ApiOutlined /><span>{t("login.title")}</span></Space>}
      >
        <Form layout="vertical" onSubmitCapture={onSubmit}>
          <Form.Item
            label={t("login.server")}
            htmlFor="server-url"
            extra="下拉选择历史服务器,或直接输入新地址 (如 signaling.example.com:8443 或 192.168.1.10:8080)"
          >
            <AutoComplete
              id="server-url"
              value={serverUrl}
              onChange={(v) => setServerUrl(v)}
              options={autoCompleteOptions}
              disabled={connection === "online"}
              placeholder="signaling.example.com:8443"
              filterOption={(input, opt) =>
                (opt?.value as string).toLowerCase().includes(input.toLowerCase()) ||
                (opt?.label as string || "").toLowerCase().includes(input.toLowerCase())
              }
              allowClear
            />
          </Form.Item>

          {/* 传输方式：这是安全状态，不是"内部实现细节"。
              屏幕画面与键鼠事件都走这条链路，明文 ws:// 在公网上等于裸奔。
              这里显示的是**按当前地址实际会怎么连**——不是让用户勾一个
              与真实连接不一致的选项（勾了却不生效，比不显示更糟）。 */}
          <Form.Item label="传输方式">
            <Alert
              type={
                !serverUrl.trim()
                  ? "info"
                  : transport.error
                    ? "error"
                    : transport.secure
                      ? "success"
                      : "warning"
              }
              showIcon
              title={
                !serverUrl.trim()
                  ? "填写服务器地址后，这里会显示实际使用的连接方式（TLS / 明文）"
                  : transport.error
                    ? transport.error
                    : transport.secure
                      ? `将使用 TLS：${transport.url}（链路内容加密）`
                      : `将使用明文：${transport.url} —— 屏幕画面与键鼠事件在链路上是明文，仅限本机 / 受信任内网`
              }
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
            <>
              <Form.Item label="本机名称 (可选)">
                <Input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="Alice 的 MacBook"
                  maxLength={64}
                  disabled={connection === "online"}
                />
              </Form.Item>
              <Form.Item
                label="邀请码 (可选)"
                extra="服务端配置了 INVITE_CODE 时必须填；没配就留空"
              >
                <Input
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="服务端要求邀请码时填写"
                  autoComplete="off"
                  disabled={connection === "online"}
                />
              </Form.Item>
            </>
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
          <Form.Item>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t("toast.connectedAs", { id: deviceId })}
            </Typography.Text>
          </Form.Item>

          {/* ctc 统一登录 —— **可选**入口。
              只有服务端配了 SSO 才渲染：没配时这里是空的，
              不会出现一个点了必失败的按钮（那比没有入口更糟）。 */}
          {ssoConfig && connection !== "online" && (
            <Form.Item style={{ marginTop: 8 }}>
              <Button
                icon={<IdcardOutlined />}
                onClick={() => void doSsoLogin()}
                loading={ssoBusy}
                disabled={busy}
                block
              >
                用 ctc 账号登录
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                走公司统一身份，不需要在这台机器上记住密码。
              </Typography.Text>
            </Form.Item>
          )}
        </Form>
      </Card>
    </div>
  );
}
