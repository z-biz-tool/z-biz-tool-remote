import { invoke } from "@tauri-apps/api/core";
import { signaling } from "./signaling";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { producerMeter, setStreamMode } from "../stores/statsStore";
import {
  currentPeer,
  displayCaptureAvailable,
  startPeerAsHost,
  teardownPeer,
  webrtcAvailable,
  type PeerPhase,
} from "./webrtc";

interface ScreenFrame {
  base64: string;
  width: number;
  height: number;
  timestamp: number;
  display_id: number;
}

export type CaptureTier = "off" | "rust" | "canvas" | "display";

let loopTimer: number | null = null;
let running = false;
let tier: CaptureTier = "off";
let canvas: HTMLCanvasElement | null = null;
let canvasStream: MediaStream | null = null;
let displayStream: MediaStream | null = null;
let lastSentTs = 0;
let selectedDisplayId: number | null = null;
let unsubSettings: (() => void) | null = null;
let fallbackNote: string | null = null;

export function currentTier(): CaptureTier {
  return tier;
}

export function startCaptureLoop(displayId?: number) {
  void startHostStream(displayId);
}

/**
 * 被控端启动画面通道，按能力自动选层：
 *   display  getDisplayMedia 直连（浏览器/WebView2 支持时，最省 CPU）
 *   canvas   Rust 截屏 → 解码进 canvas → captureStream 喂 WebRTC
 *   rust     Rust 截屏 → JPEG 走信令 WebSocket（原始通道，永远可用）
 */
export async function startHostStream(displayId?: number): Promise<void> {
  stopCaptureLoop();
  selectedDisplayId = displayId ?? selectedDisplayId;
  running = true;
  unsubSettings = useSettingsStore.subscribe((now, prev) => {
    if (now.settings !== prev.settings) applyLiveSettings(prev.settings, now.settings);
  });

  const wantWebrtc = webrtcAvailable() && signaling.relaySignalSupport !== "unsupported";
  if (wantWebrtc && displayCaptureAvailable()) {
    const stream = await acquireDisplayMedia();
    if (stream) {
      displayStream = stream;
      tier = "display";
      if (openPeerAndAttach(stream)) {
        setStreamMode("display", fallbackNote);
        return;
      }
      stopDisplayStream();
    }
  }
  if (wantWebrtc) {
    tier = "canvas";
    const s = ensureCanvasStream();
    if (s && openPeerAndAttach(s)) {
      setStreamMode("canvas", fallbackNote);
      scheduleTick(0);
      return;
    }
    teardownPeer("attach-failed");
  }
  tier = "rust";
  setStreamMode("relay", fallbackNote);
  scheduleTick(0);
}

function openPeerAndAttach(stream: MediaStream): boolean {
  const peer = startPeerAsHost({
    onPhase: (phase: PeerPhase) => {
      if (phase === "connected") {
        setStreamMode(tier === "display" ? "display" : "canvas", null);
      }
    },
    onFallback: (reason) => degradeToRelay(reason),
  });
  if (!peer) return false;
  void peer.attachStream(stream);
  return true;
}

/** WebRTC 谈不成 → 关通道、停共享轨道、回到 JPEG 中继，保持"至少能看见画面"。 */
function degradeToRelay(reason: string) {
  if (!running || tier === "rust") {
    fallbackNote = reason;
    return;
  }
  fallbackNote = reason;
  teardownPeer("degraded");
  stopDisplayStream();
  stopCanvasStream();
  tier = "rust";
  setStreamMode("relay", reason);
  scheduleTick(0);
}

function acquireDisplayMedia(): Promise<MediaStream | null> {
  const fps = Math.max(1, useSettingsStore.getState().settings.fps);
  return navigator
    .mediaDevices!.getDisplayMedia({
      video: { frameRate: { ideal: fps, max: fps }, width: { ideal: preferredWidth() } },
      audio: false,
    })
    .then((stream) => {
      // 用户在系统里点"停止共享"时轨道会自己结束，此时必须回落到中继
      stream.getVideoTracks()[0]?.addEventListener("ended", () => degradeToRelay("display-ended"));
      return stream;
    })
    .catch(() => null);
}

function preferredWidth(): number {
  const w = useSettingsStore.getState().settings.maxFrameWidth;
  return w > 0 ? w : 1920;
}

function ensureCanvasStream(): MediaStream | null {
  if (canvasStream) return canvasStream;
  if (typeof document === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = preferredWidth();
    canvas.height = Math.round((canvas.width * 9) / 16);
    // alpha:false 省一次合成；desynchronized 降低延迟
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) return null;
    canvasStream = canvas.captureStream(Math.max(1, useSettingsStore.getState().settings.fps));
    return canvasStream;
  } catch {
    canvas = null;
    canvasStream = null;
    return null;
  }
}

function stopCanvasStream() {
  canvasStream?.getTracks().forEach((t) => t.stop());
  canvasStream = null;
  canvas = null;
}

