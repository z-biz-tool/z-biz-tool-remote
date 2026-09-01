// ============ 信令协议消息（与 server.js / 原 Electron 客户端兼容） ============

export type SignalMessage =
  | { type: "REGISTER"; deviceId: string }
  | { type: "REGISTER_SUCCESS"; deviceId: string; encryptionKey?: string }
  | { type: "CREATE_SESSION" }
  | {
      type: "SESSION_CREATED";
      sessionId: string;
      sessionToken: string;
      deviceId: string;
    }
  | {
      type: "JOIN_SESSION";
      sessionId: string;
      sessionToken: string;
    }
  | {
      type: "JOIN_SUCCESS";
      sessionId: string;
      hostId: string;
    }
  | { type: "JOIN_FAILED"; message: string }
  | { type: "CLIENT_JOINED"; clientId: string }
  | { type: "CLIENT_LEFT"; clientId: string }
  | { type: "SESSION_CLOSED"; message?: string }
  | {
      type: "CONTROL_REQUEST";
      fromId?: string;
      targetId?: string;
      sessionId?: string;
    }
  | {
      type: "CONTROL_ACCEPT";
      fromId?: string;
      targetId?: string;
      sessionId: string;
    }
  | {
      type: "CONTROL_REJECT";
      fromId?: string;
      targetId?: string;
      sessionId?: string;
      message?: string;
    }
  | { type: "CONTROL_ACCEPTED"; targetId: string }
  | { type: "CONTROL_REJECTED"; message: string }
  | { type: "CONTROL_FAILED"; message: string }
  | {
      type: "SCREEN_FRAME";
      sessionId?: string;
      frame: string;
      timestamp?: number;
      quality?: number;
      fromId?: string;
    }
  | {
      type: "INPUT_EVENT";
      targetId?: string;
      event: InputEventPayload;
      sessionId: string;
    }
  | { type: "GET_ONLINE_DEVICES" }
  | {
      type: "ONLINE_DEVICES";
      devices: Array<{ id: string; name?: string; online: boolean }>;
    }
  | { type: "PONG" }
  // 文件传输
  | {
      type: "FILE_TRANSFER_REQUEST";
      sessionId: string;
      fileName: string;
      fileSize: number;
      requestId: string;
      fromId: string;
    }
  | {
      type: "FILE_TRANSFER_ACCEPT";
      sessionId: string;
      requestId: string;
      fromId: string;
    }
  | {
      type: "FILE_TRANSFER_REJECT";
      sessionId: string;
      requestId: string;
      fromId: string;
      message?: string;
    }
  | {
      type: "FILE_DATA";
      sessionId: string;
      requestId: string;
      data: string;
      isEnd: boolean;
      fromId: string;
    }
  | {
      type: "FILE_TRANSFER_PROGRESS";
      sessionId: string;
      requestId: string;
      progress: number;
      fromId: string;
    }
  // 聊天消息
  | {
      type: "CHAT_MESSAGE";
      sessionId: string;
      message: string;
      fromId: string;
      timestamp: number;
    }
  // 系统事件
  | { type: "SYSTEM_NOTIFICATION"; message: string; fromId: string };

// ============ 内部输入事件负载类型 ============

export type InputEventPayload =
  | { type: "mouse-move"; x: number; y: number }
  | { type: "mouse-down"; button: string }
  | { type: "mouse-up"; button: string }
  | { type: "mouse-wheel"; deltaY: number; deltaX: number }
  | { type: "key-down"; key: string }
  | { type: "key-up"; key: string }
  | { type: "key-type"; text: string }
  // 热键
  | { type: "key-hotkey"; keys: string[] }
  | { type: "screen-select"; displayId: number };

// ============ 内部状态类型 ============

export type ConnectionState = "offline" | "connecting" | "online";

export type View =
  | { kind: "login" }
  | { kind: "main" }
  | { kind: "hosting"; sessionId: string; sessionToken: string }
  | {
      kind: "controlling";
      sessionId: string;
      targetId: string;
    };

export interface OnlineDevice {
  id: string;
  name: string;
  online: boolean;
}

export interface HistoryEntry {
  id: string;
  name: string;
  type: "host" | "client";
  at: number;
}

// ============ 文件传输相关 ============

export interface FileTransferRequest {
  requestId: string;
  fileName: string;
  fileSize: number;
  fromId: string;
  timestamp: number;
}

export interface FileTransferState {
  requestId: string;
  fileName: string;
  fileSize: number;
  received: number;
  progress: number;
  status: "pending" | "accepting" | "transferring" | "completed" | "failed";
}
