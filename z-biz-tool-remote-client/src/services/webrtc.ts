/**
 * 真实 WebRTC 通道：RTCPeerConnection + 经信令服务端一跳转发的 SDP/ICE。
 * 协商采用 perfect-negotiation 风格（polite/impolite + glare 处理 + ICE trickle），
 * 任何一步失败都通过 onFallback 通知上层退回 JPEG 中继，绝不"两头都不可用"。
 */
import type { WebRtcSignalPayload } from "../types";

export type PeerPhase = "idle" | "gathering" | "negotiating" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerHandlers {
  onRemoteStream?(stream: MediaStream): void;
  onPhase?(phase: PeerPhase, detail: string): void;
  /** reason 例：no-webrtc / relay-unsupported / ice-failed / timeout */
  onFallback?(reason: string): void;
}

export interface PeerTarget {
  targetId: string;
  sessionId: string;
}

const ICE_SERVERS: RTCIceServer[] = [
  // 只用公共 STUN 做公网地址发现；被墙/离线时 host candidate 仍能在局域网直连
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const CONNECT_TIMEOUT_MS = 12_000;

export interface PeerStats {
  fps: number;
  kbps: number;
  rttMs: number | null;
  width: number;
  height: number;
  qualityLimitReason: string | null;
}

export function webrtcAvailable(): boolean {
  return typeof RTCPeerConnection === "function";
}

export function displayCaptureAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function";
}

export class WebrtcSession {
  private pc: RTCPeerConnection | null = null;
  private senders = new Map<MediaStreamTrack["kind"], RTCRtpSender>();
  private pendingIce: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private connectedFlag = false;
  private timeoutTimer: number | null = null;
  private closed = false;
  private phaseValue: PeerPhase = "idle";

  readonly polite: boolean;

  constructor(
    initiator: boolean,
    private readonly handlers: PeerHandlers,
    private readonly sendSignal: (payload: Omit<WebRtcSignalPayload, "fromId">) => boolean,
  ) {
    // initiator（被控端）设不礼貌，避免与对端的并发 offer 互相覆盖
    this.polite = !initiator;
  }

  get phase(): PeerPhase {
    return this.phaseValue;
  }

  get isConnected(): boolean {
    return this.connectedFlag;
  }

  private setPhase(p: PeerPhase, detail = "") {
    this.phaseValue = p;
    this.handlers.onPhase?.(p, detail);
  }

  start(): boolean {
    if (this.pc || this.closed) return !!this.pc;
    if (!webrtcAvailable()) {
      this.handlers.onFallback?.("no-webrtc");
      return false;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
    this.pc = pc;

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      this.sendSignal({ kind: "ice", candidate: (e.candidate.toJSON?.() ?? null) as Record<string, unknown> | null });
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.handlers.onRemoteStream?.(stream);
    };

    pc.onnegotiationneeded = () => {
      void this.createAndSendOffer();
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") this.markConnected();
      else if (s === "failed") this.fail("ice-failed");
      else if (s === "disconnected") this.setPhase("disconnected", "disconnected");
      else if (s === "closed") this.setPhase("closed", "closed");
      else this.setPhase("negotiating", s);
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") this.fail("ice-failed");
    };

    this.setPhase("negotiating", "created");
    // offer 由 addTrack 触发的 negotiationneeded 发出，避免零轨空 offer
    this.armConnectTimeout();
    return true;
  }

  private armConnectTimeout() {
    if (this.timeoutTimer != null || this.closed) return;
    this.timeoutTimer = window.setTimeout(() => {
      this.timeoutTimer = null;
      if (!this.connectedFlag) this.fail("timeout");
    }, CONNECT_TIMEOUT_MS);
  }

  private markConnected() {
    if (this.connectedFlag) return;
    this.connectedFlag = true;
    if (this.timeoutTimer != null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.setPhase("connected", "connected");
  }

  private fail(reason: string) {
    if (this.closed || this.phaseValue === "failed") return;
    this.setPhase("failed", reason);
    this.handlers.onFallback?.(reason);
  }

  private async createAndSendOffer() {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription(await pc.createOffer());
      const desc = pc.localDescription;
      if (desc) this.sendSignal({ kind: desc.type === "answer" ? "answer" : "offer", sdp: desc.sdp });
    } catch (e) {
      this.fail("offer-error");
      console.warn("createOffer failed", e);
    } finally {
      this.makingOffer = false;
    }
  }

