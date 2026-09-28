// 纯逻辑单测：退避/失败分类 + 遥测（帧率、丢帧、水位、RTT）
// 运行：npm run test  （node --experimental-strip-types --test tests/*.test.ts）
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backoffFromInterval,
  classifyCloseCode,
  classifyServerErrorCode,
  countFastFailures,
  decideReconnect,
  isFastFailure,
  nextBackoffDelay,
} from "../src/services/backoff.ts";
import { DropCounter, RateMeter, RttProbe, watermarkNextPaused } from "../src/services/telemetry.ts";

const fixed = (v: number) => () => v;

test("第 1 次退避约等于基数，且随 attempt 指数增长", () => {
  const opts = backoffFromInterval(1000, { jitterRatio: 0 });
  assert.equal(nextBackoffDelay(1, opts, fixed(0.5)), 1000);
  assert.equal(nextBackoffDelay(2, opts, fixed(0.5)), 2000);
  assert.equal(nextBackoffDelay(3, opts, fixed(0.5)), 4000);
  assert.equal(nextBackoffDelay(4, opts, fixed(0.5)), 8000);
});

test("退避有上限，且抖动只在该比例的窗口内", () => {
  const opts = backoffFromInterval(1000);
  const late = nextBackoffDelay(40, opts, fixed(0.5));
  assert.ok(late <= opts.maxMs, `delay ${late} 应 <= ${opts.maxMs}`);
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const d = nextBackoffDelay(2, opts, fixed(r));
    const raw = opts.baseMs * 2;
    const spread = raw * opts.jitterRatio;
    assert.ok(d >= Math.round(raw - spread / 2) - 1 && d <= Math.round(raw + spread / 2) + 1, `rand=${r} -> ${d}`);
  }
});

test("随机种子不同 ⇒ 抖动后延迟不同（不会同步重试）", () => {
  const opts = backoffFromInterval(1000);
  assert.notEqual(nextBackoffDelay(3, opts, fixed(0)), nextBackoffDelay(3, opts, fixed(1)));
});

test("非法参数不产生 NaN", () => {
  assert.equal(nextBackoffDelay(0, backoffFromInterval(1000, { jitterRatio: NaN }), fixed(0.5)) > 0, true);
});

test("凭据/权限类错误判为终止，网络类判为可重试", () => {
  assert.equal(classifyServerErrorCode("AUTH_FAILED"), "terminal");
  assert.equal(classifyServerErrorCode("not_authenticated"), "terminal");
  assert.equal(classifyServerErrorCode("UNKNOWN_TYPE"), "retryable");
  assert.equal(classifyServerErrorCode(null), "retryable");
  assert.equal(classifyCloseCode(1008), "terminal");
  assert.equal(classifyCloseCode(1006), "retryable");
  assert.equal(classifyCloseCode(undefined), "retryable");
});

test("从未 open 就秒断算快速失败，open 过后清零", () => {
  assert.equal(isFastFailure(200, false), true);
  assert.equal(isFastFailure(9000, false), false);
  assert.equal(countFastFailures(1, 200, false), 2);
  assert.equal(countFastFailures(3, 200, true), 0);
});

test("重连决策：主动断开/终止/次数用尽/后台 四种情况都不重连", () => {
  const opts = backoffFromInterval(1000, { maxAttempts: 3 });
  const base = { opts, attempt: 1, visible: true, terminal: false, intentional: false };
  assert.deepEqual(decideReconnect({ ...base, intentional: true }), { retry: false, cause: "intentional" });
  assert.deepEqual(decideReconnect({ ...base, terminal: true }), { retry: false, cause: "terminal" });
  assert.deepEqual(decideReconnect({ ...base, attempt: 4 }), { retry: false, cause: "cap" });
  assert.deepEqual(decideReconnect({ ...base, visible: false }), { retry: false, cause: "hidden" });
  const ok = decideReconnect({ ...base, rand: fixed(0.5) });
  assert.equal(ok.retry, true);
  if (ok.retry) assert.equal(ok.delayMs, 1000);
});

test("滑窗帧率/码率按 1s 窗口统计，窗口外样本被剔除", () => {
  const m = new RateMeter(1000);
  assert.deepEqual(m.snapshot(1000), { fps: 0, kbps: 0, frames: 0, bytes: 0 });
  m.record(1000, 0);
  assert.equal(m.snapshot(1).fps, 0, "单帧不虚高");
  for (let i = 1; i <= 10; i++) m.record(1000, i * 100);
  const s = m.snapshot(1000);
  assert.equal(s.frames, 11);
  assert.ok(Math.abs(s.fps - 10) < 1.5, `fps=${s.fps}`);
  // 11 帧 * 1000B / 1s ≈ 88 kbps（增量口径，允许窗口边缘误差）
  assert.ok(s.kbps > 60 && s.kbps < 110, `kbps=${s.kbps}`);
  m.record(1000, 5000);
  const after = m.snapshot(5000);
  assert.equal(after.frames, 1, "旧样本应已过期");
  assert.deepEqual(m.totals, { frames: 12, bytes: 12000 });
});

test("丢帧只计数并保留原因分布", () => {
  const d = new DropCounter();
  d.record("socket-closed", 1);
  d.record("socket-saturated", 2);
  d.record("socket-saturated", 3);
  const snap = d.snapshot();
  assert.equal(snap.total, 3);
  assert.equal(snap.byReason["socket-saturated"], 2);
  assert.equal(snap.byReason["capture-error"], undefined);
  assert.equal(snap.lastAt, 3);
});

test("水位滞回：过高停产，必须回提到低水位才恢复", () => {
  assert.deepEqual(watermarkNextPaused(5_000_000, 4_000_000, 1_000_000, false), { paused: true, saturated: true });
  assert.deepEqual(watermarkNextPaused(2_000_000, 4_000_000, 1_000_000, true), { paused: true, saturated: true });
  assert.deepEqual(watermarkNextPaused(900_000, 4_000_000, 1_000_000, true), { paused: false, saturated: false });
  assert.deepEqual(watermarkNextPaused(3_000_000, 4_000_000, 1_000_000, false), { paused: false, saturated: false });
});

test("RTT：往返配对、乱序忽略、超时标记", () => {
  const p = new RttProbe();
  p.noteReceived(500);
  assert.equal(p.sample.lastMs, null, "没有发出过就不该有样本");
  p.noteSent(1000);
  p.noteReceived(1080);
  assert.equal(p.sample.lastMs, 80);
  assert.equal(p.sample.timeout, false);
  p.noteSent(2000);
  p.checkTimeout(2000 + 8001, 8000);
  assert.equal(p.sample.timeout, true);
  assert.equal(p.sample.samples, 1);
  p.noteSent(3000);
  p.noteReceived(3040);
  assert.equal(p.sample.timeout, false);
  assert.equal(p.sample.samples, 2);
  assert.ok(Math.abs(p.sample.avgMs! - 60) < 0.001);
});
