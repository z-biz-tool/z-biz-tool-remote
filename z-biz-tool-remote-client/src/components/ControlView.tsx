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
import { startPeerAsClient, teardownPeer } from "../services/webrtc";
import { viewerMeter, setStreamMode, useStatsStore } from "../stores/statsStore";
import { StreamStatsBar } from "./StreamStatsBar";
import { t } from "../i18n";

export function ControlView() {
  const { sessionId, targetDeviceId, setView, setSession, setControlling, setPaused, isPaused } =
    useSessionStore();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [lastSize, setLastSize] = useState<string>("");
  const [imgSrc, setImgSrc] = useState<string>("");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const mode = useStatsStore((s) => s.stats.mode);

  useEffect(() => {
    setControlling(true);
    const off = signaling.on("screen-frame", ({ frame }) => {
      if (useSessionStore.getState().isPaused) return;
      viewerMeter.record(Math.round((frame.length * 3) / 4), Date.now());
      setImgSrc(`data:image/jpeg;base64,${frame}`);
      setFrameCount((c) => c + 1);
    });

    const peer = startPeerAsClient({
      onRemoteStream: (stream) => {
        setRemoteStream(stream);
        setStreamMode("display", null);
      },
      onPhase: (phase, detail) => {
        if (phase === "connected") useStatsStore.getState().patch({ peerPhase: detail });
      },
      onFallback: (reason) => {
        // 对端没 WebRTC 能力或被网络卡住：继续吃 JPEG 中继，不报错
        console.warn("webrtc viewer fallback", reason);
        teardownPeer("viewer-fallback");
      },
    });
    void peer;

    return () => {
      off();
      setControlling(false);
      teardownPeer("unmount");
      setRemoteStream(null);
      setImgSrc("");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 视频轨到位后不再需要 JPEG，让 <img> 自然停在最后一帧
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = remoteStream;
    if (!remoteStream) return;
    el.play().catch(() => undefined);
  }, [remoteStream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !remoteStream) return;
    if (isPaused) el.pause();
    else void el.play().catch(() => undefined);
  }, [isPaused, remoteStream]);

  useEffect(() => {
    if (!remoteStream) return;
    const el = videoRef.current;
    if (!el) return;
    const onLoad = () => {
      if (el.videoWidth) setLastSize(`${el.videoWidth}×${el.videoHeight}`);
    };
    el.addEventListener("loadedmetadata", onLoad);
    el.addEventListener("resize", onLoad);
    return () => {
      el.removeEventListener("loadedmetadata", onLoad);
      el.removeEventListener("resize", onLoad);
    };
  }, [remoteStream]);

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

  // 屏幕坐标 -> 远端坐标的换算（JPEG <img> 与 WebRTC <video> 共用一套）
  const activeSurface = (): { rect: DOMRect; w: number; h: number } | null => {
    if (remoteStream && videoRef.current) {
      const el = videoRef.current;
      return { rect: el.getBoundingClientRect(), w: el.videoWidth, h: el.videoHeight };
    }
    if (imgRef.current) {
      const el = imgRef.current;
      return { rect: el.getBoundingClientRect(), w: el.naturalWidth, h: el.naturalHeight };
    }
    return null;
  };

  const localToRemote = (clientX: number, clientY: number) => {
    const surf = activeSurface();
    if (!surf || surf.rect.width === 0 || surf.rect.height === 0) return { x: 0, y: 0 };
    const xRatio = (clientX - surf.rect.left) / surf.rect.width;
    const yRatio = (clientY - surf.rect.top) / surf.rect.height;
    const remW = surf.w || surf.rect.width;
    const remH = surf.h || surf.rect.height;
    return { x: Math.round(xRatio * remW), y: Math.round(yRatio * remH) };
  };

  const pointerProps = {
    onMouseDown: (e: React.MouseEvent) => {
      e.preventDefault();
      const { x, y } = localToRemote(e.clientX, e.clientY);
      sendEvent({ type: "mouse-move", x, y });
      sendEvent({ type: "mouse-down", button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
    },
    onMouseUp: (e: React.MouseEvent) => {
      e.preventDefault();
      sendEvent({ type: "mouse-up", button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" });
    },
    onMouseMove: (e: React.MouseEvent) => {
      // 节流：mousemove 每帧最多发一次
      const { x, y } = localToRemote(e.clientX, e.clientY);
      sendEvent({ type: "mouse-move", x, y });
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onWheel: (e: React.WheelEvent) => {
      e.preventDefault();
      sendEvent({ type: "mouse-wheel", deltaY: e.deltaY, deltaX: e.deltaX });
    },
    tabIndex: 0,
  };

  return (
    <div className="view-controlling">
      <div className="control-toolbar">
        <Space>
          <Tooltip title={t("control.disconnect")}>
            <Button danger icon={<DisconnectOutlined />} onClick={onDisconnect} type="primary" />
          </Tooltip>
          <Tooltip title={isPaused ? t("control.resume") : t("control.pause")}>
            <Button icon={isPaused ? <PlayCircleOutlined /> : <PauseOutlined />} onClick={onTogglePause} />
          </Tooltip>
          <Tooltip title={t("control.sendClipboard")}>
            <Button icon={<CopyOutlined />} onClick={onSendClipboard} />
          </Tooltip>
          <span style={{ color: "#fff", fontSize: 12 }}>
            {targetDeviceId ? targetDeviceId.slice(0, 8) : ""}…
          </span>
          <StreamStatsBar side="viewer" />
        </Space>
      </div>
      {remoteStream ? (
        <video
          ref={videoRef}
          className="remote-canvas"
          autoPlay
          playsInline
          muted
          draggable={false}
          {...pointerProps}
        />
      ) : imgSrc ? (
        <img ref={imgRef} className="remote-canvas" src={imgSrc} alt="remote screen" draggable={false} {...pointerProps} />
      ) : (
        <div className="control-empty">{t("control.empty")}</div>
      )}
      <div className="control-status">
        {sessionId} | frames={frameCount} {lastSize ? ` | ${lastSize}` : ""}
        {mode === "relay" && frameCount === 0 ? " | 等待画面（对端未推流）" : ""}
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
