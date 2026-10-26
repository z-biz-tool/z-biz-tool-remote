import { Button, Card, Form, Input, InputNumber, List, Popconfirm, Select, Slider, Space, Switch, Tag, message } from "antd";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { t } from "../i18n";
import { useSessionStore } from "../stores/sessionStore";
import { startCaptureLoop, setSelectedDisplayId } from "../services/capture";
import {
  FRAME_WIDTH_OPTIONS,
  getServerPresets,
  addServer,
  removeServer,
  touchServer,
  displayUrl,
  cleanAddress,
  describeWsUrl,
  type ServerPreset,
} from "../services/storage";

interface DisplayInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  is_primary: boolean;
}

export function SettingsPanel() {
  const { settings, update } = useSettingsStore();
  const { role, sessionId, isHosting } = useSessionStore();
  const [draft, setDraft] = useState(settings);
  const [displays, setDisplays] = useState<{ id: number; name: string; width: number; height: number; is_primary: boolean }[]>([]);
  const [selectedDisplay, setSelectedDisplay] = useState<number | null>(null);
  // 显示器列表是 Tauri 侧能力，跑在浏览器里必然失败；失败要说出来而不是只进 console
  const [displaysError, setDisplaysError] = useState<string>("");

  // 加载显示器列表
  useEffect(() => {
    void loadDisplays();
  }, []);

  const loadDisplays = async () => {
    try {
      const list = await invoke<DisplayInfo[]>("list_displays");
      setDisplays(list);
      setDisplaysError("");
      if (list.length > 0 && selectedDisplay === null) {
        setSelectedDisplay(list.find((d) => d.is_primary)?.id ?? list[0].id);
      }
    } catch (e) {
      setDisplays([]);
      setDisplaysError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSave = () => {
    // ⚠️ 这里原来用 `displayUrl(draft.serverUrl)` —— 那会把**协议一起剥掉**。
    // 而本机地址在缺省时按 ws:// 处理，于是「用户显式填的 wss://」在保存那一刻
    // 就被降级成明文了。现在由 describeWsUrl 统一裁决，并原样保留协议。
    const plan = describeWsUrl(draft.serverUrl);
    if (plan.error) {
      message.error(plan.error, 8);
      return;
    }
    const clean = cleanAddress(draft.serverUrl);
    const next = { ...draft, serverUrl: clean };
    update(next);
    setDraft(next);
    touchServer(plan.url);
    message.success("设置已保存");
    setPresets(getServerPresets());

    // 如果正在托管且显示器切换了，重启捕获
    if (isHosting && sessionId && selectedDisplay !== null) {
      setSelectedDisplayId(selectedDisplay);
      startCaptureLoop(selectedDisplay);
    }
  };

  const [presets, setPresets] = useState<ServerPreset[]>(getServerPresets());
  const [newServerUrl, setNewServerUrl] = useState("");
  const refreshPresets = () => setPresets(getServerPresets());

  const onAddServer = () => {
    const url = newServerUrl.trim();
    if (!url) return;
    // 存**实际会用的**地址（含协议），否则挑回来时会按缺省重新推导一遍，
    // 「本机 + 显式 wss://」就会掉回明文 ws://。
    const plan = describeWsUrl(url);
    if (plan.error) {
      message.error(plan.error, 8);
      return;
    }
    addServer(plan.url);
    setNewServerUrl("");
    refreshPresets();
    message.success("已添加");
  };
  const onPickServer = (url: string) => {
    setDraft({ ...draft, serverUrl: url });
    touchServer(url);
    refreshPresets();
    message.info(`已选择 ${url} (点保存应用)`);
  };
  const onRemoveServer = (url: string) => {
    removeServer(url);
    refreshPresets();
  };

  const handleDisplayChange = (value: number) => {
    setSelectedDisplay(value);
    if (isHosting && sessionId) {
      startCaptureLoop(value);
    }
  };

  return (
    <Card title={t("settings.title")} size="small">
      <Form layout="vertical" size="small">
        <Form.Item label={t("settings.server")}>
          <Input
            value={draft.serverUrl}
            onChange={(e) => setDraft({ ...draft, serverUrl: e.target.value })}
            placeholder="signaling.example.com:8443"
          />
        </Form.Item>

        <Form.Item label="已保存的服务器 (点切换,保存后应用)">
          <List
            size="small"
            dataSource={presets}
            locale={{ emptyText: "还没有保存的服务器" }}
            renderItem={(p) => {
              const isCurrent = p.url === draft.serverUrl;
              return (
                <List.Item
                  actions={[
                    !isCurrent && (
                      <Button key="pick" size="small" type="link" onClick={() => onPickServer(p.url)}>
                        使用
                      </Button>
                    ),
                    <Popconfirm
                      key="del"
                      title="确认删除?"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => onRemoveServer(p.url)}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>,
                  ].filter(Boolean)}
                >
                  <Space>
                    {isCurrent && <Tag color="blue">当前</Tag>}
                    <span style={{ fontFamily: "monospace" }}>{displayUrl(p.url)}</span>
                    {p.label && <span style={{ color: "#999" }}>({p.label})</span>}
                  </Space>
                </List.Item>
              );
            }}
          />
          <Space.Compact style={{ width: "100%", marginTop: 8 }}>
            <Input
              value={newServerUrl}
              onChange={(e) => setNewServerUrl(e.target.value)}
              placeholder="signaling.other.com:8080"
              onPressEnter={onAddServer}
            />
            <Button type="primary" onClick={onAddServer}>
              添加
            </Button>
          </Space.Compact>
        </Form.Item>
        
        {role === "host" && (
          <Form.Item label={t("settings.monitor")}>
            <Select
              value={selectedDisplay ?? (displays.find((d) => d.is_primary)?.id ?? null)}
              onChange={handleDisplayChange}
              style={{ width: "100%" }}
              options={displays.map((d) => ({
                value: d.id,
                label: `${d.name} (${d.width}x${d.height})${d.is_primary ? " (主显示器)" : ""}`,
              }))}
              placeholder="选择要共享的显示器"
            />
            {displays.length === 0 && (
              <div style={{ color: "#ff4d4f", fontSize: 12, marginTop: 4 }}>
                {displaysError
                  ? `无法获取显示器列表：${displaysError}`
                  : "未检测到显示器"}
                {" "}
                <Button type="link" size="small" onClick={() => void loadDisplays()}>
                  重试
                </Button>
              </div>
            )}
          </Form.Item>
        )}
        
        <Form.Item label={`${t("settings.quality")}: ${draft.frameQuality}`}>
          <Slider
            min={20}
            max={95}
            value={draft.frameQuality}
            onChange={(v) => setDraft({ ...draft, frameQuality: v })}
            onChangeComplete={(v) => update({ frameQuality: v })}
          />
        </Form.Item>
        <Form.Item label={`最大宽度: ${draft.maxFrameWidth === 0 ? "原生" : draft.maxFrameWidth + "px"}`}>
          <Select
            value={draft.maxFrameWidth}
            onChange={(v) => setDraft({ ...draft, maxFrameWidth: v })}
            style={{ width: "100%" }}
            options={FRAME_WIDTH_OPTIONS.map((w) => ({
              value: w,
              label:
                w === 0
                  ? "原生 (不缩放)"
                  : `${w}px${w === 1280 ? " (推荐)" : ""}`,
            }))}
          />
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            超过此宽度会按等比例缩小,显著降低带宽/卡顿。2K/Retina 屏建议 1280。
          </div>
        </Form.Item>
        <Form.Item label={`${t("settings.fps")}: ${draft.fps}`}>
          <Slider
            min={1}
            max={30}
            value={draft.fps}
            onChange={(v) => setDraft({ ...draft, fps: v })}
            onChangeComplete={(v) => update({ fps: v })}
          />
          <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>
            松手即生效，无需重开会话；实际帧率见画面下方的遥测条。
          </div>
        </Form.Item>
        <Form.Item label={t("settings.reconnect")}>
          <InputNumber
            min={500}
            max={60000}
            step={500}
            value={draft.reconnectInterval}
            onChange={(v) => setDraft({ ...draft, reconnectInterval: Number(v) || 3000 })}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item>
          <Space direction="vertical" style={{ width: "100%" }}>
            <Space>
              <Switch
                checked={draft.requirePermission}
                onChange={(v) => setDraft({ ...draft, requirePermission: v })}
              />
              <span>{t("settings.requirePermission")}</span>
            </Space>
            <Space>
              <Switch
                checked={draft.allowClipboardSync}
                onChange={(v) => setDraft({ ...draft, allowClipboardSync: v })}
              />
              <span>{t("settings.clipboardSync")}</span>
            </Space>
            <div style={{ fontSize: 12, color: "#888", marginLeft: 44, marginTop: -6 }}>
              关闭后本机会丢弃远端发来的「粘贴文本」事件（键鼠控制不受影响）。
            </div>
            <Space>
              <Switch checked={draft.allowFileTransfer} disabled />
              <span style={{ color: "#888" }}>{t("settings.fileTransfer")}</span>
              <span style={{ fontSize: 12, color: "#888" }}>服务端未实现文件通道，暂不可用</span>
            </Space>
            <Space>
              <Switch checked={draft.allowChat} disabled />
              <span style={{ color: "#888" }}>{t("settings.chat")}</span>
              <span style={{ fontSize: 12, color: "#888" }}>服务端未实现消息通道，暂不可用</span>
            </Space>
          </Space>
        </Form.Item>
        <Form.Item>
          <Button type="primary" onClick={onSave} block>
            {t("settings.save")}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
