import type { InputEventPayload, SignalMessage } from "../types";

type EventHandler<T = unknown> = (payload: T) => void;

interface SignalingEvents {
  open: void;
  close: void;
  error: Event | unknown;
  message: SignalMessage;
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
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.off(event, handler);
  }

  off<K extends keyof SignalingEvents>(event: K, handler: EventHandler<SignalingEvents[K]>) {
    this.handlers.get(event)?.delete(handler as EventHandler);
  }

  emit<K extends keyof SignalingEvents>(event: K, payload: SignalingEvents[K]) {
    this.handlers.get(event)?.forEach((h) => (h as EventHandler<SignalingEvents[K]>)(payload));
  }
}

export class SignalingClient extends Emitter {
  private ws: WebSocket | null = null;
  private url: string | null = null;
  private reconnectTimer: number | null = null;
  private intentionalClose = false;
  private reconnectInterval = 3000;
  private deviceId: string | null = null;

  connect(url: string, deviceId: string) {
    if (this.ws && this.url === url) return;
    this.disconnect();
    this.url = url;
    this.deviceId = deviceId;
    this.intentionalClose = false;
    this.openSocket();
  }

  private openSocket() {
    if (!this.url || !this.deviceId) return;
    this.emit("open", undefined);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.emit("error", e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: "REGISTER", deviceId: this.deviceId! });
      this.emit("open", undefined);
    };

    ws.onmessage = (ev) => {
      let data: SignalMessage;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.emit("message", data);
      this.emit("raw", data);
      
      if (data.type === "SCREEN_FRAME") {
        this.emit("screen-frame", { frame: data.frame, fromId: data.fromId ?? "" });
      }
      if (data.type === "FILE_TRANSFER_REQUEST") {
        this.emit("file-transfer-request", {
          requestId: data.requestId,
          fileName: data.fileName,
          fileSize: data.fileSize,
          fromId: data.fromId,
        });
      }
      if (data.type === "FILE_TRANSFER_PROGRESS") {
        this.emit("file-transfer-progress", {
          requestId: data.requestId,
          progress: data.progress,
          fromId: data.fromId,
        });
      }
      if (data.type === "CHAT_MESSAGE") {
        this.emit("chat-message", {
          message: data.message,
          fromId: data.fromId,
          timestamp: data.timestamp,
        });
      }
    };

    ws.onerror = (e) => {
      this.emit("error", e);
    };

    ws.onclose = () => {
      this.ws = null;
      this.emit("close", undefined);
      if (!this.intentionalClose) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) this.openSocket();
    }, this.reconnectInterval);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  setReconnectInterval(ms: number) {
    this.reconnectInterval = Math.max(500, ms);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: SignalMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ============ 高层操作 ============

  createSession() {
    this.send({ type: "CREATE_SESSION" });
  }

  joinSession(sessionId: string, sessionToken: string) {
    this.send({ type: "JOIN_SESSION", sessionId, sessionToken });
  }

  requestControl(targetId: string, sessionId: string) {
    this.send({ type: "CONTROL_REQUEST", targetId, sessionId });
  }

  acceptControl(fromId: string, sessionId: string) {
    this.send({ type: "CONTROL_ACCEPT", fromId, sessionId });
  }

  rejectControl(fromId: string, sessionId: string, message?: string) {
    this.send({ type: "CONTROL_REJECT", fromId, sessionId, message });
  }

  sendScreenFrame(sessionId: string, frame: string, quality: number) {
    this.send({ type: "SCREEN_FRAME", sessionId, frame, timestamp: Date.now(), quality });
  }

  sendInputEvent(targetId: string, sessionId: string, event: InputEventPayload) {
    this.send({ type: "INPUT_EVENT", targetId, sessionId, event });
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
}

export const signaling = new SignalingClient();
