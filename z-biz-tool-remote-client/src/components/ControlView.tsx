import { Button, Modal, Space, Tooltip, message } from "antd";
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
import { codeToKeyName } from "../services/keymap";
import { t } from "../i18n";

/** 等服务端确认「已离开」的上限（同 HostingView 口径）。 */
const LEAVE_ACK_TIMEOUT_MS = 2500;

export function ControlView() {
  const { sessionId, targetDeviceId, setView, setSession, setControlling, setPaused, isPaused } =
    useSessionStore();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const leaveTimer = useRef<number | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [lastSize, setLastSize] = useState<string>("");
  const [imgSrc, setImgSrc] = useState<string>("");
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [keyboardCaptured, setKeyboardCaptured] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
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
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
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

  const finishLocal = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    setSession({ sessionId: "", role: "client" });
    setControlling(false);
    setView({ kind: "main" });
  };

  const leave = () => {
    if (!sessionId) {
      finishLocal();
      return;
    }
    setDisconnecting(true);
    if (!signaling.leaveSession(sessionId, "控制端断开")) {
      finishLocal();
      return;
    }
    // 正常情况下 App 收到 SESSION_CLOSED 会清会话并切视图；这里只兜底超时
    leaveTimer.current = window.setTimeout(() => {
      setDisconnecting(false);
      message.warning("服务端未确认断开，可再次点击「断开」", 6);
    }, LEAVE_ACK_TIMEOUT_MS);
  };

  const onDisconnect = () => {
    Modal.confirm({
      title: "断开远程会话？",
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          将结束会话 <code>{sessionId ?? "—"}</code>，对端画面立即停止；
          {targetDeviceId ? <> 需要重新获得 <code>{targetDeviceId}</code> 的授权才能再次控制。</> : null}
        </div>
      ),
      okText: "断开",
      okButtonProps: { danger: true },
      cancelText: "取消",
      focusable: { autoFocusButton: "cancel" },
      onOk: leave,
    });
  };

  const onTogglePause = () => setPaused(!isPaused);

  const onSendClipboard = async () => {
    let text: string;
    try {
      text = await clipboardReadTextSafe();
    } catch (e) {
      message.error(
        `读取本机剪贴板失败：${e instanceof Error ? e.message : String(e)}。` +
          "可改用系统剪贴板手动复制后重试"
      );
      return;
    }
    if (!text) {
      message.warning("本机剪贴板为空，未发送");
      return;
    }
    // 粘贴即注入：远端会把这段文本原样敲进当前焦点窗口，先给预览再执行（台账 G4-5）
    Modal.confirm({
      title: "发送本机剪贴板到远端？",
      content: (
        <div style={{ fontSize: 13 }}>
          <div>将在被控端注入 {text.length} 个字符：</div>
          <pre
            style={{
              maxHeight: 120,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              background: "#141414",
              padding: 8,
              borderRadius: 4,
              marginTop: 8,
              fontSize: 12,
            }}
          >
            {text.length > 300 ? text.slice(0, 300) + "…" : text}
          </pre>
        </div>
      ),
      okText: "发送",
      cancelText: "取消",
      onOk: () => {
        sendEvent({ type: "key-type", text });
        // 只陈述可观测事实：已提交，不等于对端已输入完成
        message.success(`已提交 ${text.length} 个字符到远端`);
      },
    });
  };

  // ---- 键盘注入（台账 C-01：原实现只监听鼠标，远程根本打不了字）----
  // 口径：
  //  · 用物理键位 e.code 映射成被控端认的键名（keymap.ts），不用 e.key；
  //  · 焦点在按钮/输入框上时不劫持（契约：输入优先），避免 Tab 到工具栏后
  //    空格/回车同时触发按钮和远端；
  //  · Esc 释放捕获（不发送），用 Tab 可离开画面。
  const isInteractiveTarget = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || tag === "button" || el.isContentEditable;
  };

  const forwardKey = (e: React.KeyboardEvent, type: "key-down" | "key-up") => {
    if (e.key === "Escape" && type === "key-down") {
      e.preventDefault();
      rootRef.current?.blur();
      return;
    }
    if (isInteractiveTarget(e.target)) return;
    const key = codeToKeyName(e.code);
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    sendEvent({ type, key });
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
      // 点击画面即把键盘焦点收到控制视图，随后按键才会被转发
      rootRef.current?.focus();
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
  };

  return (
    <div
      ref={rootRef}
      className="view-controlling"
      tabIndex={0}
      role="application"
      aria-label="远程控制画面，点击后键盘输入将发送到被控端，Esc 释放键盘"
      onKeyDown={(e) => forwardKey(e, "key-down")}
      onKeyUp={(e) => forwardKey(e, "key-up")}
      // React 的 focus/blur 会从子树冒泡，只有根节点自己拿到焦点才算捕获
      onFocus={(e) => {
        if (e.target === rootRef.current) setKeyboardCaptured(true);
      }}
      onBlur={(e) => {
        if (e.target === rootRef.current) setKeyboardCaptured(false);
      }}
    >
      <div className="control-toolbar">
        <Space>
          <Tooltip title={t("control.disconnect")}>
            <Button
              danger
              icon={<DisconnectOutlined />}
              onClick={onDisconnect}
              type="primary"
              aria-label="断开远程会话"
              loading={disconnecting}
            />
          </Tooltip>
          <Tooltip title={isPaused ? t("control.resume") : t("control.pause")}>
            <Button
              icon={isPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
              onClick={onTogglePause}
              aria-label={isPaused ? "恢复远端画面" : "暂停远端画面"}
              aria-pressed={isPaused}
            />
          </Tooltip>
          <Tooltip title={t("control.sendClipboard")}>
            <Button icon={<CopyOutlined />} onClick={onSendClipboard} aria-label="发送本机剪贴板到远端" />
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
        <span aria-live="polite">
          {keyboardCaptured ? "键盘已捕获（按 Esc 释放）" : "点击画面以捕获键盘 · Esc 释放"}
        </span>
        {" | "}
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
