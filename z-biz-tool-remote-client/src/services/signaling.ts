import type { InputEventPayload, SignalMessage, WebRtcSignalPayload } from "../types";
import {
  backoffFromInterval,
  classifyCloseCode,
  classifyServerErrorCode,
  countFastFailures,
  decideReconnect,
  type BackoffOptions,
} from "./backoff";
import { DropCounter, RttProbe, watermarkNextPaused, type DropReason } from "./telemetry";

type EventHandler<T = unknown> = (payload: T) => void;

/** 连接状态机的对外状态。 */
export type SocketPhase = "idle" | "connecting" | "online" | "reconnecting" | "failed";

export interface SocketState {
  phase: SocketPhase;
  /** 距离下次重试的毫秒数（仅 reconnecting 有意义） */
  retryInMs: number | null;
  attempt: number;
  reason: string | null;
  rttMs: number | null;
}

export type RelaySupport = "unknown" | "supported" | "unsupported";

interface SignalingEvents {
  open: void;
  close: void;
  error: Event | unknown;
  message: SignalMessage;
  state: SocketState;
  "webrtc-signal": WebRtcSignalPayload;
  "screen-frame": { frame: string; fromId: string };
  "file-transfer-request": { requestId: string; fileName: string; fileSize: number; fromId: string };
  "file-transfer-progress": { requestId: string; progress: number; fromId: string };
  "file-transfer-complete": { requestId: string; fileName: string; fromId: string };
  "chat-message": { message: string; fromId: string; timestamp: number };
  "raw": unknown;
}

class Emitter {
  private handlers: Map<keyof SignalingEvents, Set<EventHandler>> = new Map();

  on<K extends keyof SignalingEvents>(event: K, handler: EventHandler<SignalingEvents[K]>) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!
.add(handler as EventHandler);
    return () => this.off(event, handler);
  }

  off<K extends keyof SignalingEvents>(event: K, handler: EventHandler<SignalingEvents[K]>) {
    this.handlers.get(event)?.delete(handler as EventHandler);
  }

  emit<K extends keyof SignalingEvents>(event: K, payload: SignalingEvents[K]) {
    this.handlers.get(event)?.forEach((h) => (h as EventHandler<SignalingEvents[K]>)(payload));
  }
}

const RTT_INTERVAL_MS = 2000;
const RTT_TIMEOUT_MS = 8000;
// JPEG 帧单帧可达数百 KB；超过 4MB 说明网络比生产快，必须先停生产者而不是继续排队
const DEFAULT_BUFFER_HIGH = 4 * 1024 * 1024;
const DEFAULT_BUFFER_LOW = 1 * 1024 * 1024;
const MAX_FAST_FAILURES = 3;

export class SignalingClient extends Emitter {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private deviceName: string | null = null;
  private deviceId: string | null = null;

  private reconnectTimer: number | null = null;
  private retryResolveDeadline = 0;
  private intentionalClose = false;
  private everOpened = false;
  private attempt = 0;
  private fastFailures = 0;
  private connectStartedAt = 0;
  private opts: BackoffOptions = backoffFromInterval(3000);
  private phase: SocketPhase = "idle";
  private phaseReason: string | null = null;

  private rtt = new RttProbe();
  private rttTimer: number | null = null;
  private drops = new DropCounter();
  private bufferedPaused = false;
  private bufferHigh = DEFAULT_BUFFER_HIGH;
  private bufferLow = DEFAULT_BUFFER_LOW;
  private visibilityBound = false;
  private relaySupport: RelaySupport = "unknown";

  // opts: { url, deviceId, deviceName?, token? }
  connect(opts: { url: string; deviceId: string; deviceName?: string; token?: string }) {
    const url = buildWsUrl(opts.url, opts.token);
    if (this.ws && this.url === url && this.phase !== "failed") return;
    this.disconnect();
    this.url = url;
    this.deviceId = opts.deviceId;
    this.deviceName = opts.deviceName || null;
    this.intentionalClose = false;
    this.attempt = 0;
    this.fastFailures = 0;
    this.relaySupport = "unknown";
    this.bindVisibility();
    this.openSocket();
  }

  // Backward-compat: positional (url, deviceId)
  connectLegacy(url: string, deviceId: string) {
    return this.connect({ url, deviceId });
  }

