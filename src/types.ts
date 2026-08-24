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
  | { type: "PONG" };

export type InputEventPayload =
  | { type: "mouse-move"; x: number; y: number }
  | { type: "mouse-down"; button: string }
  | { type: "mouse-up"; button: string }
  | { type: "mouse-wheel"; deltaY: number; deltaX: number }
  | { type: "key-down"; key: string }
  | { type: "key-up"; key: string }
  | { type: "key-type"; text: string };

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
