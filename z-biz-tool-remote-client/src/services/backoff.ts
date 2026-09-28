/**
 * 重连退避 + 失败分类：纯逻辑，不依赖 DOM/WebSocket，便于单测。
 */

export interface BackoffOptions {
  /** 首次重试延迟 */
  baseMs: number;
  /** 延迟上限 */
  maxMs: number;
  /** 指数底数 */
  factor: number;
  /** 抖动比例 0..1（等分在该比例内随机，避免客户端同步重试风暴） */
  jitterRatio: number;
  /** 最大尝试次数，0 = 不限 */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 800,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.4,
  maxAttempts: 12,
};

/** 把用户设置的"重连间隔"当作退避基数，其余走默认上限。 */
export function backoffFromInterval(intervalMs: number, overrides?: Partial<BackoffOptions>): BackoffOptions {
  const base = Math.max(500, Math.min(60_000, Math.round(intervalMs) || DEFAULT_BACKOFF.baseMs));
  return {
    ...DEFAULT_BACKOFF,
    baseMs: base,
    // 基数本身要留够余量：base * 2^n 不能超过 maxMs 太多代，否则首几次就顶到上限
    maxMs: Math.max(base * 8, DEFAULT_BACKOFF.maxMs),
    ...overrides,
  };
}

/** 第 attempt 次（从 1 开始）重试前应等待的毫秒数。rand 注入以便测试确定性。 */
export function nextBackoffDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  rand: () => number = Math.random,
): number {
  const a = Math.max(1, Math.floor(attempt));
  const factor = opts.factor > 1 ? opts.factor : 2;
  const ceiling = Math.max(opts.baseMs, opts.maxMs);
  const raw = Math.min(ceiling, opts.baseMs * Math.pow(factor, a - 1));
  const jitter = clamp(opts.jitterRatio, 0, 0.99);
  const spread = raw * jitter;
  const r = clamp(rand(), 0, 1);
  return Math.max(0, Math.round(raw - spread / 2 + r * spread));
}

/** 服务端 ERROR.code 里代表"重试也没用"的那些（凭据/权限类）。 */
export const TERMINAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "AUTH_FAILED",
  "AUTH_REQUIRED",
  "BAD_TOKEN",
  "TOKEN_EXPIRED",
  "INVALID_TOKEN",
  "NOT_AUTHENTICATED",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "USER_DISABLED",
]);

/** 对端/本端明确拒绝或协议级错误，重试无意义。 */
export const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1003, 1007, 1008, 1009]);

export type FailureClass = "terminal" | "retryable";

export function classifyServerErrorCode(code: string | null | undefined): FailureClass {
  if (!code) return "retryable";
  return TERMINAL_ERROR_CODES.has(code.toUpperCase()) ? "terminal" : "retryable";
}

export function classifyCloseCode(code: number | null | undefined): FailureClass {
  if (code == null) return "retryable";
  return TERMINAL_CLOSE_CODES.has(code) ? "terminal" : "retryable";
}

/**
 * 浏览器读不到 WS 握手的 HTTP 401，只能看到 close(1006)。
 * 连续 quickFailLimit 次"从未 open 就失败"视为被服务端拒绝（凭据/地址问题），停止轰炸。
 */
export function isFastFailure(elapsedMs: number, everOpened: boolean, thresholdMs = 1500): boolean {
  return !everOpened && elapsedMs >= 0 && elapsedMs < thresholdMs;
}

export function countFastFailures(prev: number, elapsedMs: number, everOpened: boolean, thresholdMs = 1500): number {
  if (everOpened) return 0;
  return isFastFailure(elapsedMs, everOpened, thresholdMs) ? prev + 1 : 0;
}

export type ReconnectDecision =
  | { retry: false; cause: "intentional" | "terminal" | "cap" | "hidden" }
  | { retry: true; cause: "retry"; delayMs: number };

export interface ReconnectInput {
  intentional: boolean;
  terminal: boolean;
  attempt: number;
  visible: boolean;
  opts: BackoffOptions;
  rand?: () => number;
}

/** 唯一决策点：是否重连、多久后重连。 */
export function decideReconnect(input: ReconnectInput): ReconnectDecision {
  const { intentional, terminal, attempt, visible, opts } = input;
  if (intentional) return { retry: false, cause: "intentional" };
  if (terminal) return { retry: false, cause: "terminal" };
  if (opts.maxAttempts > 0 && attempt > opts.maxAttempts) return { retry: false, cause: "cap" };
  if (!visible) return { retry: false, cause: "hidden" };
  return { retry: true, cause: "retry", delayMs: nextBackoffDelay(attempt, opts, input.rand ?? Math.random) };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}