  /** 挂载/替换上行轨道：换源时走 replaceTrack，避免整条 PeerConnection 重建。 */
  async attachStream(stream: MediaStream): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    for (const track of stream.getTracks()) {
      const existing = this.senders.get(track.kind);
      if (existing && existing.track !== track) {
        await existing.replaceTrack(track).catch(() => this.setPhase("negotiating", "replace-failed"));
      } else if (!existing) {
        this.senders.set(track.kind, pc.addTrack(track, stream));
      }
    }
  }

  async handleSignal(payload: WebRtcSignalPayload): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;

    if (payload.kind === "ice") {
      const candidate = (payload.candidate ?? undefined) as RTCIceCandidateInit | undefined;
      if (!candidate) return;
      if (!pc.remoteDescription) {
        this.pendingIce.push(candidate);
        return;
      }
      await pc.addIceCandidate(candidate).catch(() => {
        if (!this.ignoreOffer) console.warn("addIceCandidate rejected");
      });
      return;
    }

    const desc: RTCSessionDescriptionInit = { type: payload.kind, sdp: payload.sdp ?? "" };
    const collision = desc.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;

    await pc.setRemoteDescription(desc);
    await this.flushPendingIce();

    if (desc.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      const local = pc.localDescription;
      if (local) this.sendSignal({ kind: "answer", sdp: local.sdp });
    }
  }

  private async flushPendingIce() {
    const pc = this.pc;
    if (!pc) return;
    const queue = this.pendingIce;
    this.pendingIce = [];
    for (const c of queue) await pc.addIceCandidate(c).catch(() => undefined);
  }

  /** 主动 ICE 重启（网络切换后 host candidate 全失效时用）。 */
  async restartIce(): Promise<void> {
    if (!this.pc || this.closed) return;
    await this.createAndSendOffer();
  }

  async sampleStats(): Promise<PeerStats | null> {
    const pc = this.pc;
    if (!pc || this.closed) return null;
    let report: RTCStatsReport;
    try {
      report = await pc.getStats();
    } catch {
      return null;
    }
    let fps = 0;
    let bytes = 0;
    let timestamp = 0;
    let width = 0;
    let height = 0;
    let rttMs: number | null = null;
    let qualityLimit: string | null = null;
    report.forEach((entry) => {
      const rec = entry as unknown as Record<string, number | string>;
      if (entry.type === "candidate-pair" && rec.state === "succeeded" && typeof rec.currentRoundTripTime === "number") {
        rttMs = Math.round(rec.currentRoundTripTime * 1000);
      }
      if (entry.type === "inbound-rtp" || entry.type === "outbound-rtp") {
        if (typeof rec.framesPerSecond === "number") fps = rec.framesPerSecond;
        if (typeof rec.width === "number") width = rec.width;
        if (typeof rec.height === "number") height = rec.height;
        if (typeof rec.qualityLimitationReason === "string") qualityLimit = rec.qualityLimitationReason;
        if (entry.type === "inbound-rtp") {
          bytes = typeof rec.bytesReceived === "number" ? rec.bytesReceived : bytes;
          timestamp = typeof rec.timestamp === "number" ? rec.timestamp : timestamp;
        } else {
          bytes = typeof rec.bytesSent === "number" ? rec.bytesSent : bytes;
          timestamp = typeof rec.timestamp === "number" ? rec.timestamp : timestamp;
        }
      }
    });
    // getStats 给的是累计值，增量码率靠上次采样算
    const kbps = this.deriveKbps(bytes, timestamp);
    this.lastBytes = bytes;
    this.lastTimestamp = timestamp;
    return { fps: Math.round(fps * 10) / 10, kbps, rttMs, width, height, qualityLimitReason: qualityLimit };
  }

  private lastBytes = 0;
  private lastTimestamp = 0;

  private deriveKbps(bytes: number, timestamp: number): number {
    if (!this.lastTimestamp || timestamp <= this.lastTimestamp || bytes < this.lastBytes) return 0;
    const seconds = (timestamp - this.lastTimestamp) / 1000;
    return Math.round(((bytes - this.lastBytes) * 8) / 1000 / seconds * 10) / 10;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timeoutTimer != null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    const pc = this.pc;
    this.pc = null;
    this.senders.clear();
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.getSenders().forEach((s) => s.track?.stop());
      } catch {
        // ignore
      }
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    this.setPhase("closed", "closed");
  }
}

// ============ 单例编排：一个会话同一时刻只有一条 PeerConnection ============

let active: WebrtcSession | null = null;
let role: "host" | "client" | null = null;
let boundHandlers: PeerHandlers | null = null;
let sendSignalFn: (payload: Omit<WebRtcSignalPayload, "fromId">) => boolean = () => false;

export function bindPeerRuntime(opts: {
  sendSignal: (payload: Omit<WebRtcSignalPayload, "fromId">) => boolean;
}) {
  sendSignalFn = opts.sendSignal;
}

export function currentPeer(): WebrtcSession | null {
  return active;
}

/** 被控端调用：建立 offerer 角色。 */
export function startPeerAsHost(handlers: PeerHandlers): WebrtcSession | null {
  return startPeer(true, handlers, "host");
}

/** 控制端调用：等 offer 过来再懒建 answerer。 */
export function startPeerAsClient(handlers: PeerHandlers): WebrtcSession | null {
  if (active) return active;
  role = "client";
  boundHandlers = handlers;
  const s = new WebrtcSession(false, handlers, sendSignalFn);
  if (!webrtcAvailable()) {
    handlers.onFallback?.("no-webrtc");
    return null;
  }
  s.start();
  active = s;
  return s;
}

function startPeer(initiator: boolean, handlers: PeerHandlers, as: "host" | "client"): WebrtcSession | null {
  teardownPeer("restart");
  role = as;
  boundHandlers = handlers;
  const s = new WebrtcSession(initiator, handlers, sendSignalFn);
  if (!s.start()) return null;
  active = s;
  return s;
}

export async function attachPeerStream(stream: MediaStream): Promise<void> {
  await active?.attachStream(stream);
}

export function handleIncomingSignal(payload: WebRtcSignalPayload) {
  if (payload.kind === "offer" && !active && role === "client" && boundHandlers) {
    // 对端先出手：懒建 answerer（不 start，避免自己又发一个 offer 造成 glare）
    const s = new WebrtcSession(false, boundHandlers, sendSignalFn);
    if (!webrtcAvailable()) {
      boundHandlers.onFallback?.("no-webrtc");
      return;
    }
    s.start();
    active = s;
  }
  if (!active) return;
  void active.handleSignal(payload);
}

export function teardownPeer(reason: string) {
  const s = active;
  active = null;
  if (reason === "restart") {
    s?.close();
    return;
  }
  role = null;
  boundHandlers = null;
  s?.close();
}

export function peerRole(): "host" | "client" | null {
  return role;
}
