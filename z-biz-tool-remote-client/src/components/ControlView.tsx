import { Button, Space, Tooltip, message } from "antd";
import {
  DisconnectOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  CopyOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { t } from "../i18n";

export function ControlView() {
  const { sessionId, targetDeviceId, setView, setSession, setControlling, setPaused, isPaused } =
    useSessionStore();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [lastSize, setLastSize] = useState<string>("");
  const [imgSrc, setImgSrc] = useState<string>("");

  useEffect(() => {
    setControlling(true);
    const off = signaling.on("screen-frame", ({ frame }) => {
      if (useSessionStore.getState().isPaused) return;
      setImgSrc(`data:image/jpeg;base64,${frame}`);
      setFrameCount((c) => c + 1);
    });
    return () => {
      off();
      setControlling(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 加载完成后记一下尺寸
  useEffect(() => {
    if (imgSrc && imgRef.current) {
      const img = imgRef.current;
      const onLoad = () => setLastSize(`${img.naturalWidth}×${img.naturalHeight}`);
      img.addEventListener("load", onLoad);
      if (img.complete) onLoad();
      return () => img.removeEventListener("load", onLoad);
    }
    return undefined;
  }, [imgSrc]);

  const sendEvent = (event: Parameters<typeof signaling.sendInputEvent>[2]) => {
    const s = useSessionStore.getState();
    if (!s.sessionId || !s.targetDeviceId) return;
    signaling.sendInputEvent(s.targetDeviceId, s.sessionId, event);
  };

  const onDisconnect = () => {
    setSession({ sessionId: "", role: "client" });
    setControlling(false);
    setView({ kind: "main" });
  };

  const onTogglePause = () => setPaused(!isPaused);

  const onSendClipboard = async () => {
    try {
      const text = await clipboardReadTextSafe();
      if (text) {
        sendEvent({ type: "key-type", text });
        message.success("已发送剪贴板内容");
      }
    } catch (e) {
      message.error("剪贴板读取失败: " + String(e));
    }
  };

  // 屏幕坐标 -> 远端坐标的换算
  const localToRemote = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const xRatio = (clientX - rect.left) / rect.width;
    const yRatio = (clientY - rect.top) / rect.height;
    const remW = img.naturalWidth || rect.width;
    const remH = img.naturalHeight || rect.height;
    return { x: Math.round(xRatio * remW), y: Math.round(yRatio * remH) };
  };

  return (
    <div className="view-controlling">
      <div className="control-toolbar">
        <Space>
          <Tooltip title={t("control.disconnect")}>
            <Button
              danger
              icon={<DisconnectOutlined />}
              onClick={onDisconnect}
              type="primary"
            />
          </Tooltip>
          <Tooltip title={isPaused ? t("control.resume") : t("control.pause")}>
            <Button
              icon={isPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
              onClick={onTogglePause}
            />
          </Tooltip>
          <Tooltip title={t("control.sendClipboard")}>
            <Button icon={<CopyOutlined />} onClick={onSendClipboard} />
          </Tooltip>
          <span style={{ color: "#fff", fontSize: 12 }}>
            {targetDeviceId ? targetDeviceId.slice(0, 8) : ""}…
          </span>
        </Space>
      </div>
      {imgSrc ? (
        <img
          ref={imgRef}
          className="remote-canvas"
          src={imgSrc}
          alt="remote screen"
          draggable={false}
          onMouseDown={(e) => {
            e.preventDefault();
            const { x, y } = localToRemote(e.clientX, e.clientY);
            sendEvent({ type: "mouse-move", x, y });
            sendEvent({ type: "mouse-down", button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
          }}
          onMouseUp={(e) => {
            e.preventDefault();
            sendEvent({ type: "mouse-up", button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
          }}
          onMouseMove={(e) => {
            // 节流：mousemove 每帧最多发一次
            const { x, y } = localToRemote(e.clientX, e.clientY);
            sendEvent({ type: "mouse-move", x, y });
          }}
          onContextMenu={(e) => e.preventDefault()}
          onWheel={(e) => {
            e.preventDefault();
            sendEvent({ type: "mouse-wheel", deltaY: e.deltaY, deltaX: e.deltaX });
          }}
          tabIndex={0}
        />
      ) : (
        <div className="control-empty">{t("control.empty")}</div>
      )}
      <div className="control-status">
        {sessionId} | frames={frameCount} {lastSize ? ` | ${lastSize}` : ""}
      </div>
    </div>
  );
}

async function clipboardReadTextSafe(): Promise<string> {
  try {
    // 先尝试 Tauri 剪贴板
    const m = await import("@tauri-apps/plugin-clipboard-manager");
    return await m.readText();
  } catch {
    // 退到浏览器剪贴板
    return await navigator.clipboard.readText();
  }
}
