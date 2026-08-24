import { Alert, Button, Card, Form, Input, List, Space, Tag, Tooltip, message } from "antd";
import { PlusOutlined, ReloadOutlined, CrownOutlined, DesktopOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { addTrusted, isTrusted, removeTrusted } from "../services/storage";
import { t } from "../i18n";
import { SettingsPanel } from "./SettingsPanel";

export function MainView() {
  const { deviceId, onlineDevices, role, sessionId, setSession, setView } = useSessionStore();
  const [joinId, setJoinId] = useState("");
  const [joinToken, setJoinToken] = useState("");

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

  const onRefresh = () => signaling.getOnlineDevices();

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
              <span>{t("main.devices")}</span>
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
      <div style={{ width: 360, flexShrink: 0 }}>
        <SettingsPanel />
      </div>
    </div>
  );
}
