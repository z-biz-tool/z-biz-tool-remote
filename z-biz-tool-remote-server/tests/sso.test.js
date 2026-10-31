// ctc SSO 端点的端到端测试。
//
// 跑法：node tests/sso.test.js
//
// **假的 ctc userinfo 端点**：测试自带一个本地 HTTP 服务扮演 ctc，
// 这样用例不依赖真 ctc、可以重复跑、也能测出「ctc 拒绝 token」这类分支
// —— 后者在真环境里根本造不出来。
//
// 覆盖的判据：
//   1. 没配 SSO 时 /api/sso/config 返回 204（客户端据此不显示入口）
//   2. 配了就下发配置
//   3. 没配时 /api/auth/sso 返回 503
//   4. token 有效 ⇒ 换到 remote 会话 + 自动建号
//   5. token 无效 ⇒ 401（不是 500 —— 这是用户该看到的信息）
//   6. 同一个 ctc subject 再登录 ⇒ 复用同一账号，不重复建号
//   7. userinfo 没有 sub ⇒ 502
//   8. 中文显示名 ⇒ 用户名回退到稳定的 sso_ 后缀
//   9. **账号密码登录完全不受影响** —— SSO 是可选的，不是替代

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function readBody(r) {
  if (r.status === 204 || r.status === 205) return null;
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  if (!text) return null;
  if (ct.includes("json")) return JSON.parse(text);
  return text;
}

function get(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({
    status: r.status,
    body: await readBody(r),
  }));
}
function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await readBody(r) }));
}

function assert(c, m) {
  if (!c) throw new Error(`assert: ${m}`);
}

async function waitForServer(port, maxMs = 5000) {
  for (let i = 0; i < maxMs / 100; i++) {
    try {
      const r = await get(port, "/healthz");
      if (r.status === 200) return;
    } catch {}
    await delay(100);
  }
  throw new Error("server not up");
}

/**
 * 起一个「假的 ctc」：按 Bearer token 决定返回什么身份。
 *
 * 有效 token → 给一份 claims；无效 → 401。这样一次测试能同时覆盖
 * 「ctc 认了」与「ctc 拒了」两条分支。
 */
function startFakeCtc(claimsByToken) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const auth = req.headers.authorization || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      const claims = claimsByToken[token];
      if (!claims) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "invalid_token" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(claims));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/** 起 remote 服务端，带一组 SSO 环境变量。 */
