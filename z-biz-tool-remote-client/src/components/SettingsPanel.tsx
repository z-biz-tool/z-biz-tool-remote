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

  // 加载显示器列表
  useEffect(() => {
    loadDisplays();
  }, []);

  const loadDisplays = async () => {
    try {
      const displays = await invoke<DisplayInfo[]>("list_displays");
      setDisplays(displays);
      if (displays.length > 0 && selectedDisplay === null) {
        setSelectedDisplay(displays.find((d) => d.is_primary)?.id ?? displays[0].id);
      }
    } catch (e) {
      console.error("加载显示器列表失败:", e);
    }
  };

  const onSave = () => {
    const clean = displayUrl(draft.serverUrl);
    update({ ...draft, serverUrl: clean });
    setDraft({ ...draft, serverUrl: clean });
    touchServer(clean);
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
    addServer(url);
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
            placeholder="101.37.80.51:8080"
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
                    <span style={{ fontFamily: "monospace" }}>{p.url}</span>
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
              <div style={{ color: "#ff4d4f", fontSize: 12 }}>未检测到显示器</div>
            )}
          </Form.Item>
        )}
        
        <Form.Item label={`${t("settings.quality")}: ${draft.frameQuality}`}>
          <Slider
            min={20}
            max={95}
            value={draft.frameQuality}
            onChange={(v) => setDraft({ ...draft, frameQuality: v })}
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
          />
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
            <Space>
              <Switch
                checked={draft.allowFileTransfer}
                onChange={(v) => setDraft({ ...draft, allowFileTransfer: v })}
              />
              <span>{t("settings.fileTransfer")}</span>
            </Space>
            <Space>
              <Switch
                checked={draft.allowChat}
                onChange={(v) => setDraft({ ...draft, allowChat: v })}
              />
              <span>{t("settings.chat")}</span>
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
