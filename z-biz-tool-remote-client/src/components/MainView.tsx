import { Button, Input, Modal, Space, Tag, Tooltip, message } from "antd";
import {
  ApiOutlined,
  AppleOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LaptopOutlined,
  LinkOutlined,
  LogoutOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  WifiOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import {
  addTrusted,
  getAuth,
  getHistory,
  isTrusted,
  removeTrusted,
  setAuth,
} from "../services/storage";
import * as api from "../services/api";
import { t } from "../i18n";
import { SettingsPanel } from "./SettingsPanel";
import { FileTransferPanel } from "./FileTransferPanel";
import { serverUrlToHttpBase } from "../services/api";
import { toWsUrl, getSettings } from "../services/storage";

interface MyDevice {
  id: string;
  name: string;
  lastSeen: number;
  createdAt: number;
  online: boolean;
}

type Section = "devices" | "sessions" | "files" | "settings";
type DeviceCategory = "mine" | "online" | "recent";

function platformOf(name: string): "mac" | "windows" | "linux" | "unknown" {
  const n = (name || "").toLowerCase();
  if (n.includes("mac") || n.includes("book") || n.includes("mini")) return "mac";
  if (n.includes("win") || n.includes("desktop") || n.includes("laptop") || /^pc-/i.test(n)) return "windows";
  if (n.includes("linux") || n.includes("ubuntu") || n.includes("debian")) return "linux";
  return "unknown";
}

function PlatformIcon({ name }: { name: string }) {
  const p = platformOf(name);
  if (p === "mac") return <AppleOutlined />;
  if (p === "windows") return <DesktopOutlined />;
  if (p === "linux") return <LaptopOutlined />;
  return <DesktopOutlined />;
}

function timeAgo(ts: number): string {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
}

export function MainView() {
  const { deviceId, onlineDevices, role, sessionId, setSession, setView, userId, username, setUser } = useSessionStore();
  const [joinId, setJoinId] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [myDevices, setMyDevices] = useState<MyDevice[]>([]);
  const [section, setSection] = useState<Section>("devices");
  const [cat, setCat] = useState<DeviceCategory>("mine");
  const [search, setSearch] = useState("");
  const auth = getAuth();
  const httpBase = auth ? serverUrlToHttpBase(toWsUrl(getSettings().serverUrl)) : "";

  // 拉我的设备 + 在线设备
  useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (signaling.isOpen()) {
        signaling.listMyDevices();
        signaling.getOnlineDevices();
      }
    };
    tick();
    const id = window.setInterval(tick, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.accessToken]);

  // Listen for MY_DEVICES
  useEffect(() => {
    const off = signaling.on("message", (msg: any) => {
      if (msg.type === "MY_DEVICES" && Array.isArray(msg.devices)) {
        setMyDevices(msg.devices);
      }
      if (msg.type === "ONLINE_DEVICES" && Array.isArray(msg.devices)) {
        // ONLINE_DEVICES is handled by App.tsx into sessionStore.onlineDevices
        // (kept here for clarity in case we need it)
      }
      if (msg.type === "REGISTER_SUCCESS" && msg.userId && msg.username) {
        setUser({ userId: msg.userId, username: msg.username });
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const onConnectToMyDevice = (targetId: string) => {
    if (!signaling.isOpen()) {
      message.warning(t("toast.noServer"));
      return;
    }
    // "ephemeral: true" tells the server: this is a one-click request to
    // control one of my own devices. The server will create a real session
    // on accept and return its sessionId+sessionToken to us, so we can
    // auto-join and start sending input.
    setSession({ sessionId: "", role: "client", targetDeviceId: targetId });
    signaling.requestControl(targetId, "", true);
    message.info(`已向 ${targetId} 发起连接,等待对方接受…`);
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
    message.info(`已向 ${targetId} 发送控制请求,等待对方接受…`);
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
  const onTrust = (id: string) => { addTrusted(id); message.success(t("main.trust") + ": " + id); };
  const onUntrust = (id: string) => { removeTrusted(id); message.success(t("main.untrust") + ": " + id); };

  const onLogout = async () => {
    if (!auth) {
      setUser(null);
      setView({ kind: "login" });
      return;
    }
    Modal.confirm({
      title: "退出登录?",
      content: "退出后需要重新输入账号密码。本机设备仍会保留在账号下。",
      okText: "退出",
      cancelText: "取消",
      onOk: async () => {
        try {
          // 尽量调用后端 logout(让 refresh token 失效),但失败也不阻塞
          const base = serverUrlToHttpBase(toWsUrl(getSettings().serverUrl));
          await api.logout(base).catch(() => {});
        } catch {
          /* ignore */
        }
        setAuth(null);
        setUser(null);
        signaling.disconnect();
        setView({ kind: "login" });
        message.info("已退出登录");
      },
    });
  };

  // ---- 视图数据 ----
  const recentFromHistory = useMemo(() => {
    const seen = new Set<string>();
    const list: MyDevice[] = [];
    for (const h of getHistory()) {
      const id = h.targetDeviceId || h.sessionId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: id, lastSeen: h.at, createdAt: 0, online: false });
      if (list.length >= 10) break;
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let sectionTitle = "设备";
  let sectionList: MyDevice[] = [];
  if (section === "devices") {
    sectionTitle =
      cat === "mine" ? "我的设备" : cat === "online" ? "全部在线" : "最近";
    if (cat === "mine") {
      sectionList = myDevices;
    } else if (cat === "online") {
      const ids = new Set(myDevices.map((d) => d.id));
      sectionList = onlineDevices
        .filter((d) => !ids.has(d.id))
        .map((d) => ({ id: d.id, name: d.name || d.id, lastSeen: 0, createdAt: 0, online: true }));
    } else {
      sectionList = recentFromHistory;
    }
  }

  if (search) {
    const q = search.toLowerCase();
    sectionList = sectionList.filter(
      (d) => d.id.toLowerCase().includes(q) || (d.name || "").toLowerCase().includes(q)
    );
  }

  return (
    <div className="sunlogin-layout">
      {/* ---------- 左:sidebar ---------- */}
      <aside className="sl-sidebar">
        <div className="sl-user-card" onClick={() => message.info(`用户ID: ${userId}`)}>
          <div className="sl-user-avatar">{(username || "?").slice(0, 1).toUpperCase()}</div>
          <div className="sl-user-info">
            <div className="sl-user-name">{username || "未登录"}</div>
            <div className="sl-user-id">{userId || "—"}</div>
          </div>
          <span className="sl-user-chevron">›</span>
        </div>

        <nav className="sl-nav">
          <div
            className={`sl-nav-item${section === "devices" ? " active" : ""}`}
            onClick={() => setSection("devices")}
          >
            <DesktopOutlined />
            <span>设备</span>
          </div>
          <div
            className={`sl-nav-item${section === "sessions" ? " active" : ""}`}
            onClick={() => setSection("sessions")}
          >
            <ThunderboltOutlined />
            <span>远程会话</span>
          </div>
          <div
            className={`sl-nav-item${section === "files" ? " active" : ""}`}
            onClick={() => setSection("files")}
          >
            <FileTextOutlined />
            <span>文件传输</span>
          </div>
          <div
            className={`sl-nav-item${section === "settings" ? " active" : ""}`}
            onClick={() => setSection("settings")}
          >
            <SettingOutlined />
            <span>设置</span>
          </div>
        </nav>

        <div className="sl-nav-bottom">
          <div className="sl-nav-item" onClick={onLogout}>
            <LogoutOutlined />
            <span>退出登录</span>
          </div>
        </div>
      </aside>

      {/* ---------- 中:分类 ---------- */}
      <aside className="sl-category">
        {section === "devices" && (
          <>
            <div className="sl-cat-header">设备</div>
            <div className="sl-cat-group">
              <div
                className={`sl-cat-item${cat === "recent" ? " active" : ""}`}
                onClick={() => setCat("recent")}
              >
                <HistoryOutlined />
                <span>最近</span>
                <span className="sl-cat-count">{recentFromHistory.length}</span>
              </div>
              <div
                className={`sl-cat-item${cat === "mine" ? " active" : ""}`}
                onClick={() => setCat("mine")}
              >
                <DesktopOutlined />
                <span>我的设备</span>
                <span className="sl-cat-count">{myDevices.length}</span>
              </div>
              <div
                className={`sl-cat-item${cat === "online" ? " active" : ""}`}
                onClick={() => setCat("online")}
              >
                <WifiOutlined />
                <span>全部在线</span>
                <span className="sl-cat-count">{onlineDevices.length}</span>
              </div>
            </div>
          </>
        )}

        {section === "sessions" && (
          <>
            <div className="sl-cat-header">远程会话</div>
            <div className="sl-cat-group">
              <div className="sl-cat-item" onClick={onCreateSession}>
                <PlusOutlined />
                <span>发起会话</span>
              </div>
              <div className="sl-cat-item">
                <ApiOutlined />
                <span>加入会话</span>
              </div>
              {role === "client" && sessionId && (
                <div className="sl-cat-item">
                  <DisconnectOutlined />
                  <span style={{ color: "#999" }}>当前: {sessionId.slice(0, 8)}</span>
                </div>
              )}
            </div>
          </>
        )}

        {section === "files" && (
          <>
            <div className="sl-cat-header">文件传输</div>
            <div className="sl-cat-group">
              <div className="sl-cat-item">
                <FileTextOutlined />
                <span>本机共享</span>
              </div>
            </div>
          </>
        )}

        {section === "settings" && (
          <>
            <div className="sl-cat-header">设置</div>
          </>
        )}
      </aside>

      {/* ---------- 右:主区 ---------- */}
      <main className="sl-main">
        <div className="sl-main-toolbar">
          <span className="sl-main-title">{sectionTitle}</span>
          {section === "devices" && (
            <Input
              className="sl-main-search"
              prefix={<SearchOutlined style={{ color: "#666" }} />}
              placeholder="搜索 设备名 / 设备ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
          )}
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={onRefresh} />
          </Tooltip>
        </div>

        <div className="sl-main-content">
          {section === "devices" && (
            <DeviceTable
              rows={sectionList}
              myDevices={myDevices}
              onlineDevices={onlineDevices}
              deviceId={deviceId}
              role={role}
              onConnectToMyDevice={onConnectToMyDevice}
              onRequestControl={onRequestControl}
              onRename={onRename}
              onRemove={onRemove}
              onTrust={onTrust}
              onUntrust={onUntrust}
              isTrusted={isTrusted}
            />
          )}

          {section === "sessions" && (
            <SessionView
              role={role}
              sessionId={sessionId}
              joinId={joinId}
              joinToken={joinToken}
              setJoinId={setJoinId}
              setJoinToken={setJoinToken}
              onCreate={onCreateSession}
              onJoin={onJoinSession}
            />
          )}

          {section === "files" && <FileTransferPanel />}

          {section === "settings" && <SettingsPanel />}
        </div>

        {section === "devices" && sectionList.length > 0 && (
          <div className="sl-pagination">
            <span>共 {sectionList.length} 条</span>
          </div>
        )}
      </main>
    </div>
  );
}

// ----------------- 设备表 -----------------

function DeviceTable(props: {
  rows: MyDevice[];
  myDevices: MyDevice[];
  onlineDevices: { id: string; name?: string; online?: boolean }[];
  deviceId: string;
  role: "host" | "client" | null;
  onConnectToMyDevice: (id: string) => void;
  onRequestControl: (id: string) => void;
  onRename: (id: string) => void;
  onRemove: (id: string) => void;
  onTrust: (id: string) => void;
  onUntrust: (id: string) => void;
  isTrusted: (id: string) => boolean;
}) {
  const {
    rows,
    myDevices,
    onlineDevices,
    deviceId,
    role,
    onConnectToMyDevice,
    onRequestControl,
    onRename,
    onRemove,
    onTrust,
    onUntrust,
    isTrusted,
  } = props;

  if (rows.length === 0) {
    return (
      <div className="sl-empty">
        <DesktopOutlined />
        <div>暂无设备</div>
        <div style={{ fontSize: 12, color: "#666" }}>本机注册后会自动出现在"我的设备"</div>
      </div>
    );
  }

  return (
    <table className="sl-table">
      <thead>
        <tr>
          <th style={{ width: "40%" }}>设备名</th>
          <th>状态</th>
          <th>备注</th>
          <th style={{ width: 220, textAlign: "right" }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => {
          const isMine = myDevices.some((m) => m.id === d.id);
          const isSelf = d.id === deviceId;
          const isOn = isSelf
            ? true
            : isMine
            ? myDevices.find((m) => m.id === d.id)?.online ?? false
            : onlineDevices.find((o) => o.id === d.id)?.online ?? d.online;
          return (
            <tr key={d.id}>
              <td>
                <span className={`platform-icon ${platformOf(d.name)}`}>
                  <PlatformIcon name={d.name} />
                </span>
                <span className="device-name">{d.name || d.id}</span>
                {isSelf && (
                  <Tag color="blue" style={{ marginLeft: 8, fontSize: 11, padding: "0 6px" }}>
                    本机
                  </Tag>
                )}
                <div className="device-id">{d.id}</div>
              </td>
              <td>
                {isSelf ? (
                  <span className="sl-status self">本机</span>
                ) : isOn ? (
                  <span className="sl-status online">在线</span>
                ) : (
                  <span className="sl-status offline">离线</span>
                )}
              </td>
              <td style={{ color: "#888", fontSize: 12 }}>{isMine ? timeAgo(d.lastSeen) : "—"}</td>
              <td>
                <div className="sl-row-actions">
                  {!isSelf && isOn && isMine && (
                    <Button
                      type="primary"
                      size="small"
                      icon={<LinkOutlined />}
                      onClick={() => onConnectToMyDevice(d.id)}
                    >
                      连接
                    </Button>
                  )}
                  {!isSelf && isOn && !isMine && role === "client" && (
                    <Button
                      type="primary"
                      size="small"
                      onClick={() => onRequestControl(d.id)}
                    >
                      发起控制
                    </Button>
                  )}
                  {isMine && (
                    <Button size="small" onClick={() => onRename(d.id)}>改名</Button>
                  )}
                  {isMine && !isSelf && (
                    <Button size="small" danger onClick={() => onRemove(d.id)}>移除</Button>
                  )}
                  {!isMine && isOn && (
                    isTrusted(d.id) ? (
                      <Button size="small" onClick={() => onUntrust(d.id)}>取消信任</Button>
                    ) : (
                      <Button size="small" onClick={() => onTrust(d.id)}>信任</Button>
                    )
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ----------------- 会话面板 -----------------

function SessionView(props: {
  role: "host" | "client" | null;
  sessionId: string | null;
  joinId: string;
  joinToken: string;
  setJoinId: (s: string) => void;
  setJoinToken: (s: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const { role, sessionId, joinId, joinToken, setJoinId, setJoinToken, onCreate, onJoin } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div
        style={{
          background: "#181818",
          border: "1px solid #262626",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>发起新会话</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>
          创建会话后会显示 ID 和令牌,把这两个信息发给对方,对方就能加入并远程控制本机。
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate} block>
          {t("main.createSession")}
        </Button>
      </div>

      <div
        style={{
          background: "#181818",
          border: "1px solid #262626",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>加入会话</div>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>
          填入会话 ID 和令牌,即可远程控制对方机器。
        </div>
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            placeholder="会话ID"
          />
          <Input.Password
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
            placeholder="令牌"
          />
          <Button onClick={onJoin} block>{t("main.join")}</Button>
        </Space>
      </div>

      {role === "client" && sessionId && (
        <div
          style={{
            background: "#181818",
            border: "1px solid #1677ff",
            borderRadius: 8,
            padding: 20,
          }}
        >
          <div style={{ fontSize: 14, color: "#69b1ff" }}>当前已加入会话: {sessionId}</div>
        </div>
      )}
    </div>
  );
}

