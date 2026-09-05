import { Alert, Button, Card, Form, Input, List, Space, Tag, Tooltip, message } from "antd";
import { PlusOutlined, ReloadOutlined, CrownOutlined, DesktopOutlined, LinkOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { addTrusted, isTrusted, removeTrusted, getSettings, getAuth } from "../services/storage";
import * as api from "../services/api";
import { t } from "../i18n";
import { SettingsPanel } from "./SettingsPanel";
import { FileTransferPanel } from "./FileTransferPanel";
import { ChatPanel } from "./ChatPanel";

interface MyDevice {
  id: string;
  name: string;
  lastSeen: number;
  online: boolean;
}

export function MainView() {
  const { deviceId, onlineDevices, role, sessionId, setSession, setView, userId, username } = useSessionStore();
  const [joinId, setJoinId] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [myDevices, setMyDevices] = useState<MyDevice[]>([]);
  const settings = getSettings();
  const auth = getAuth();
  const httpBase = settings.serverUrl ? api.serverUrlToHttpBase(settings.serverUrl) : "";

  // Listen for MY_DEVICES from server
  useEffect(() => {
    const off = signaling.on("message", (msg: any) => {
      if (msg.type === "MY_DEVICES" && Array.isArray(msg.devices)) {
        setMyDevices(msg.devices);
      }
      if (msg.type === "REGISTER_SUCCESS" && (msg as any).userId) {
        useSessionStore.setState({ userId: (msg as any).userId, username: (msg as any).username });
      }
    });
    return off;
  }, []);

  // Pull my devices on mount + every 30s as a heartbeat
  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled && signaling.isOpen()) signaling.listMyDevices();
    };
    tick();
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [auth?.accessToken]);

  const onCreateSession = () => {
    if (!signaling.isOpen()) {
      message.warning(t("toast.noServer"));
      return;
    }
    signaling.createSession();
  };

  const onJoinSession = () => {
    if (!signaling.isOpen()) {
      message.warning(t("toast.noServer"));
      return;
    }
    if (!joinId.trim() || !joinToken.trim()) {
      message.warning("请填写会话ID和令牌");
      return;
    }
    setSession({ sessionId: joinId.trim(), sessionToken: joinToken.trim(), role: "client" });
    signaling.joinSession(joinId.trim(), joinToken.trim());
  };

  const onConnectToMyDevice = async (targetId: string) => {
    if (!signaling.isOpen()) {
      message.warning(t("toast.noServer"));
      return;
    }
    // Rename self for clarity: this client is the controller.
    // We need a session to use for the control request. Create one on the fly.
    // Trick: send a synthetic CREATE_SESSION-equivalent by using a new ephemeral sessionId.
    // Simpler: just call requestControl with a placeholder session; the host creates
    // and joins on accept. The server routes the request to the target.
    const ephemeralSessionId = "auto-" + Math.random().toString(36).slice(2, 8);
    setSession({ sessionId: ephemeralSessionId, role: "client", targetDeviceId: targetId });
    signaling.requestControl(targetId, ephemeralSessionId);
    message.info(`已向 ${targetId} 发送连接请求…`);
  };

  const onRequestControl = (targetId: string) => {
    if (!signaling.isOpen()) {
      message.warning(t("toast.noServer"));
      return;
    }
    if (!sessionId) {
      message.warning("请先加入会话");
      return;
    }
    signaling.requestControl(targetId, sessionId);
    message.info(`已向 ${targetId} 发送控制请求，等待对方接受…`);
  };

  const onRefresh = () => {
    signaling.getOnlineDevices();
    if (auth) signaling.listMyDevices();
  };

  const onRename = async (id: string) => {
    if (!httpBase || !auth) return;
    const current = myDevices.find((d) => d.id === id);
    const newName = window.prompt("新设备名", current?.name || id);
    if (!newName) return;
    try {
      await api.renameDevice(httpBase, id, newName);
      signaling.listMyDevices();
      message.success("已重命名");
    } catch (e: any) {
      message.error(`重命名失败: ${e?.message || e}`);
    }
  };

  const onRemove = async (id: string) => {
    if (!httpBase || !auth) return;
    if (!window.confirm("确认从账号移除此设备?该设备将无法再登录(需要重新注册)。")) return;
    try {
      await api.deleteDevice(httpBase, id);
      signaling.listMyDevices();
      message.success("已移除");
    } catch (e: any) {
      message.error(`移除失败: ${e?.message || e}`);
    }
  };

  const onTrust = (id: string) => {
    addTrusted(id);
    message.success(t("main.trust") + ": " + id);
  };
  const onUntrust = (id: string) => {
    removeTrusted(id);
    message.success(t("main.untrust") + ": " + id);
  };

  const onCancelSession = () => {
    setSession({ sessionId: "", role: role ?? "client" });
    setView({ kind: "main" });
  };

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", padding: 16, gap: 16, overflow: "auto" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {username && (
          <Alert
            type="success"
            showIcon
            message={
              <span>
                已登录为 <b>{username}</b>
                {userId && <span style={{ color: "#999", marginLeft: 8, fontFamily: "monospace", fontSize: 12 }}>{userId}</span>}
              </span>
            }
          />
        )}

        {auth && (
          <Card
            title={
              <Space>
                <DesktopOutlined />
                <span>我的设备</span>
              </Space>
            }
            extra={
              <Button icon={<ReloadOutlined />} size="small" onClick={() => signaling.listMyDevices()}>
                刷新
              </Button>
            }
          >
            {myDevices.length === 0 ? (
              <div style={{ textAlign: "center", color: "#999", padding: 24 }}>
                暂无设备(本机注册后会自动出现)
              </div>
            ) : (
              <List
                dataSource={myDevices}
                renderItem={(d) => {
                  const isSelf = d.id === deviceId;
                  return (
                    <List.Item
                      actions={[
                        isSelf ? (
                          <Tag key="self" color="blue">本机</Tag>
                        ) : d.online ? (
                          <Button
                            key="connect"
                            type="primary"
                            size="small"
                            icon={<LinkOutlined />}
                            onClick={() => onConnectToMyDevice(d.id)}
                          >
                            连接
                          </Button>
                        ) : (
                          <Tag key="offline" color="default">离线</Tag>
                        ),
                        <Button key="rename" size="small" onClick={() => onRename(d.id)}>
                          改名
                        </Button>,
                        !isSelf && (
                          <Button key="remove" size="small" danger onClick={() => onRemove(d.id)}>
                            移除
                          </Button>
                        ),
                      ].filter(Boolean)}
                    >
                      <List.Item.Meta
                        avatar={d.online ? <Tag color="green">在线</Tag> : <Tag>离线</Tag>}
                        title={
                          <Space>
                            <span>{d.name}</span>
                            <span style={{ color: "#999", fontFamily: "monospace", fontSize: 12 }}>
                              {d.id}
                            </span>
                          </Space>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        )}

        <Card
          title={
            <Space>
              <CrownOutlined />
              <span>会话</span>
            </Space>
          }
        >
          {role === "client" && sessionId ? (
            <Alert
              type="info"
              showIcon
              message={
                <Space>
                  <span>已加入会话</span>
                  <span className="session-token">{sessionId}</span>
                </Space>
              }
              description="可向在线设备发起控制请求。被对方接受后会弹出远程控制窗口。"
              action={
                <Button size="small" onClick={onCancelSession}>
                  退出
                </Button>
              }
            />
          ) : (
            <Space direction="vertical" style={{ width: "100%" }}>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={onCreateSession}
                block
              >
                {t("main.createSession")}
              </Button>
              <Form layout="inline" style={{ marginTop: 8 }}>
                <Form.Item label={t("main.sessionId")}>
                  <Input
                    value={joinId}
                    onChange={(e) => setJoinId(e.target.value)}
                    placeholder="会话ID"
                    style={{ width: 160 }}
                  />
                </Form.Item>
                <Form.Item label={t("main.sessionToken")}>
                  <Input.Password
                    value={joinToken}
                    onChange={(e) => setJoinToken(e.target.value)}
                    placeholder="令牌"
                    style={{ width: 160 }}
                  />
                </Form.Item>
                <Form.Item>
                  <Button type="default" onClick={onJoinSession}>
                    {t("main.join")}
                  </Button>
                </Form.Item>
              </Form>
            </Space>
          )}
        </Card>

        <Card
          title={
            <Space>
              <DesktopOutlined />
              <span>其他在线设备</span>
            </Space>
          }
          extra={
            <Button icon={<ReloadOutlined />} size="small" onClick={onRefresh}>
              {t("main.refresh")}
            </Button>
          }
        >
          {onlineDevices.length === 0 ? (
            <div style={{ textAlign: "center", color: "#999", padding: 24 }}>
              {t("main.empty")}
            </div>
          ) : (
            <List
              dataSource={onlineDevices}
              renderItem={(d) => (
                <List.Item
                  actions={[
                    ...(role === "client" && d.id !== deviceId
                      ? [
                          <Button
                            key="ctrl"
                            type="primary"
                            size="small"
                            onClick={() => onRequestControl(d.id)}
                          >
                            {t("main.requestControl")}
                          </Button>,
                        ]
                      : []),
                    isTrusted(d.id) ? (
                      <Button key="untrust" size="small" onClick={() => onUntrust(d.id)}>
                        {t("main.untrust")}
                      </Button>
                    ) : (
                      <Tooltip key="trust" title="加入信任列表后将自动接受对方的控制请求">
                        <Button key="trust" size="small" onClick={() => onTrust(d.id)}>
                          {t("main.trust")}
                        </Button>
                      </Tooltip>
                    ),
                  ].filter(Boolean)}
                >
                  <List.Item.Meta
                    avatar={<Tag color="green">在线</Tag>}
                    title={
                      <Space>
                        <span>{d.name || d.id}</span>
                        <span style={{ color: "#999", fontFamily: "monospace", fontSize: 12 }}>
                          {d.id}
                        </span>
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
      <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        <SettingsPanel />
        {settings.allowFileTransfer && <FileTransferPanel />}
        {settings.allowChat && <ChatPanel />}
      </div>
    </div>
  );
}
