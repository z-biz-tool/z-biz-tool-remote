import { Button, Input, Modal, Space, Tag, Tooltip, message, theme } from "antd";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { EmptyState, ErrorState, LoadingState } from "../_shared";
import { SettingsPanel } from "./SettingsPanel";
import { FileTransferPanel } from "./FileTransferPanel";
import { serverUrlToHttpBase } from "../services/api";
import { describeWsUrl, getSettings } from "../services/storage";

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

/** 侧栏是 div 布局，这里补上按钮语义与 Enter/Space 激活，键盘可达。 */
function navProps(active: boolean, activate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    "aria-current": active ? ("page" as const) : undefined,
    onClick: activate,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    },
  };
}

export function MainView() {
  const { token } = theme.useToken();
  const { deviceId, onlineDevices, role, sessionId, setSession, setView, userId, username, setUser, connection } =
    useSessionStore();
  const [joinId, setJoinId] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [joining, setJoining] = useState(false);
  const [myDevices, setMyDevices] = useState<MyDevice[]>([]);
  const [section, setSection] = useState<Section>("devices");
  const [cat, setCat] = useState<DeviceCategory>("mine");
  const [search, setSearch] = useState("");
  // 设备列表三态：loading（请求已发/未回）、ready、error（含原因与重试）
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [recentRev, setRecentRev] = useState(0);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const listTimer = useRef<number | null>(null);
  const joinTimer = useRef<number | null>(null);
  const auth = getAuth();
  // 地址连不了时（格式非法 / 公网地址写了明文 ws://）httpBase 为空，
  // 下面的请求会自然失败，而不是拿一个空 base 去打相对路径。
  const httpBase = auth ? serverUrlToHttpBase(describeWsUrl(getSettings().serverUrl).url) : "";

  // 拉我的设备 + 在线设备
  const finishLoad = useCallback(() => {
    if (listTimer.current) {
      window.clearTimeout(listTimer.current);
      listTimer.current = null;
    }
    setListStatus("ready");
    setListError("");
  }, []);

  // showLoading=false 用于 30s 静默轮询：不打断已有数据，失败才降级为 error
  const loadDevices = useCallback(
    (showLoading: boolean) => {
      if (!getAuth()) return;
      if (cat === "recent") {
        setListStatus("ready");
        return;
      }
      if (listTimer.current) {
        window.clearTimeout(listTimer.current);
        listTimer.current = null;
      }
      if (showLoading) {
        setListStatus("loading");
        setListError("");
      }
      if (!signaling.isOpen()) {
        // 连不上就别假装"暂无设备"：给失败态 + 重试入口
        setListStatus("error");
        setListError("未连接到服务器，无法加载设备列表");
        return;
      }
      const ok = cat === "online" ? signaling.getOnlineDevices() : signaling.listMyDevices();
      if (!ok) {
        setListStatus("error");
        setListError("请求未送达服务器（连接已断开）");
        return;
      }
      if (showLoading) {
        listTimer.current = window.setTimeout(() => {
          setListStatus((s) => (s === "loading" ? "error" : s));
        }, 6000);
      }
    },
    [cat]
  );

  useEffect(() => {
    if (!auth) return;
    loadDevices(true);
    const id = window.setInterval(() => loadDevices(false), 30000);
    return () => {
      window.clearInterval(id);
      if (listTimer.current) window.clearTimeout(listTimer.current);
      if (joinTimer.current) window.clearTimeout(joinTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.accessToken, loadDevices]);

  // 服务端回包才收 loading：没回包就是"加载中/超时"，不预判成空列表
  useEffect(() => {
    const off = signaling.on("message", (msg: any) => {
      if (msg.type === "MY_DEVICES" && Array.isArray(msg.devices)) {
        setMyDevices(msg.devices);
        if (cat === "mine") finishLoad();
      }
      if (msg.type === "ONLINE_DEVICES" && Array.isArray(msg.devices)) {
        if (cat === "online") finishLoad();
      }
      if (msg.type === "REGISTER_SUCCESS" && msg.userId && msg.username) {
        setUser({ userId: msg.userId, username: msg.username });
      }
      if (msg.type === "JOIN_SUCCESS" || msg.type === "JOIN_FAILED" || msg.type === "SESSION_CLOSED") {
        if (joinTimer.current) {
          window.clearTimeout(joinTimer.current);
          joinTimer.current = null;
        }
        setJoining(false);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, finishLoad]);

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
    if (!signaling.joinSession(joinId.trim(), joinToken.trim())) {
      message.error("加入请求未送达服务器（连接已断开）");
      return;
    }
    setJoining(true);
    // 服务端既不回成功也不回失败时，不能一直转圈
    if (joinTimer.current) window.clearTimeout(joinTimer.current);
    joinTimer.current = window.setTimeout(() => {
      setJoining(false);
      message.warning("加入会话超时：服务器 8 秒无响应，请核对会话ID/令牌后重试", 6);
    }, 8000);
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
    if (cat === "recent") {
      setRecentRev((v) => v + 1);
      setListStatus("ready");
      return;
    }
    loadDevices(true);
  };
  const openRename = (id: string) => {
    const current = myDevices.find((d) => d.id === id);
    setRenameTarget({ id, name: current?.name || id });
    setRenameValue(current?.name || id);
  };
  const submitRename = async () => {
    if (!renameTarget || renaming) return;
    const name = renameValue.trim();
    if (!name) {
      message.warning("设备名不能为空");
      return;
    }
    if (!httpBase) {
      message.error("服务端地址无效（请检查设置里的服务器地址），无法改名");
      return;
    }
    setRenaming(true);
    try {
      await api.renameDevice(httpBase, renameTarget.id, name);
      setRenameTarget(null);
      message.success(`已改名为「${name}」`);
      signaling.listMyDevices();
    } catch (e) {
      message.error(`重命名失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRenaming(false);
    }
  };
  const onRemove = (id: string) => {
    if (!httpBase) {
      message.error("服务端地址无效（请检查设置里的服务器地址），无法移除");
      return;
    }
    const d = myDevices.find((x) => x.id === id);
    Modal.confirm({
      title: "从账号移除此设备？",
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          将移除 <strong>{d?.name || id}</strong>（<code>{id}</code>）。
          移除后该设备需要在本机重新注册才能继续接入。
        </div>
      ),
      okText: "移除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: async () => {
        try {
          await api.deleteDevice(httpBase, id);
          message.success("已移除");
          signaling.listMyDevices();
        } catch (e) {
          message.error(`移除失败：${e instanceof Error ? e.message : String(e)}`);
          throw e; // 失败保持弹窗，避免"看起来成功"
        }
      },
    });
  };
  const onTrust = (id: string) => {
    try {
      addTrusted(id);
      message.success(t("main.trust") + ": " + id);
    } catch (e) {
      message.error(`写入本机信任列表失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const onUntrust = (id: string) => {
    try {
      removeTrusted(id);
      message.success(t("main.untrust") + ": " + id);
    } catch (e) {
      message.error(`更新本机信任列表失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

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
      okButtonProps: { danger: true },
      cancelText: "取消",
      // 退出会断开连接并要求重新登录，属于破坏性动作：默认焦点给「取消」
      focusable: { autoFocusButton: "cancel" },
      onOk: async () => {
        try {
          // 尽量调用后端 logout(让 refresh token 失效),但失败也不阻塞
          const base = serverUrlToHttpBase(describeWsUrl(getSettings().serverUrl).url);
          await api.logout(base);
        } catch (e) {
          console.warn("[remote] 后端 logout 失败（本地仍退出，refresh token 可能未失效）:", e);
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
  }, [recentRev]);

  let sectionTitle = "设备";
  if (section === "sessions") sectionTitle = "远程会话";
  else if (section === "files") sectionTitle = "文件传输";
  else if (section === "settings") sectionTitle = "设置";
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

  const searching = search.trim().length > 0;
  const emptyCopy =
    cat === "mine"
      ? {
          title: "账号下暂无设备",
          desc: "本机登录后会自动注册为设备；也可在另一台机器登录同一账号",
        }
      : cat === "online"
        ? {
            title: "暂无其他在线设备",
            desc: "对方需要已登录并连上服务器，才会出现在这里",
          }
        : {
            title: "暂无最近会话",
            desc: "成功建立过的远程会话会记录在这里",
          };
  const listErrorText = listError || (listStatus === "error" ? "加载设备列表超时（6 秒无响应）" : "");

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
          <div className={`sl-nav-item${section === "devices" ? " active" : ""}`} {...navProps(section === "devices", () => setSection("devices"))}>
            <DesktopOutlined />
            <span>设备</span>
          </div>
          <div className={`sl-nav-item${section === "sessions" ? " active" : ""}`} {...navProps(section === "sessions", () => setSection("sessions"))}>
            <ThunderboltOutlined />
            <span>远程会话</span>
          </div>
          <div className={`sl-nav-item${section === "files" ? " active" : ""}`} {...navProps(section === "files", () => setSection("files"))}>
            <FileTextOutlined />
            <span>文件传输</span>
          </div>
          <div className={`sl-nav-item${section === "settings" ? " active" : ""}`} {...navProps(section === "settings", () => setSection("settings"))}>
            <SettingOutlined />
            <span>设置</span>
          </div>
        </nav>

        <div className="sl-nav-bottom">
          <div className="sl-nav-item" {...navProps(false, onLogout)}>
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
              <div className={`sl-cat-item${cat === "recent" ? " active" : ""}`} {...navProps(cat === "recent", () => setCat("recent"))}>
                <HistoryOutlined />
                <span>最近</span>
                <span className="sl-cat-count">{recentFromHistory.length}</span>
              </div>
              <div className={`sl-cat-item${cat === "mine" ? " active" : ""}`} {...navProps(cat === "mine", () => setCat("mine"))}>
                <DesktopOutlined />
                <span>我的设备</span>
                <span className="sl-cat-count">{myDevices.length}</span>
              </div>
              <div className={`sl-cat-item${cat === "online" ? " active" : ""}`} {...navProps(cat === "online", () => setCat("online"))}>
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
              <div className="sl-cat-item" {...navProps(false, onCreateSession)}>
                <PlusOutlined />
                <span>发起会话</span>
              </div>
              <div
                className="sl-cat-item"
                {...navProps(false, () =>
                  document.getElementById("sl-join-session-id")?.focus()
                )}
              >
                <ApiOutlined />
                <span>加入会话</span>
              </div>
              {role === "client" && sessionId && (
                <div className="sl-cat-item">
                  <DisconnectOutlined />
                  <span style={{ color: token.colorTextTertiary }}>当前: {sessionId.slice(0, 8)}</span>
                </div>
              )}
            </div>
          </>
        )}

        {section === "files" && (
          <>
            <div className="sl-cat-header">文件传输</div>
            <div className="sl-cat-group">
              {/* 原「本机共享」是死入口：服务端没有文件通道，这里只陈述事实 */}
              <div className="sl-cat-item" style={{ opacity: 0.6, cursor: "default" }} aria-disabled="true">
                <FileTextOutlined />
                <span>尚未实现</span>
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
              prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder="搜索 设备名 / 设备ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
            />
          )}
          {section === "devices" && (
            <Tooltip title="刷新">
              <Button
                icon={<ReloadOutlined />}
                onClick={onRefresh}
                aria-label="刷新设备列表"
                loading={cat !== "recent" && listStatus === "loading"}
              />
            </Tooltip>
          )}
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
              onRename={openRename}
              onRemove={onRemove}
              onTrust={onTrust}
              onUntrust={onUntrust}
              isTrusted={isTrusted}
              status={cat === "recent" ? "ready" : listStatus}
              errorMessage={listErrorText}
              onRetry={onRefresh}
              searching={searching}
              emptyTitle={emptyCopy.title}
              emptyDescription={emptyCopy.desc}
              offlineHint={
                connection !== "online" && cat !== "recent"
                  ? "与服务器的连接已断开，列表可能不是最新"
                  : ""
              }
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
              joining={joining}
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

      {/* 改名：antd Modal 代替 window.prompt，失败留在弹窗里，不吞错 */}
      <Modal
        open={Boolean(renameTarget)}
        title="重命名设备"
        okText="保存"
        cancelText="取消"
        confirmLoading={renaming}
        onCancel={() => setRenameTarget(null)}
        onOk={submitRename}
        destroyOnHidden
      >
        <div style={{ fontSize: 13, color: "#888", marginBottom: 8 }}>
          设备 <code>{renameTarget?.id}</code> 的新名称
        </div>
        <Input
          autoFocus
          maxLength={64}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onPressEnter={submitRename}
          aria-label="新设备名"
        />
      </Modal>
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
  status: "loading" | "ready" | "error";
  errorMessage: string;
  onRetry: () => void;
  searching: boolean;
  emptyTitle: string;
  emptyDescription: string;
  offlineHint: string;
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
    status,
    errorMessage,
    onRetry,
    searching,
    emptyTitle,
    emptyDescription,
    offlineHint,
  } = props;

  // 三态：加载中 / 失败（可重试）/ 就绪（再分"确实没有"和"筛选无结果"）
  if (status === "loading") {
    return <LoadingState tip="正在加载设备列表…" minHeight={320} />;
  }
  if (status === "error") {
    return <ErrorState message={errorMessage || "设备列表加载失败"} onRetry={onRetry} />;
  }
  if (rows.length === 0) {
    if (searching) {
      return (
        <EmptyState
          title="没有匹配的设备"
          description="换个设备名或设备ID关键字试试，或清空搜索框"
          icon={<SearchOutlined style={{ fontSize: 48, color: "#555" }} />}
        />
      );
    }
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        icon={<DesktopOutlined style={{ fontSize: 48, color: "#555" }} />}
      />
    );
  }

  return (
    <>
      {offlineHint && (
        <div role="status" style={{ fontSize: 12, color: "#d89614", padding: "0 0 8px" }}>
          {offlineHint}
        </div>
      )}
      <table className="sl-table">
        <thead>
          <tr>
            <th>设备名</th>
            <th style={{ width: 64 }}>状态</th>
            <th style={{ width: 70 }}>备注</th>
            {/* 900px 窗宽下主区只剩 ~440px：操作列给 220 会把状态/备注挤成竖排单字 */}
            <th style={{ width: 150, textAlign: "right" }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const isMine = myDevices.some((m) => m.id === d.id);
            const isSelf = d.id === deviceId;
            const isOn = isSelf
              ? true
              : isMine
                ? (myDevices.find((m) => m.id === d.id)?.online ?? false)
                : (onlineDevices.find((o) => o.id === d.id)?.online ?? d.online);
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
                      <Button type="primary" size="small" onClick={() => onRequestControl(d.id)}>
                        发起控制
                      </Button>
                    )}
                    {isMine && (
                      <Button size="small" onClick={() => onRename(d.id)} aria-label={`重命名设备 ${d.name || d.id}`}>
                        改名
                      </Button>
                    )}
                    {isMine && !isSelf && (
                      <Button size="small" danger onClick={() => onRemove(d.id)} aria-label={`移除设备 ${d.name || d.id}`}>
                        移除
                      </Button>
                    )}
                    {!isMine &&
                      isOn &&
                      (isTrusted(d.id) ? (
                        <Button size="small" onClick={() => onUntrust(d.id)}>
                          取消信任
                        </Button>
                      ) : (
                        <Button size="small" onClick={() => onTrust(d.id)}>
                          信任
                        </Button>
                      ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
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
  joining: boolean;
}) {
  const { role, sessionId, joinId, joinToken, setJoinId, setJoinToken, onCreate, onJoin, joining } = props;
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
            id="sl-join-session-id"
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            placeholder="会话ID"
            aria-label="会话ID"
          />
          <Input.Password
            id="sl-join-session-token"
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
            placeholder="令牌"
            aria-label="会话令牌"
            onPressEnter={onJoin}
          />
          <Button
            onClick={onJoin}
            block
            loading={joining}
            disabled={!joinId.trim() || !joinToken.trim()}
          >
            {t("main.join")}
          </Button>
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

