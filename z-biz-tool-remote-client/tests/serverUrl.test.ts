// 服务端地址解析：协议裁决（台账 S1-B11 / P0-1）
// 运行：npm run test  （node --experimental-strip-types --test tests/*.test.ts）
//
// 为什么这层必须有网：这是「用户以为在用 TLS、实际连的是明文」那条路的唯一入口。
//
// 原实现是「先 `stripProtocol` 剥掉协议、再恒拼 `ws://`」——
//   · 用户在设置里显式填 `wss://example.com`，实际连的仍是明文 `ws://`；
//   · 而屏幕像素与键鼠事件都走这条链路，**令牌也在同一条链路的 URL 查询串里**，
//     所以带内再套一层加密是自欺欺人：唯一真正的防线是 TLS（wss://），
//     而这条入口把它吞了。
//
// 现在按台账 S1-B11 的验收标准执行：
//   · 公网地址 → 默认 wss://（安全默认）
//   · 本机地址（localhost / 127.0.0.0/8 / ::1 / *.local）→ 允许 ws://（本地开发豁免）
//   · 公网地址写明文 ws:// → 拒绝并给出可操作的原因
//   · 显式 wss:// → 原样保留，绝不降级
//   · 非法输入 → 空串
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanAddress,
  describeWsUrl,
  displayUrl,
  isLocalHost,
  isSecureTransport,
  parseScheme,
  toWsUrl,
} from "../src/services/storage.ts";

test("P0-1 回归：显式的 wss:// 必须原样保留 —— 绝不能被降级成 ws://", () => {
  assert.equal(toWsUrl("wss://example.com"), "wss://example.com");
  assert.equal(toWsUrl("wss://example.com:8443"), "wss://example.com:8443");
  // 末尾多余的斜杠要去掉，但协议不能动
  assert.equal(toWsUrl("wss://example.com/"), "wss://example.com");
  // 大小写不敏感
  assert.equal(toWsUrl("WSS://example.com"), "wss://example.com");
  // 本机地址显式要 TLS 时也必须保留 —— 剥协议会让它回落成明文 ws://
  assert.equal(toWsUrl("wss://localhost:8443"), "wss://localhost:8443");
});

test("公网地址默认走 TLS（安全默认）", () => {
  assert.equal(toWsUrl("example.com"), "wss://example.com");
  assert.equal(toWsUrl("example.com:8443"), "wss://example.com:8443");
  assert.equal(toWsUrl("192.168.1.10:8080"), "wss://192.168.1.10:8080");
  assert.equal(toWsUrl("101.37.80.51:8080"), "wss://101.37.80.51:8080");
  assert.equal(toWsUrl("  example.com  "), "wss://example.com");
});

test("本机地址允许明文（本地开发豁免）", () => {
  assert.equal(toWsUrl("localhost:8080"), "ws://localhost:8080");
  assert.equal(toWsUrl("127.0.0.1:8080"), "ws://127.0.0.1:8080");
  assert.equal(toWsUrl("127.0.0.2:8080"), "ws://127.0.0.2:8080");
  assert.equal(toWsUrl("signaling.local:8080"), "ws://signaling.local:8080");
  assert.equal(toWsUrl("localhost"), "ws://localhost");
  // 本机显式写 ws:// 也照办
  assert.equal(toWsUrl("ws://localhost:8080"), "ws://localhost:8080");
});

test("公网地址写明文 ws:// 一律拒绝（返回空串）", () => {
  assert.equal(toWsUrl("ws://example.com"), "");
  assert.equal(toWsUrl("ws://101.37.80.51:8080"), "");
  assert.equal(toWsUrl("ws://192.168.1.10:8080"), "");
  // 拒绝的理由要能直接告诉用户怎么办
  const plan = describeWsUrl("ws://example.com");
  assert.equal(plan.url, "");
  assert.ok(plan.error, "拒绝时必须给出原因");
  assert.match(plan.error, /TLS_KEY_PATH/, "提示里要指出服务端的配置项");
});

