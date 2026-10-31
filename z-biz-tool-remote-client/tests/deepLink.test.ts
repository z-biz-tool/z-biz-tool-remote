// zbiz:// 深链接的 remote 语义层
// 运行：npm run test  （node --experimental-strip-types --import ./tests/register-ts-ext.mjs --test tests/*.test.ts）
//
// 这层的两条硬约束（本仓自己加的，比家族通用规则更严）：
//   1. 深链只**定位**设备，绝不自动发起控制请求 —— URL 触发远控是权限升级；
//   2. 会话 ID/令牌一律拒绝走深链 —— 与本仓「令牌不走 URL 查询串」的裁定一致。
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveRemoteDeepLink } from "../src/_shared/deepLink.ts";
import type { Handoff } from "z-biz-tool-shared/protocol";

/** 造一条深链。params 省略时是空表（等价于 zbiz://remote/open） */
function deeplink(action: string, params: Record<string, string> = {}): Handoff {
  return { product: "remote", action, params };
}

test("open 无参数 = 纯唤起：不报错，也不带任何定位意图", () => {
  const out = resolveRemoteDeepLink(deeplink("open"));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, null);
  assert.equal(out.from, null);
});

test("action 缺省（空串）按 open 处理", () => {
  const out = resolveRemoteDeepLink(deeplink(""));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, null);
});

test("action 前后有空格时仍认得 open", () => {
  const out = resolveRemoteDeepLink(deeplink("  open  ", { device: "dev-1" }));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, "dev-1");
});

test("device=设备ID：产出定位意图", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { device: "dev-42" }));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, "dev-42");
});

test("device=设备名：同样接受（用户看到的是名字，不是 ID）", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { device: "办公室小主机" }));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, "办公室小主机");
});

test("device 的前后空格会被清掉", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { device: "  dev-42  " }));
  assert.equal(out.deviceQuery, "dev-42");
});

test("device 给了空串 / 全空格 = 没给：回落成纯唤起，而不是报错", () => {
  assert.equal(resolveRemoteDeepLink(deeplink("open", { device: "" })).deviceQuery, null);
  const blank = resolveRemoteDeepLink(deeplink("open", { device: "   " }));
  assert.equal(blank.deviceQuery, null);
  assert.equal(blank.problem, null);
});

test("from 透传（仅用于日志与回执）", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { from: "box" }));
  assert.equal(out.from, "box");
  assert.equal(out.problem, null);
});

test("不认识的动作给 problem，不静默吞掉", () => {
  const out = resolveRemoteDeepLink(deeplink("control", { device: "dev-42" }));
  assert.ok(out.problem, "未知动作必须给出原因");
  assert.match(out.problem!, /control/);
  assert.equal(out.deviceQuery, null, "接不住时不能同时产出动作");
});

test("session 参数一律拒绝：会话令牌不走链接（查询串会进历史与日志）", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { session: "sess-1", token: "tk-abc" }));
  assert.ok(out.problem);
  assert.match(out.problem!, /不走深链/);
  assert.equal(out.deviceQuery, null);
});

test("只给 token、没给 session 也一样拒绝（半个凭据更容易误导人）", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { token: "tk-abc" }));
  assert.ok(out.problem);
  assert.match(out.problem!, /不走深链/);
});

test("session 与 device 同时给：拒绝会话那部分，而不是挑一个偷偷执行", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { device: "dev-42", session: "sess-1" }));
  assert.ok(out.problem, "混合意图必须报出来，不能只落地其中一个");
  assert.equal(out.deviceQuery, null);
});

test("session 给了空串不算意图（只trim后判空）", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { session: "  ", device: "dev-42" }));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, "dev-42");
});

test("未知参数被忽略：不报错，也不产出动作", () => {
  const out = resolveRemoteDeepLink(deeplink("open", { foo: "bar" }));
  assert.equal(out.problem, null);
  assert.equal(out.deviceQuery, null);
});
