import { invoke } from "@tauri-apps/api/core";
import { signaling } from "./signaling";
import { useSessionStore } from "../stores/sessionStore";
import { useSettingsStore } from "../stores/settingsStore";

interface ScreenFrame {
  base64: string;
  width: number;
  height: number;
  timestamp: number;
}

let captureTimer: number | null = null;
let captureInFlight = false;
let lastSentTs = 0;

export function startCaptureLoop() {
  stopCaptureLoop();
  const tick = async () => {
    if (captureInFlight) return;
    const s = useSessionStore.getState();
    const settings = useSettingsStore.getState().settings;
    if (!s.isHosting || !s.sessionId) return;
    captureInFlight = true;
    try {
      const frame = await invoke<ScreenFrame>("capture_screen", {
        quality: settings.frameQuality,
      });
      // 节流：若上一帧还没发完，或短时间内已经有同 ts，跳过
      if (frame.timestamp === lastSentTs) return;
      lastSentTs = frame.timestamp;
      signaling.sendScreenFrame(s.sessionId, frame.base64, settings.frameQuality);
    } catch (e) {
      console.error("capture_screen failed", e);
    } finally {
      captureInFlight = false;
    }
  };
  const intervalMs = () => {
    const fps = Math.max(1, useSettingsStore.getState().settings.fps);
    return Math.max(33, Math.floor(1000 / fps));
  };
  // 立即跑一次，之后按 fps 间隔
  void tick();
  captureTimer = window.setInterval(tick, intervalMs());
}

export function stopCaptureLoop() {
  if (captureTimer != null) {
    clearInterval(captureTimer);
    captureTimer = null;
  }
  captureInFlight = false;
  lastSentTs = 0;
}

export function isCapturing() {
  return captureTimer != null;
}
