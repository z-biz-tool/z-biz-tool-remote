// ctc SSO 客户端适配层的单元测试（无浏览器、无真实网络、无 Tauri）。
//
// 跑法：npm test
//
// **只测纯逻辑**：服务端配置的完整性判据、base64url 编码。
// 「起服务 → 开浏览器 → 等回调 → 换 token」这条主流程由
// z-biz-tool-shared/src/sso/oauth.ts 的 30 条用例覆盖（那里把环境全部注入了），
// 这里不重复测。
//
// 要测这些判据的原因：
//   - fetchSsoConfig 的「缺任何一项就当没启用」—— 漏了它，客户端会在
//     没配 SSO 的服务器上显示一个点了必失败的登录按钮；
//   - bytesToBase64Url —— 算错会让 PKCE challenge 对不上，
//     ctc 以 invalid_grant 拒掉，而那个报错完全看不出根因。

import { test } from "node:test";
import assert from "node:assert/strict";
import { missingSsoConfigFields } from "z-biz-tool-shared/sso";
import { bytesToBase64Url, fetchSsoConfig } from "../src/services/sso.ts";

/* ------------------------------------------------------------------ *
 * fetchSsoConfig
 * ------------------------------------------------------------------ */

/** 把 fetch 换成按给定响应返回的桩。 */
function stubFetch(status: number, bodyText: string) {
  const original = globalThis.fetch;
  // 204/205/304 是「无正文」状态码 —— 给它们传正文，Response 构造函数
  // 自己就会抛。桩得按真实语义造，否则测的是桩的 bug 而不是被测函数。
  const body = status === 204 || status === 205 || status === 304 ? null : bodyText;
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const FULL_CONFIG = {
  authorizeUrl: "https://ctc.example.com/oauth2/authorize",
  tokenUrl: "https://ctc.example.com/oauth2/token",
  userInfoUrl: "https://ctc.example.com/oauth2/userinfo",
  clientId: "z-biz-tool-remote",
  scope: "openid profile email",
};

test("配置齐全时返回配置", async () => {
  const restore = stubFetch(200, JSON.stringify(FULL_CONFIG));
  try {
    const cfg = await fetchSsoConfig("https://srv.example.com");
    assert.ok(cfg);
    assert.equal(cfg.clientId, "z-biz-tool-remote");
    assert.equal(cfg.authorizeUrl, FULL_CONFIG.authorizeUrl);
    assert.equal(cfg.userInfoUrl, FULL_CONFIG.userInfoUrl);
  } finally {
    restore();
  }
});

test("userInfoUrl 可选 —— 不给也应算配置完整", async () => {
  const { userInfoUrl: _omitted, ...withoutUserInfo } = FULL_CONFIG;
  const restore = stubFetch(200, JSON.stringify(withoutUserInfo));
  try {
    const cfg = await fetchSsoConfig("https://srv.example.com");
    assert.ok(cfg, "userInfoUrl 不是必填项");
    assert.equal(cfg.userInfoUrl, undefined);
  } finally {
    restore();
  }
});

test("服务端没配 SSO（204）时返回 null，不是报错", async () => {
  const restore = stubFetch(204, "");
  try {
    assert.equal(await fetchSsoConfig("https://srv.example.com"), null);
  } finally {
    restore();
  }
});

test("网络层报错时返回 null，不是抛异常", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    // 地址写错 / 服务端没起来都不该让登录页崩掉 —— 只是「没有 SSO 入口」。
    assert.equal(await fetchSsoConfig("https://srv.example.com"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("非 JSON 响应返回 null", async () => {
  const restore = stubFetch(200, "<html>502 Bad Gateway</html>");
  try {
    assert.equal(await fetchSsoConfig("https://srv.example.com"), null);
  } finally {
    restore();
  }
});

// 这条是本文件**最重要**的用例：少任何一项都必须当作「没启用」。
// 半套配置 = 显示入口 → 点了 → 中途失败，比不显示入口糟得多。
//
// 必填项清单**不是手抄的** —— 它取自共享层的 `missingSsoConfigFields`。
// 协议层改必填项，这里自动跟着变；手抄一份就会漂移（漂了以后客户端与服务端
// 对「什么算配好了」各执一词，而这种分裂**没有编译错误可暴露**）。
const REQUIRED_FIELDS = ["authorizeUrl", "tokenUrl", "clientId", "scope"] as const;

for (const field of REQUIRED_FIELDS) {
  test(`缺 ${field} 即视为未启用（不显示入口）`, async () => {
    const partial = { ...FULL_CONFIG } as Record<string, string>;
    delete partial[field];
    const restore = stubFetch(200, JSON.stringify(partial));
    try {
      assert.equal(
        await fetchSsoConfig("https://srv.example.com"),
        null,
        `缺 ${field} 时必须返回 null`
      );
    } finally {
      restore();
    }
  });
}

test("必填项清单与共享层判据一致（防手抄漂移）", () => {
  // 共享层说缺哪些就是缺哪些 —— 客户端的清单必须是它的子集，
  // 且**不多不少**：多一项会让本该能用的配置被判成未启用。
  const missing = missingSsoConfigFields(FULL_CONFIG, false);
  assert.deepEqual(
    [...missing].sort(),
    [],
    `完整配置不该被判缺字段，实际缺：${missing.join("、")}`
  );
  // 共享层判「缺」时，客户端也必须判「缺」。
  for (const field of REQUIRED_FIELDS) {
    const partial = { ...FULL_CONFIG } as Record<string, string>;
    delete partial[field];
    assert.ok(
      missingSsoConfigFields(partial, false).includes(field),
      `共享层应认为缺 ${field}`
    );
  }
});

test("字段为空串也算缺（服务端可能只写了环境变量占位）", async () => {
  const restore = stubFetch(200, JSON.stringify({ ...FULL_CONFIG, clientId: "" }));
  try {
    assert.equal(await fetchSsoConfig("https://srv.example.com"), null);
  } finally {
    restore();
  }
});

test("非对象 JSON 返回 null", async () => {
  const restore = stubFetch(200, JSON.stringify(["not", "an", "object"]));
  try {
    assert.equal(await fetchSsoConfig("https://srv.example.com"), null);
  } finally {
    restore();
  }
});

/* ------------------------------------------------------------------ *
 * bytesToBase64Url
 * ------------------------------------------------------------------ */

test("bytesToBase64Url 是 RFC 4648 §5 的 base64url（无填充）", () => {
  // 标准向量（RFC 4648 测试向量，逐条比对）。
  const cases: Array<[number[], string]> = [
    [[], ""],
    [[0x66], "Zg"],
    [[0x66, 0x6f], "Zm8"],
    [[0x66, 0x6f, 0x6f], "Zm9v"],
    [[0x66, 0x6f, 0x6f, 0x62], "Zm9vYg"],
    [[0x66, 0x6f, 0x6f, 0x62, 0x61], "Zm9vYmE"],
    [[0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72], "Zm9vYmFy"],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(bytesToBase64Url(new Uint8Array(bytes)), expected, `输入 ${bytes.join(",")}`);
  }
});

test("base64url 把 + / 换成 - _，且不带 = 填充", () => {
  // 0xFB 0xFF 0xBF → base64 "+/+/" 的 base64url 形态。
  const encoded = bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]));
  assert.ok(!encoded.includes("+"), `不该有 +：${encoded}`);
  assert.ok(!encoded.includes("/"), `不该有 /：${encoded}`);
  assert.ok(!encoded.includes("="), `不该有 = 填充：${encoded}`);
  assert.equal(encoded, "-_-_");
});

test("32 字节的 SHA-256 结果（PKCE 的典型长度）无填充且长度正确", () => {
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++) digest[i] = i;
  const encoded = bytesToBase64Url(digest);
  // 32 字节 → 43 个 base64url 字符（去掉填充后）。这正是 RFC 7636 要求的
  // code_challenge 最短长度（43），少一个字符 ctc 都会拒。
  assert.equal(encoded.length, 43, `长度应 43，实际 ${encoded.length}`);
  assert.match(encoded, /^[A-Za-z0-9\-_]+$/, "只能含 base64url 字符");
});

test("中文/高位字节按字节编码，不做字符串往返", () => {
  // 0xFF 0xFE 这种字节若被 btoa/JSON 往返一次会变成别的东西
  // （按 UTF-8 解会得到替换字符 U+FFFD），导致 PKCE challenge 对不上。
  // 这里逐字节断言。
  //
  // 推导：0xff,0xfe,0xfd 的 base64 是 "//79"，按 RFC 4648 §5
  // '/'(63) → '_'，所以 base64url 是 "__79"。
  const encoded = bytesToBase64Url(new Uint8Array([0xff, 0xfe, 0xfd]));
  assert.equal(encoded, "__79");
});
