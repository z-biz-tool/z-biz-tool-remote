/**
 * 遥测纯逻辑：滑窗 fps/码率、丢帧计数、bufferedAmount 水位、RTT 采样。
 * 全部不依赖 DOM，可被 node --test 直接验证。
 */

export interface RateWindow {
  fps: number;
  kbps: number;
  frames: number;
  bytes: number;
}

/** 固定时长滑窗（默认 1s），按插入顺序记录样本。 */
export class RateMeter {
  private samples: number[] = [];
  private byteSamples: { at: number; bytes: number }[] = [];
  private totalFrames = 0;
  private totalBytes = 0;
  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  record(bytes: number, at: number): void {
    this.samples.push(at);
    this.byteSamples.push({ at, bytes });
    this.totalFrames += 1;
    this.totalBytes += bytes;
    this.prune(at);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0] < cutoff) this.samples.shift();
    while (this.byteSamples.length && this.byteSamples[0].at < cutoff) this.byteSamples.shift();
  }

  snapshot(now: number): RateWindow {
    this.prune(now);
    const n = this.samples.length;
    if (n === 0) return { fps: 0, kbps: 0, frames: 0, bytes: 0 };
    // 用窗口内首尾跨度算速率，冷启动（样本不足）时不虚高
    const spanMs = Math.max(1, Math.min(this.windowMs, now - this.samples[0]));
    const bytes = this.byteSamples.reduce((acc, s) => acc + s.bytes, 0);
    const count = n > 1 ? n - 1 : 1;
    const fps = n > 1 ? (count / spanMs) * 1000 : 0;
    const kbps = n > 1 ? ((bytes * 8) / 1000 / spanMs) * 1000 : 0;
    return { fps: round1(fps), kbps: round1(kbps), frames: n, bytes };
  }

  get totals(): { frames: number; bytes: number } {
    return { frames: this.totalFrames, bytes: this.totalBytes };
  }

  reset(): void {
    this.samples = [];
    this.byteSamples = [];
  }
}

export type DropReason = "socket-closed" | "socket-saturated" | "capture-error" | "peer-closed" | "no-session";

/** 只计数、不保存内容：静默丢帧是最难排查的问题。 */
export class DropCounter {
  private byReason = new Map<DropReason, number>();
  private totalValue = 0;
  private lastAtValue: number | null = null;

  record(reason: DropReason, at: number): void {
    this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    this.totalValue += 1;
    this.lastAtValue = at;
  }

  get total(): number {
    return this.totalValue;
  }

  get lastAt(): number | null {
    return this.lastAtValue;
  }

  snapshot(): { total: number; byReason: Partial<Record<DropReason, number>>; lastAt: number | null } {
    return { total: this.totalValue, byReason: Object.fromEntries(this.byReason), lastAt: this.lastAtValue };
  }

  reset(): void {
    this.byReason.clear();
    this.totalValue = 0;
    this.lastAtValue = null;
  }
}

/**
 * WebSocket bufferedAmount 高/低水位滞回：
 * 超过 high 停止生产帧，回落到 low 以下才恢复，避免在临界点抖动。
 */
export function watermarkNextPaused(
  buffered: number,
  high: number,
  low: number,
  paused: boolean,
): { paused: boolean; saturated: boolean } {
  const effLow = Math.min(low, high);
  if (!paused && buffered >= high) return { paused: true, saturated: true };
  if (paused && buffered <= effLow) return { paused: false, saturated: false };
  return { paused, saturated: paused };
}

export interface RttSample {
  lastMs: number | null;
  avgMs: number | null;
  jitterMs: number | null;
  samples: number;
  timeout: boolean;
}

/** 应用层 PING/PONG 往返时延（服务端对 PING 直接回 PONG）。 */
export class RttProbe {
  private pendingSentAt: number | null = null;
  private history: number[] = [];
  private last: number | null = null;
  private timeoutFlag = false;

  noteSent(at: number): void {
    if (this.pendingSentAt != null) {
      // 上一个还没回来 → 记一次超时，并丢弃旧样本
      this.timeoutFlag = true;
    }
    this.pendingSentAt = at;
  }

  noteReceived(at: number): void {
    if (this.pendingSentAt == null) return;
    const rtt = Math.max(0, at - this.pendingSentAt);
    this.pendingSentAt = null;
    this.timeoutFlag = false;
    this.last = rtt;
    this.history.push(rtt);
    if (this.history.length > 20) this.history.shift();
  }

  /** 超过 timeoutMs 没有回包则标记链路异常。 */
  checkTimeout(at: number, timeoutMs: number): void {
    if (this.pendingSentAt != null && at - this.pendingSentAt > timeoutMs) {
      this.pendingSentAt = null;
      this.timeoutFlag = true;
    }
  }

  get sample(): RttSample {
    const n = this.history.length;
    const avg = n ? this.history.reduce((a, b) => a + b, 0) / n : null;
    const jitter = n > 1 && avg != null ? this.history.reduce((a, b) => a + Math.abs(b - avg), 0) / n : null;
    return {
      lastMs: this.last,
      avgMs: avg == null ? null : round1(avg),
      jitterMs: jitter == null ? null : round1(jitter),
      samples: n,
      timeout: this.timeoutFlag,
    };
  }

  reset(): void {
    this.pendingSentAt = null;
    this.history = [];
    this.last = null;
    this.timeoutFlag = false;
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