function stopDisplayStream() {
  // 必须 stop()，否则 macOS 顶部"正在共享屏幕"的绿点不会消失
  displayStream?.getTracks().forEach((t) => t.stop());
  displayStream = null;
}

function intervalMs(): number {
  const fps = Math.max(1, useSettingsStore.getState().settings.fps);
  return Math.max(33, Math.floor(1000 / fps));
}

function scheduleTick(delayMs: number) {
  if (loopTimer != null) clearTimeout(loopTimer);
  if (!running || tier === "off") return;
  loopTimer = window.setTimeout(() => {
    loopTimer = null;
    void tick();
  }, Math.max(0, delayMs));
}

function captureInvoke(): Promise<ScreenFrame> {
  const settings = useSettingsStore.getState().settings;
  if (selectedDisplayId !== null) {
    return invoke<ScreenFrame>("capture_monitor", {
      displayId: selectedDisplayId,
      quality: settings.frameQuality,
      maxWidth: settings.maxFrameWidth,
    });
  }
  return invoke<ScreenFrame>("capture_screen", {
    quality: settings.frameQuality,
    maxWidth: settings.maxFrameWidth,
  });
}

async function tick(): Promise<void> {
  if (!running) return;
  const started = Date.now();
  try {
    if (tier === "rust" || tier === "canvas") await produceFrame();
  } catch (e) {
    console.error("capture tick failed", e);
  } finally {
    if (running && (tier === "rust" || tier === "canvas")) scheduleTick(intervalMs() - (Date.now() - started));
  }
}

async function produceFrame(): Promise<void> {
  const s = useSessionStore.getState();
  if (!s.isHosting || !s.sessionId) return;
  // WebRTC 已连通时不再双发 JPEG；协商期间保留中继，保证"谈崩了也有画面"
  const relayEnabled = !(tier === "canvas" && currentPeer()?.isConnected);
  if (relayEnabled && !signaling.canProduce()) {
    signaling.noteDroppedFrame("socket-saturated");
    return;
  }
  let frame: ScreenFrame;
  try {
    frame = await captureInvoke();
  } catch (e) {
    signaling.noteDroppedFrame("capture-error");
    console.error("capture_screen failed", e);
    return;
  }
  if (frame.timestamp === lastSentTs && tier === "rust") return;
  lastSentTs = frame.timestamp;

  const bytes = Math.round((frame.base64.length * 3) / 4);
  if (relayEnabled) {
    const ok = signaling.sendScreenFrame(s.sessionId, frame.base64, useSettingsStore.getState().settings.frameQuality);
    if (!ok) signaling.noteDroppedFrame("socket-closed");
  }
  producerMeter.record(bytes, Date.now());

  if (tier === "canvas") await drawToCanvas(frame.base64, frame.width, frame.height);
}

async function drawToCanvas(base64: string, width: number, height: number): Promise<void> {
  if (!canvas) return;
  try {
    const binary = atobToBytes(base64);
    const bitmap = await createImageBitmap(new Blob([binary], { type: "image/jpeg" }));    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch (e) {
    console.error("canvas frame draw failed", e);
  }
}

/** 返回 ArrayBuffer（而非 Uint8Array<ArrayBufferLike>），避免 Blob 类型的泛型不兼容 */
function atobToBytes(b64: string): ArrayBuffer {
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

/** 帧率/画质/显示器改动实时生效，不用重启会话。 */
function applyLiveSettings(prev: { fps: number; frameQuality: number; maxFrameWidth: number }, next: { fps: number; frameQuality: number; maxFrameWidth: number }) {
  if (tier === "display") {
    const track = displayStream?.getVideoTracks()[0];
    if (track && prev.fps !== next.fps) {
      void track.applyConstraints({ frameRate: { ideal: next.fps, max: next.fps } }).catch(() => undefined);
    }
    return;
  }
  if (tier === "canvas" && prev.fps !== next.fps) {
    canvasStream?.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: next.fps } }).catch(() => undefined);
  }
  // rust/canvas 的下一帧就会读新设置；这里只是把节奏立刻拉回来
  if (running && (tier === "rust" || tier === "canvas")) scheduleTick(0);
}

export function stopCaptureLoop() {
  running = false;
  if (loopTimer != null) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
  unsubSettings?.();
  unsubSettings = null;
  lastSentTs = 0;
  fallbackNote = null;
  if (tier !== "off") {
    teardownPeer("stop");
    stopDisplayStream();
    stopCanvasStream();
    tier = "off";
    setStreamMode("off", null);
  }
}

export function isCapturing() {
  return loopTimer != null || displayStream != null || canvasStream != null;
}

export function getSelectedDisplayId() {
  return selectedDisplayId;
}

export function setSelectedDisplayId(id: number | null) {
  if (selectedDisplayId === id) return;
  selectedDisplayId = id;
  // 换屏：轨道替换交给 WebRTC，其余重开循环
  if (running && tier !== "display") scheduleTick(0);
}
