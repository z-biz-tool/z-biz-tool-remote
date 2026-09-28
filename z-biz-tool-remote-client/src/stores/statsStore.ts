import { create } from "zustand";
import { RateMeter } from "../services/telemetry";
import { signaling } from "../services/signaling";
import { useSettingsStore } from "./settingsStore";
import { currentPeer } from "../services/webrtc";

export type StreamMode = "off" | "relay" | "display" | "canvas";

export interface StreamStats {
  /** 当前画面通道 */
  mode: StreamMode;
  /** 用户设定的目标帧率上限 */
  requestedFps: number;
  /** 发送端实际产出帧率 */
  outFps: number;
  /** 接收端实际渲染帧率 */
  inFps: number;
  outKbps: number;
  inKbps: number;
  dropped: number;
  dropReasons: Partial<Record<string, number>>;
  /** 信令链路 RTT（应用层 PING/PONG） */
  rttMs: number | null;
  /** WebRTC ICE RTT（有真实通道时更可信） */
  iceRttMs: number | null;
  resolution: string;
  peerPhase: string;
  backpressure: boolean;
  note: string | null;
}

const EMPTY: StreamStats = {
  mode: "off",
  requestedFps: 0,
  outFps: 0,
  inFps: 0,
  outKbps: 0,
  inKbps: 0,
  dropped: 0,
  dropReasons: {},
  rttMs: null,
  iceRttMs: null,
  resolution: "—",
  peerPhase: "idle",
  backpressure: false,
  note: null,
};

interface StatsStore {
  stats: StreamStats;
  patch: (p: Partial<StreamStats>) => void;
  reset: () => void;
}

export const useStatsStore = create<StatsStore>((set) => ({
  stats: EMPTY,
  patch: (p) => set((s) => ({ stats: { ...s.stats, ...p } })),
  reset: () => set({ stats: EMPTY }),
}));

/** 发送端产出的帧（relay 或喂给 WebRTC 的 canvas 帧）。 */
export const producerMeter = new RateMeter(1000);
/** 接收端收到的帧（JPEG 或 WebRTC track）。 */
export const viewerMeter = new RateMeter(1000);

let ticker: number | null = null;

/** 1 秒一次采样：不做每帧 setState，避免整棵 React 树重渲染。 */
export function startStatsTicker(): void {
  if (ticker != null) return;
  ticker = window.setInterval(() => {
    void sampleOnce();
  }, 1000);
  void sampleOnce();
}

export function stopStatsTicker(): void {
  if (ticker != null) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function sampleOnce(): Promise<void> {
  const now = Date.now();
  const out = producerMeter.snapshot(now);
  const inc = viewerMeter.snapshot(now);
  const drops = signaling.dropStats;
  const peer = currentPeer();
  const patch: Partial<StreamStats> = {
    requestedFps: useSettingsStore.getState().settings.fps,
    outFps: out.fps,
    inFps: inc.fps,
    outKbps: out.kbps,
    inKbps: inc.kbps,
    dropped: drops.total,
    dropReasons: drops.byReason,
    rttMs: signaling.state.rttMs,
    backpressure: signaling.backpressureActive,
    peerPhase: peer?.phase ?? "idle",
  };
  if (peer?.isConnected) {
    const s = await peer.sampleStats();
    if (s) {
      patch.iceRttMs = s.rttMs;
      if (s.kbps > 0) patch.inKbps = s.kbps;
      if (s.fps > 0) patch.inFps = s.fps;
      if (s.width && s.height) patch.resolution = `${s.width}×${s.height}`;
    }
  }
  useStatsStore.getState().patch(patch);
}

export function setStreamMode(mode: StreamMode, note?: string | null) {
  useStatsStore.getState().patch({ mode, note: note ?? null });
}
