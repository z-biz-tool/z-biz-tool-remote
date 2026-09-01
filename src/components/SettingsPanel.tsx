import { Button, Card, Form, Input, InputNumber, Select, Slider, Space, Switch, message } from "antd";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { t } from "../i18n";
import { useSessionStore } from "../stores/sessionStore";
import { startCaptureLoop, setSelectedDisplayId } from "../services/capture";

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
    update(draft);
    message.success("设置已保存");
    
    // 如果正在托管且显示器切换了，重启捕获
    if (isHosting && sessionId && selectedDisplay !== null) {
      setSelectedDisplayId(selectedDisplay);
      startCaptureLoop(selectedDisplay);
    }
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
            placeholder="ws://host:port"
          />
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
