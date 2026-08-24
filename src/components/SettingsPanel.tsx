import { Button, Card, Form, Input, InputNumber, Slider, Space, Switch, message } from "antd";
import { useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { t } from "../i18n";

export function SettingsPanel() {
  const { settings, update } = useSettingsStore();
  const [draft, setDraft] = useState(settings);

  const onSave = () => {
    update(draft);
    message.success("设置已保存");
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
