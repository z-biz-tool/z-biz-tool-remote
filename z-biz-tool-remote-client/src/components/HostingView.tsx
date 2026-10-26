import { Alert, Button, Modal, Space, Tag, Tooltip, message } from "antd";
import {
  CopyOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { startCaptureLoop, stopCaptureLoop } from "../services/capture";
import { StreamStatsBar } from "./StreamStatsBar";
import { t } from "../i18n";

/** 令牌显示 10s 后自动遮罩（台账 S1-D01 / U-07）。 */
const TOKEN_REVEAL_MS = 10_000;
/** 等服务端 SESSION_CLOSED 的上限；超时要如实说「没确认」，不能假装成功。 */
const LEAVE_ACK_TIMEOUT_MS = 2500;

function formatElapsed(since: number | null): string {
  if (!since) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function HostingView() {
  const {
    sessionId,
    sessionToken,
    controllerId,
    controllerSince,
    inputPaused,
    setView,
    setSession,
    setHosting,
    setInputPaused,
    setController,
  } = useSessionStore();
  const [revealed, setRevealed] = useState(false);
  const [ending, setEnding] = useState(false);
  const [, tick] = useState(0);
  const hideTimer = useRef<number | null>(null);
  const endTimer = useRef<number | null>(null);

  useEffect(() => {
    setHosting(true);
    startCaptureLoop();
    return () => {
      stopCaptureLoop();
      setHosting(false);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
      if (endTimer.current) window.clearTimeout(endTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「正在被控制」的时长每秒刷新一次
  useEffect(() => {
    if (!controllerId) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [controllerId]);

  const revealToken = () => {
    setRevealed(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setRevealed(false), TOKEN_REVEAL_MS);
  };

  const copyToken = async () => {
    if (!sessionToken) return;
    try {
      await navigator.clipboard.writeText(sessionToken);
      // 成功提示只在写入真正成功后出现（原先先弹「已复制」再写，失败也照样提示）
      message.success("已复制会话令牌，请勿泄露（复制后 10s 自动遮罩）");
      revealToken();
    } catch (e) {
      message.error(`复制失败：${e instanceof Error ? e.message : String(e)}。可点「显示」后手动选中复制`);
    }
  };

  const finishLocal = () => {
    if (endTimer.current) window.clearTimeout(endTimer.current);
    stopCaptureLoop();
    setHosting(false);
    setController(null);
    setSession({ sessionId: "", role: "host" });
    setView({ kind: "main" });
  };

  const leave = () => {
    const sid = sessionId;
    if (!sid) {
      finishLocal();
      return;
    }
    setEnding(true);
    // 先停推流：即使服务端确认慢，也不再往对端送画面
    stopCaptureLoop();
    const sent = signaling.leaveSession(sid, "主持人结束会话");
    if (!sent) {
      finishLocal();
      message.warning("连接已断开，会话已在本地结束（服务端可能仍认为会话存在）", 6);
      return;
    }
    endTimer.current = window.setTimeout(() => {
      // 没等到 SESSION_CLOSED：不静默切走，告诉用户发生了什么
      setEnding(false);
      message.warning("服务端未确认会话结束，请检查网络后重试", 6);
    }, LEAVE_ACK_TIMEOUT_MS);
  };

  const onStop = () => {
    Modal.confirm({
      title: "结束当前远程会话？",
      content: (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          会话 <code>{sessionId ?? "—"}</code> 将被关闭，对端画面立即中断。
          {controllerId ? (
            <div style={{ color: "#ff7875" }}>
              当前正在控制本机的 <code>{controllerId}</code> 会被断开。
            </div>
          ) : null}
        </div>
      ),
      okText: "结束会话",
      okButtonProps: { danger: true },
      cancelText: "取消",
      // 默认焦点在「取消」：破坏性操作不把用户推到确认键上
      focusable: { autoFocusButton: "cancel" },
      onOk: leave,
    });
  };

  return (
    <div className="view-hosting">
      {/* 还没人接入时不能写「正在被远程控制」——标题必须与真实状态一致 */}
      <h2>{controllerId ? t("hosting.title") : t("hosting.waiting")}</h2>

      {/* 常驻状态：谁在看、看了多久（台账 S1-D01 / U-06） */}
      <Alert
        type={controllerId ? "warning" : "info"}
        showIcon
        role="status"
        aria-live="polite"
        style={{ marginBottom: 12, textAlign: "left" }}
        title={
          controllerId ? (
            <Space wrap>
              <Tag color="red">控制中</Tag>
              <span>
                正在被 <code>{controllerId}</code> 控制
              </span>
              <span style={{ opacity: 0.8 }}>已持续 {formatElapsed(controllerSince)}</span>
            </Space>
          ) : (
            <span>等待控制端接入（把下方会话 ID 与令牌发给对方）</span>
          )
        }
        description={
          inputPaused
            ? "已暂停输入：远端键鼠事件会被丢弃，画面仍在共享。"
            : controllerId
              ? "如需夺回鼠标键盘，点「暂停输入」；随时可「结束会话」。"
              : undefined
        }
      />

      <div style={{ opacity: 0.85 }}>{t("hosting.shareHint")}</div>
      <div className="session-code">{sessionId || "—"}</div>
      <StreamStatsBar side="host" />

      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
        <span style={{ opacity: 0.85 }}>Token:</span>
        <span className="session-code" style={{ fontSize: 18, padding: "6px 12px" }}>
          {sessionToken ? (revealed ? sessionToken : "•".repeat(12)) : "—"}
        </span>
        <Tooltip title={revealed ? "隐藏令牌" : "显示令牌（10s 后自动遮罩）"}>
          <Button
            icon={revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
            aria-label={revealed ? "隐藏会话令牌" : "显示会话令牌"}
            onClick={() => (revealed ? setRevealed(false) : revealToken())}
            disabled={!sessionToken}
          />
        </Tooltip>
        <Tooltip title="复制令牌（请勿泄露）">
          <Button
            icon={<CopyOutlined />}
            aria-label="复制会话令牌"
            onClick={copyToken}
            disabled={!sessionToken}
          />
        </Tooltip>
      </div>

      <Space style={{ marginTop: 16 }} wrap>
        <Button
          icon={inputPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
          onClick={() => {
            const next = !inputPaused;
            setInputPaused(next);
            message.info(next ? "已暂停远端输入（画面继续共享）" : "已恢复远端输入");
          }}
          aria-pressed={inputPaused}
        >
          {inputPaused ? "恢复输入" : "暂停输入"}
        </Button>
        <Button
          danger
          type="primary"
          icon={<PoweroffOutlined />}
          onClick={onStop}
          loading={ending}
        >
          {ending ? "正在结束…" : t("hosting.stop")}
        </Button>
      </Space>
    </div>
  );
}