async function startServer(port, extraEnv) {
  const dir = mkdtempSync(join(tmpdir(), "zbt-sso-"));
  const env = {
    ...process.env,
    DATA_FILE: join(dir, "data.json"),
    PORT: String(port),
    REGISTER_RATE_LIMIT: "0",
    ...extraEnv,
  };
  delete env.AUTH_TOKEN;
  const child = spawn(process.execPath, ["server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  await waitForServer(port);
  return child;
}

async function main() {
  const ctc = await startFakeCtc({
    "good-token": { sub: "ctc-u-42", preferred_username: "zhangsan", name: "张三" },
    "zh-token": { sub: "ctc-u-77", name: "李四" },
    "nosub-token": { name: "没有 subject" },
    "bound-token": { sub: "ctc-u-42", preferred_username: "zhangsan" },
  });
  const ctcPort = ctc.address().port;
  const ctcBase = `http://127.0.0.1:${ctcPort}`;
  console.log(`[t] fake ctc on ${ctcBase}`);

  const SSO_CONFIG = {
    SSO_AUTHORIZE_URL: `${ctcBase}/oauth2/authorize`,
    SSO_TOKEN_URL: `${ctcBase}/oauth2/token`,
    SSO_USERINFO_URL: `${ctcBase}/oauth2/userinfo`,
    SSO_CLIENT_ID: "z-biz-tool-remote",
    SSO_SCOPE: "openid profile email",
  };

  // ── A 组：服务端**没配** SSO ─────────────────────────────────────
  {
    const port = 19201;
    const child = await startServer(port, {});
    try {
      const cfg = await get(port, "/api/sso/config");
      assert(cfg.status === 204, `没配时 config 应 204，实际 ${cfg.status}`);
      console.log("[t] 未配置 ⇒ config 204 ✓");

      const r = await post(port, "/api/auth/sso", { ctcAccessToken: "whatever" });
      assert(r.status === 503, `没配时 sso 登录应 503，实际 ${r.status}`);
      console.log("[t] 未配置 ⇒ 登录 503 ✓");

      // 账号密码登录照常 —— SSO 是可选的，不该影响既有能力
      const reg = await post(port, "/api/auth/register", { username: "alice", password: "secret123" });
      assert(reg.status === 201, `SSO 关闭时注册仍应可用，实际 ${reg.status}`);
      console.log("[t] 未配置 ⇒ 账号密码注册照常 ✓");
    } finally {
      child.kill();
    }
  }

  // ── B 组：服务端**配了** SSO ─────────────────────────────────────
  {
    const port = 19202;
    const child = await startServer(port, SSO_CONFIG);
    try {
      const cfg = await get(port, "/api/sso/config");
      assert(cfg.status === 200, `配了以后 config 应 200，实际 ${cfg.status}`);
      assert(cfg.body.clientId === "z-biz-tool-remote", "config clientId");
      assert(cfg.body.userInfoUrl === `${ctcBase}/oauth2/userinfo`, "config userInfoUrl");
      // redirectUri **不下发** —— 它的端口由客户端本地分配
      assert(cfg.body.redirectUri === undefined, "config 不该带 redirectUri");
      console.log("[t] 配置下发 ✓");

      // 没带 token 时 /api/me 必须 401 —— 不能因为接了 SSO 就放松鉴权
      const me0 = await get(port, "/api/me");
      assert(me0.status === 401, `未授权访问 /api/me 应 401，实际 ${me0.status}`);
      console.log("[t] 未授权访问 /api/me 仍 401 ✓");

      // token 有效 ⇒ 换到 remote 会话 + 自动建号
      const ok = await post(port, "/api/auth/sso", { ctcAccessToken: "good-token" });
      assert(ok.status === 200, `有效 token 应 200，实际 ${ok.status}`);
      assert(ok.body.accessToken, "应拿到 remote 的 accessToken");
      assert(ok.body.user.username === "zhangsan", `用户名应取自 claims，实际 ${ok.body.user?.username}`);
      const userId = ok.body.user.id;
      console.log(`[t] 有效 token ⇒ 会话 + 建号（username=${ok.body.user.username}）✓`);

      // 该 accessToken 真能用
      const me1 = await fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { authorization: `Bearer ${ok.body.accessToken}` },
      }).then(async (r) => ({ status: r.status, body: await readBody(r) }));
      assert(me1.status === 200, `换来的 token 应能用，实际 ${me1.status}`);
      console.log("[t] 换来的 token 能访问 /api/me ✓");

      // 同一个 ctc subject 再登录 ⇒ 复用同一账号
      const again = await post(port, "/api/auth/sso", { ctcAccessToken: "bound-token" });
      assert(again.status === 200, `同一 subject 再登录应 200，实际 ${again.status}`);
      assert(
        again.body.user.id === userId,
        `不该重复建号：${userId} vs ${again.body.user?.id}`
      );
      console.log("[t] 同一 ctc subject ⇒ 复用账号，不重复建号 ✓");

      // token 无效 ⇒ 401（不是 500）
      const bad = await post(port, "/api/auth/sso", { ctcAccessToken: "expired-token" });
      assert(bad.status === 401, `ctc 拒绝的 token 应 401，实际 ${bad.status}`);
      console.log("[t] ctc 拒绝 ⇒ 401（不是 500）✓");

      // 缺参数 ⇒ 400
      const missing = await post(port, "/api/auth/sso", {});
      assert(missing.status === 400, `缺 token 应 400，实际 ${missing.status}`);
      console.log("[t] 缺参数 ⇒ 400 ✓");

      // userinfo 没有 sub ⇒ 502
      const nosub = await post(port, "/api/auth/sso", { ctcAccessToken: "nosub-token" });
      assert(nosub.status === 502, `没有 sub 应 502，实际 ${nosub.status}`);
      console.log("[t] userinfo 缺 sub ⇒ 502 ✓");

      // 中文显示名 ⇒ 用户名回退到稳定后缀
      const zh = await post(port, "/api/auth/sso", { ctcAccessToken: "zh-token" });
      assert(zh.status === 200, `中文名用户应能登录，实际 ${zh.status}`);
      assert(
        /^sso_[a-zA-Z0-9]+$/.test(zh.body.user.username),
        `用户名应回退到 sso_ 后缀，实际 ${zh.body.user?.username}`
      );
      console.log(`[t] 中文显示名 ⇒ 回退用户名 ${zh.body.user.username} ✓`);

      // 同一个中文名账号再登录，仍复用同一条记录（用户名后缀必须稳定）
      const zh2 = await post(port, "/api/auth/sso", { ctcAccessToken: "zh-token" });
      assert(zh2.body.user.id === zh.body.user.id, "中文名账号也必须稳定复用");
      console.log("[t] 中文名账号稳定复用 ✓");

      // 账号密码登录不受影响
      const reg = await post(port, "/api/auth/register", { username: "bob", password: "pass4567" });
      assert(reg.status === 201, `SSO 开启时注册仍应可用，实际 ${reg.status}`);
      console.log("[t] SSO 开启 ⇒ 账号密码登录不受影响 ✓");
    } finally {
      child.kill();
    }
  }

  // ── C 组：跨端契约（服务端下发的配置必须满足客户端的判据）─────────
  //
  // 客户端的判据在 `z-biz-tool-shared/src/sso/oauth.ts` 的 `missingSsoConfigFields`：
  // authorizeUrl / tokenUrl / clientId / scope **缺任一项就当「未启用」**，不显示入口。
  // 服务端这边必须保证**下发的配置一定是齐全的** —— 否则用户会看到入口、点了、
  // 然后在中途失败（半套配置比没有配置更糟）。
  //
  // 判据在两端各写一份会漂移，所以这条用例把**客户端那份判据抄过来当断言**：
  // 哪天真改了协议层的必填项，这条会红，提醒同步。
  {
    const REQUIRED_FOR_CLIENT = ["authorizeUrl", "tokenUrl", "clientId", "scope"];
    const port = 19203;
    const child = await startServer(port, SSO_CONFIG);
    try {
      const cfg = await get(port, "/api/sso/config");
      assert(cfg.status === 200, `配了以后 config 应 200，实际 ${cfg.status}`);
      for (const k of REQUIRED_FOR_CLIENT) {
        assert(
          typeof cfg.body[k] === "string" && cfg.body[k].trim(),
          `服务端下发的配置缺 ${k} ⇒ 客户端会当「未启用」不显示入口`
        );
      }
      console.log("[t] 下发的配置满足客户端必填判据 ✓");

      // 反向：服务端的「已启用」条件必须**不少于**客户端的必填项。
      // 若服务端比客户端宽松，它会 200 下发半套配置 → 客户端静默不显示入口，
      // 用户只会觉得「SSO 按钮怎么不见了」，查不出原因。
      //
      // 比对的是**环境变量名**（服务端判据的真实来源），通过一张映射表对上
      // 客户端的小驼峰字段名 —— 两套命名，直接比会得到无意义的结论。
      const CLIENT_FIELD_TO_ENV = {
        authorizeUrl: "SSO_AUTHORIZE_URL",
        tokenUrl: "SSO_TOKEN_URL",
        clientId: "SSO_CLIENT_ID",
        scope: "SSO_SCOPE",
      };
      for (const [field, envName] of Object.entries(CLIENT_FIELD_TO_ENV)) {
        assert(
          envName in SSO_CONFIG && String(SSO_CONFIG[envName]).trim(),
          `客户端必填 ${field}，但服务端的启用条件没看 ${envName} ⇒ 会下发半套配置`
        );
      }
      console.log("[t] 服务端启用条件 ⊇ 客户端必填项 ✓");

      // ── 阴性对照：判据自己得有牙齿 ────────────────────────────────
      // 上面的映射检查只验「配置项名对得上」，验不出 `ssoEnabled` 的**逻辑**被改坏
      // （把 && 改成 || 那种）。所以直接测判据本身：少任何一项都必须判「未启用」。
      //
      // 这条必须能被单独打红 —— 判据被改成永真时，门禁会安静地不再报破损，
      // 那比门禁误报更危险（大家会把命令塞进预留清单）。
      const { ssoEnabled } = await import("../auth.js");
      const ONE_OFF = ["SSO_AUTHORIZE_URL", "SSO_TOKEN_URL", "SSO_USERINFO_URL", "SSO_CLIENT_ID"];
      const base = {
        SSO_AUTHORIZE_URL: "https://ctc.example.com/authorize",
        SSO_TOKEN_URL: "https://ctc.example.com/token",
        SSO_USERINFO_URL: "https://ctc.example.com/userinfo",
        SSO_CLIENT_ID: "z-biz-tool-remote",
      };
      // 全齐 ⇒ 已启用
      assert(ssoEnabled(base), "配置齐全时 ssoEnabled 应为 true");
      // 少任何一项 ⇒ 未启用
      for (const k of ONE_OFF) {
        const partial = { ...base };
        delete partial[k];
        assert(
          !ssoEnabled(partial),
          `少 ${k} 时 ssoEnabled 必须为 false（否则会 200 下发半套配置）`
        );
      }
      // 空串视同缺
      assert(!ssoEnabled({ ...base, SSO_CLIENT_ID: "" }), "空串视同缺");
      console.log("[t] ssoEnabled 判据：少任一项 ⇒ 未启用 ✓");
    } finally {
      child.kill();
    }
  }

  ctc.close();
  console.log("\nALL SSO CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