  private bindVisibility() {
    if (this.visibilityBound || typeof document === "undefined") return;
    this.visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.isOpen() && !this.intentionalClose) {
        // 回到前台立刻试一次，不要让用户对着"3 秒后重试"干等
        this.clearRetryTimer();
        this.attempt = Math.max(1, Math.floor(this.attempt / 2));
        this.openSocket();
      }
    });
  }

  private openSocket() {
    if (!this.url || !this.deviceId) return;
    this.cancelPendingReconnectOnly();
    this.connectStartedAt = Date.now();
    this.everOpened = false;
    this.setPhase(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.onConnectFailure(String(e));
      this.emit("error", e);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.everOpened = true;
      this.fastFailures = 0;
      this.attempt = 0;
      this.setPhase("online");
      this.send({
        type: "REGISTER",
        deviceId: this.deviceId!,
        deviceName: this.deviceName || undefined,
      });
      this.emit("open", undefined);
      this.startRttProbe();
    };

    ws.onmessage = (ev) => {
      let data: SignalMessage;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleIncoming(data);
    };

    ws.onerror = (e) => {
      this.emit("error", e);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      this.stopRttProbe();
      this.emit("close", undefined);
      if (this.intentionalClose) {
        this.setPhase("idle");
        return;
      }
      const elapsed = Date.now() - this.connectStartedAt;
      this.fastFailures = countFastFailures(this.fastFailures, elapsed, this.everOpened);
      const terminal =
        classifyCloseCode(ev.code) === "terminal" || this.fastFailures >= MAX_FAST_FAILURES;
      const reason = terminal
        ? ev.code === 1008
          ? "服务端拒绝连接(1008)"
          : this.fastFailures >= MAX_FAST_FAILURES
            ? "连接被立即拒绝，请检查服务器地址与令牌"
            : `连接被终止(${ev.code})`
        : `连接中断(${ev.code || 1006})`;
      if (terminal) {
        this.phaseReason = reason;
        this.setPhase("failed");
        return;
      }
      this.onConnectFailure(reason);
    };
  }

  private handleIncoming(data: SignalMessage) {
    this.emit("message", data);
    this.emit("raw", data);

    switch (data.type) {
      case "PING":
        this.send({ type: "PONG" });
        break;
      case "PONG":
        this.rtt.noteReceived(Date.now());
        this.setPhase(this.phase === "online" ? "online" : this.phase);
        break;
      case "ERROR": {
        if (data.code === "UNKNOWN_TYPE" && data.message === "WEBRTC_SIGNAL") {
          // 老服务端不会转发 WebRTC 信令 → 上层据此退回 JPEG 中继
          this.relaySupport = "unsupported";
          this.setPhase(this.phase);
          break;
        }
        this.relaySupport = "supported";
        if (classifyServerErrorCode(data.code) === "terminal") {
          this.intentionalClose = true;
          this.phaseReason = `服务端拒绝: ${data.message || data.code}`;
          this.setPhase("failed");
          this.disconnect();
          this.intentionalClose = true;
        }
        break;
      }
      case "WEBRTC_SIGNAL":
        this.relaySupport = "supported";
        this.emit("webrtc-signal", {
          kind: data.kind,
          sdp: data.sdp,
          candidate: data.candidate,
          fromId: data.fromId ?? "",
          sessionId: data.sessionId,
        });
        break;
      case "SCREEN_FRAME":
        this.emit("screen-frame", { frame: data.frame, fromId: data.fromId ?? "" });
        break;
      case "FILE_TRANSFER_REQUEST":
        this.emit("file-transfer-request", {
          requestId: data.requestId,
          fileName: data.fileName,
          fileSize: data.fileSize,
          fromId: data.fromId,
        });
        break;
      case "FILE_TRANSFER_PROGRESS":
        this.emit("file-transfer-progress", {
          requestId: data.requestId,
          progress: data.progress,
          fromId: data.fromId,
        });
        break;
      case "CHAT_MESSAGE":
        this.emit("chat-message", {
          message: data.message,
          fromId: data.fromId,
          timestamp: data.timestamp,
        });
        break;
      default:
        break;
    }
  }

  private onConnectFailure(reason: string) {
    this.attempt += 1;
    this.phaseReason = reason;
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.clearRetryTimer();
    const decision = decideReconnect({
      intentional: this.intentionalClose,
      terminal: this.phase === "failed",
      attempt: this.attempt,
      visible: typeof document === "undefined" ? true : document.visibilityState !== "hidden",
      opts: this.opts,
    });
    if (!decision.retry) {
      this.phaseReason =
        decision.cause === "hidden"
          ? "页面在后台，已暂停重连"
          : decision.cause === "cap"
            ? `已重试 ${this.opts.maxAttempts} 次仍失败`
            : (this.phaseReason ?? "已停止重连");
      this.setPhase(decision.cause === "hidden" ? "reconnecting" : "failed", null);
      return;
    }
    this.retryResolveDeadline = Date.now() + decision.delayMs;
    this.setPhase("reconnecting", decision.delayMs);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) this.openSocket();
    }, decision.delayMs);
  }

  /** 用户显式"断开"或组件卸载：彻底停止重试。 */
  disconnect() {
    this.intentionalClose = true;
    this.clearRetryTimer();
    this.stopRttProbe();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.drops.reset();
    this.rtt.reset();
    this.bufferedPaused = false;
    // 2026-10-04 修：这里原本**无条件** setPhase("idle")，于是覆盖掉调用方
    // 刚设好的终态。handleIncoming 的 ERROR/terminal 分支正是
    // 「setPhase("failed") → disconnect() → 再 set intentionalClose」这个顺序，
    // 结果 failed 被自己刷成 idle：UI 上表现为**令牌失效/服务端拒绝后
    // 不显示"连接失败"，而是静默回到未连接态**，用户看不出发生了什么。
    // 证据：tests/signaling.test.ts 的「ERROR/终止类 code ⇒ failed」用例，
    //   实际观测到 'idle' !== 'failed'。
    // 修法：终态（failed）优先级高于 disconnect 的收尾动作。
    //   「用户主动断开」路径不受影响——那条路 phase 本来就不是 failed。
    if (this.phase !== "failed") this.setPhase("idle");
  }

  /** 用户在 UI 上点"重试"：绕过后端退避计数立即再来一次。 */
  retryNow() {
    if (!this.url || !this.deviceId) return;
    this.intentionalClose = false;
    this.attempt = 0;
    this.fastFailures = 0;
    this.phaseReason = null;
    this.clearRetryTimer();
    this.openSocket();
  }

  setReconnectInterval(ms: number) {
    // 保留 maxAttempts 等既有策略，只挪动基数
    this.opts = { ...this.opts, ...backoffFromInterval(ms), maxAttempts: this.opts.maxAttempts };
  }

  get backoffOptions(): BackoffOptions {
    return this.opts;
  }

  get relaySignalSupport(): RelaySupport {
    return this.relaySupport;
  }

  get state(): SocketState {
    return {
      phase: this.phase,
      retryInMs: this.phase === "reconnecting" ? Math.max(0, this.retryResolveDeadline - Date.now()) : null,
      attempt: this.attempt,
      reason: this.phaseReason,
      rttMs: this.rtt.sample.lastMs,
    };
  }

  get dropStats() {
    return this.drops.snapshot();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  bufferedBytes(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * 生产端背压闸门：调用方（捕获循环）每帧问一次。
   * 超过高水位就停止生产，回提到低水位才恢复（滞回，避免抖动）。
   */
  canProduce(): boolean {
    if (!this.isOpen()) return false;
    const next = watermarkNextPaused(this.bufferedBytes(), this.bufferHigh, this.bufferLow, this.bufferedPaused);
    this.bufferedPaused = next.paused;
    return !next.paused;
  }

  get backpressureActive(): boolean {
    return this.bufferedPaused;
  }

  setBufferWatermarks(highBytes: number, lowBytes: number) {
    this.bufferHigh = Math.max(64 * 1024, highBytes);
    this.bufferLow = Math.min(this.bufferHigh, Math.max(16 * 1024, lowBytes));
  }

  /** @returns 是否真正写出；false 时已计入丢帧遥测，绝不静默丢弃。 */
  send(msg: SignalMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.drops.record(msg.type === "SCREEN_FRAME" ? "socket-closed" : "socket-closed", Date.now());
      if (msg.type === "SCREEN_FRAME") this.setPhase(this.phase);
      return false;
    }
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.drops.record(msg.type === "SCREEN_FRAME" ? "socket-closed" : "socket-closed", Date.now());
      this.emit("error", e);
      return false;
    }
  }

  /** 供捕获循环记录"因拥塞主动丢弃"的帧。 */
  noteDroppedFrame(reason: DropReason = "socket-saturated") {
    this.drops.record(reason, Date.now());
  }

  private startRttProbe() {
    this.stopRttProbe();
    const tick = () => {
      if (!this.isOpen()) return;
      this.rtt.noteSent(Date.now());
      this.send({ type: "PING" });
      this.rtt.checkTimeout(Date.now(), RTT_TIMEOUT_MS);
    };
    tick();
    this.rttTimer = window.setInterval(tick, RTT_INTERVAL_MS);
  }

  private stopRttProbe() {
    if (this.rttTimer != null) {
      clearInterval(this.rttTimer);
      this.rttTimer = null;
    }
  }

  private clearRetryTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cancelPendingReconnectOnly() {
    this.clearRetryTimer();
  }

  private setPhase(phase: SocketPhase, retryInMs?: number | null) {
    this.phase = phase;
    this.emit("state", {
      phase,
      retryInMs: retryInMs !== undefined ? retryInMs : phase === "reconnecting" ? Math.max(0, this.retryResolveDeadline - Date.now()) : null,
      attempt: this.attempt,
      reason: this.phaseReason,
      rttMs: this.rtt.sample.lastMs,
    });
  }

  // ============ 高层操作 ============

  createSession() {
    this.send({ type: "CREATE_SESSION" });
  }

  joinSession(sessionId: string, sessionToken: string) {
    this.send({ type: "JOIN_SESSION", sessionId, sessionToken });
  }

  requestControl(targetId: string, sessionId: string, ephemeral = false) {
    this.send({ type: "CONTROL_REQUEST", targetId, sessionId, ephemeral });
  }

  acceptControl(fromId: string, sessionId: string, ephemeral = false) {
    this.send({ type: "CONTROL_ACCEPT", fromId, sessionId, ephemeral });
  }

  rejectControl(fromId: string, sessionId: string, message?: string) {
    this.send({ type: "CONTROL_REJECT", fromId, sessionId, message });
  }

  sendScreenFrame(sessionId: string, frame: string, quality: number): boolean {
    return this.send({ type: "SCREEN_FRAME", sessionId, frame, timestamp: Date.now(), quality });
  }

  sendInputEvent(targetId: string, sessionId: string, event: InputEventPayload) {
    this.send({ type: "INPUT_EVENT", targetId, sessionId, event });
  }

  /** WebRTC 信令（SDP / ICE）经服务端一跳转发给对端。 */
  sendWebrtcSignal(targetId: string, sessionId: string, payload: Omit<WebRtcSignalPayload, "fromId">) {
    return this.send({ type: "WEBRTC_SIGNAL", targetId, sessionId, ...payload });
  }

  // 文件传输
  sendFileTransferRequest(sessionId: string, fileName: string, fileSize: number, requestId: string) {
    this.send({ type: "FILE_TRANSFER_REQUEST", sessionId, fileName, fileSize, requestId, fromId: this.deviceId ?? "" });
  }

  acceptFileTransfer(sessionId: string, requestId: string) {
    this.send({ type: "FILE_TRANSFER_ACCEPT", sessionId, requestId, fromId: this.deviceId ?? "" });
  }

  rejectFileTransfer(sessionId: string, requestId: string, message?: string) {
    this.send({ type: "FILE_TRANSFER_REJECT", sessionId, requestId, fromId: this.deviceId ?? "", message });
  }

  sendFileData(sessionId: string, requestId: string, data: string, isEnd: boolean) {
    this.send({ type: "FILE_DATA", sessionId, requestId, data, isEnd, fromId: this.deviceId ?? "" });
  }

  sendFileTransferProgress(sessionId: string, requestId: string, progress: number) {
    this.send({ type: "FILE_TRANSFER_PROGRESS", sessionId, requestId, progress, fromId: this.deviceId ?? "" });
  }

  // 聊天消息
  sendChatMessage(sessionId: string, message: string) {
    this.send({ type: "CHAT_MESSAGE", sessionId, message, fromId: this.deviceId ?? "", timestamp: Date.now() });
  }

  closeSession() {
    // 协议上 SESSION_CLOSED 通常由服务器推送，客户端不主动发
    // 如果要主动退出，发送一个空消息
    this.send({ type: "PONG" });
  }

  getOnlineDevices() {
    this.send({ type: "GET_ONLINE_DEVICES" });
  }

  listMyDevices() {
    this.send({ type: "LIST_MY_DEVICES" });
  }
}

// Build a ws URL with optional ?token=… query.
// If a ?token= already exists in the URL we keep it (legacy).
function buildWsUrl(rawUrl: string, token: string | undefined | null): string {
  if (!token) return rawUrl;
  // Don't double-append
  try {
    const u = new URL(rawUrl);
    if (u.searchParams.has("token")) return rawUrl;
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    // Fallback: best-effort string append
    if (rawUrl.includes("token=")) return rawUrl;
    return rawUrl + (rawUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
}

export const signaling = new SignalingClient();