test("主机名本身以 ws 开头时，仍然要补协议（不能产出没有协议的非法 URL）", () => {
  // 原实现里 `clean.startsWith("ws")` 是死代码：
  // stripProtocol 已经剥掉了 ws:// 前缀，clean 不可能以 ws 开头 ——
  // 除非主机名自己以 ws 开头，那时原实现会返回 "ws.example.com"（**没有协议**）。
  assert.equal(toWsUrl("ws.example.com"), "wss://ws.example.com");
  assert.equal(toWsUrl("wss.example.com"), "wss://wss.example.com");
});

test("非法输入返回空串，不产出半截 URL", () => {
  assert.equal(toWsUrl(""), "");
  assert.equal(toWsUrl("   "), "");
  assert.equal(toWsUrl("/"), "");
  assert.equal(toWsUrl("not a host"), "");
  assert.equal(toWsUrl("host:99999"), "", "端口越界");
  assert.equal(toWsUrl("http://example.com"), "", "不是 ws/wss 协议");
});

test("传输安全性判定：只有 wss:// 才算受 TLS 保护", () => {
  assert.equal(isSecureTransport("wss://example.com"), true);
  assert.equal(isSecureTransport("WSS://example.com"), true);
  assert.equal(isSecureTransport("ws://example.com"), false);
  assert.equal(isSecureTransport("example.com"), false);
  assert.equal(isSecureTransport(""), false);
});

test("describeWsUrl 如实报出「实际会怎么连」", () => {
  const secure = describeWsUrl("example.com:8443");
  assert.equal(secure.url, "wss://example.com:8443");
  assert.equal(secure.secure, true);
  assert.equal(secure.error, null);

  const plain = describeWsUrl("localhost:8080");
  assert.equal(plain.url, "ws://localhost:8080");
  assert.equal(plain.secure, false);
  assert.equal(plain.error, null);

  const empty = describeWsUrl("");
  assert.equal(empty.url, "");
  assert.equal(empty.secure, false);
  assert.ok(empty.error);
});

test("isLocalHost：明文豁免范围必须精确", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("localhost:8080"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("127.1.2.3"), true);
  assert.equal(isLocalHost("[::1]:8080"), true);
  assert.equal(isLocalHost("box.local"), true);
  assert.equal(isLocalHost("example.com"), false);
  assert.equal(isLocalHost("192.168.1.10"), false);
  assert.equal(isLocalHost("10.0.0.1"), false);
  // 名字里带 local 但不是 .local 结尾的，不算本机
  assert.equal(isLocalHost("localhost.evil.com"), false);
  assert.equal(isLocalHost("notlocal"), false);
});

test("parseScheme：只认显式写出的 ws / wss", () => {
  assert.equal(parseScheme("wss://example.com"), "wss");
  assert.equal(parseScheme("ws://example.com"), "ws");
  assert.equal(parseScheme("WSS://example.com"), "wss");
  assert.equal(parseScheme("example.com"), null);
  assert.equal(parseScheme(""), null);
  // 名字里带 ws 开头不等于写了协议
  assert.equal(parseScheme("ws.example.com"), null);
});

test("cleanAddress：清 token / 末尾斜杠，但**保留协议**", () => {
  // 剥掉协议会让「本机 + 显式 wss://」在重启后回落成明文 ws://
  assert.equal(cleanAddress("wss://localhost:8443"), "wss://localhost:8443");
  assert.equal(cleanAddress("wss://example.com/"), "wss://example.com");
  assert.equal(cleanAddress("wss://example.com?token=secret"), "wss://example.com");
  assert.equal(cleanAddress("example.com:8080"), "example.com:8080");
  assert.equal(cleanAddress(""), "");
});

test("展示用的地址不泄露协议与令牌", () => {
  assert.equal(displayUrl("wss://example.com:8443"), "example.com:8443");
  assert.equal(displayUrl("ws://example.com?token=secret"), "example.com");
  assert.equal(displayUrl("example.com:8080"), "example.com:8080");
});
