// 安全回归测试（第二批）—— 把 8cc68c7 的三个修复钉在测试网里，防回归。
//
//   node tests/security-regression.test.js
// or:    npm run test:regression
//
// 与 security-hardening.test.js 的分工：那组覆盖「闸门存在 / TLS 握手 / both 兼容」，
// 本组补三条更细的口径：
//   1. **默认配置**（环境里没有 WS_TOKEN_TRANSPORT）下，URL 查询串传令牌不被接受；
//      且显式 query 模式才认查询串 —— 「除非显式 both/query」的两半都要钉住。
//   2. 限流闸门排在**参数校验之前**：非法 body（空 JSON / 空 username / 坏 JSON /
//      短口令）同样计数 —— 否则攻击者一直用非法 body 打，闸门永远数不到。
//   3. TLS 材料不完整（只配 cert / 文件不存在）时启动即失败。
//
// 硬口径同 hardening 组：**不注册任何真实账号**，跑完不在存储里留用户。

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

let failures = 0;
let checks = 0;

function check(cond, what) {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${what}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${what}`);
  }
}

function freePort() {
  return 19000 + Math.floor(Math.random() * 800);
}

/**
 * 启动 server。env 里列出的键先覆盖、del 里列出的键先删除 ——
 * 「默认配置」必须是**环境里没有这个变量**，而不是设成空串（空串等价于默认，
 * 但测不到「运维忘了设」的真实路径）。
 */
function startServer(env = {}, del = []) {
  const childEnv = { ...process.env, ...env };
  for (const k of del) delete childEnv[k];
  const child = spawn(process.execPath, ["server.js"], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  const capture = (b) => {
    logs.push(b.toString());
    if (process.env.VERBOSE) process.stderr.write(`[srv] ${b}`);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, logs };
}

async function waitForHealth(port, proto = "http", attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const mod = proto === "https" ? await import("node:https") : await import("node:http");
      const ok = await new Promise((resolve) => {
        const req = mod.default.request(
          { host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: 500, rejectUnauthorized: false },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ok) return true;
    } catch {
      /* ignore */
    }
    await delay(100);
  }
  return false;
}

async function post(port, path, body, rawBody) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** 连 WS 并收集收到的帧；返回 { frames, closeCode, opened } */
function openWs(url, { authToken, onOpen } = {}) {
  const ws = new WebSocket(url);
  const frames = [];
  let closeCode = null;
  let opened = false;
  ws.on("message", (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()));
    } catch {
      /* ignore non-JSON */
    }
  });
  ws.on("open", () => {
    opened = true;
    if (authToken) ws.send(JSON.stringify({ type: "AUTH", token: authToken }));
    if (onOpen) onOpen(ws);
  });
  ws.on("error", () => {
    /* 握手被拒（401）时 ws 会抛 error；这里吞掉，避免未处理事件炸掉测试 */
  });
  const done = new Promise((resolve) => {
    ws.on("close", (code) => {
      closeCode = code;
      resolve({ frames, closeCode, opened });
    });
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ frames, closeCode, opened });
    }, 6000);
  });
  return { ws, done, frames };
}

async function stop(child) {
  child.kill("SIGTERM");
  await delay(200);
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

// ------------------------------------------- 1. 默认配置不读查询串令牌

async function testDefaultTransportRejectsQueryToken() {
  console.log("\n[1] 默认配置（无 WS_TOKEN_TRANSPORT）：URL 查询串传令牌不被接受");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-reg-")), "data.json");
  const token = "shared-token-" + randomUUID().slice(0, 8);
  const { child } = startServer(
    { PORT: String(port), DATA_FILE: dataFile, LOG_LEVEL: "warn", AUTH_TOKEN: token, WS_AUTH_TIMEOUT_MS: "800" },
    ["WS_TOKEN_TRANSPORT"] // 显式删掉：测「运维忘了设」时的默认路径
  );
  try {
    check(await waitForHealth(port), "server healthy");
    // 1.1 查询串带令牌 ⇒ 不认
    const legacy = openWs(`ws://127.0.0.1:${port}/?token=${token}`);
    const r = await legacy.done;
    check(
      !r.frames.some((f) => f.type === "AUTH_OK"),
      "查询串令牌没有产生 AUTH_OK（默认模式不读查询串）"
    );
    check(r.closeCode === 4401, `未鉴权连接被兜底断开（close=${r.closeCode}）`);
    // 1.2 对照组：同一条连接改成首帧带令牌 ⇒ 认（证明不是「谁都连不上」）
    const framed = openWs(`ws://127.0.0.1:${port}/`, { authToken: token });
    await delay(300);
    framed.ws.send(JSON.stringify({ type: "REGISTER", deviceId: "dev-default" }));
    await delay(300);
    check(
      framed.frames.some((f) => f.type === "AUTH_OK"),
      "对照组：首帧 AUTH 被接受（默认链路本身是通的）"
    );
    framed.ws.close();
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

async function testExplicitQueryTransportAcceptsQueryToken() {
  console.log("\n[2] 显式 WS_TOKEN_TRANSPORT=query：查询串令牌被接受（兼容开关仍有效）");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-reg-")), "data.json");
  const token = "shared-token-" + randomUUID().slice(0, 8);
  const { child } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "warn",
    AUTH_TOKEN: token,
    WS_TOKEN_TRANSPORT: "query",
  });
  try {
    check(await waitForHealth(port), "server healthy");
    // 2.1 query 模式 + 查询串令牌 ⇒ 握手即鉴权，协议走通
    const legacy = openWs(`ws://127.0.0.1:${port}/?token=${token}`);
    await delay(400);
    legacy.ws.send(JSON.stringify({ type: "REGISTER", deviceId: "dev-query" }));
    await delay(400);
    check(
      legacy.frames.some((f) => f.type === "REGISTER_SUCCESS"),
      "query 模式下 ?token= 能完成注册（显式开启时才兼容老客户端）"
    );
    legacy.ws.close();
    // 2.2 query 模式 + 不带令牌 ⇒ 握手即 401（老行为：没有「先连上再鉴权」）
    const noToken = openWs(`ws://127.0.0.1:${port}/`);
    const r = await noToken.done;
    check(!r.opened, "query 模式不带令牌时握手被拒（未进入 open）");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

// ------------------------------------------- 2. 限流闸门排在参数校验之前

async function testRateLimitCountsInvalidBodies() {
  console.log("\n[3] 限流器对非法 body 也计数（闸门排在参数校验之前）");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-reg-")), "data.json");
  const { child } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "warn",
    AUTH_TOKEN: "",
    REGISTER_RATE_LIMIT: "3",
    REGISTER_RATE_WINDOW_MS: "600000",
  });
  try {
    check(await waitForHealth(port), "server healthy");
    const codes = [];
    const attempts = [
      { body: {}, label: "空 JSON" },
      { body: { username: "", password: "secret123" }, label: "空 username" },
      { rawBody: "not-json-at-all", label: "坏 JSON" },
      { body: { username: "probe_user", password: "x" }, label: "短口令" },
      { body: {}, label: "再打一次空 JSON" },
    ];
    for (const a of attempts) {
      const r = await post(port, "/api/auth/register", a.body, a.rawBody);
      codes.push(r.status);
      console.log(`    ${a.label} → ${r.status}`);
    }
    check(
      codes.slice(0, 3).every((c) => c === 400),
      `前 3 次非法 body 全部停在 400（${JSON.stringify(codes.slice(0, 3))}）`
    );
    check(
      codes.slice(3).every((c) => c === 429),
      `第 4 次起全部 429 —— 非法 body 也计数（${JSON.stringify(codes.slice(3))}）`
    );
    const again = await post(port, "/api/auth/register", {});
    check(again.headers.get("retry-after") !== null, "429 带 Retry-After 头");
    check(again.headers.get("x-ratelimit-limit") === "3", "X-RateLimit-Limit=3");
    // 没有任何一次真的走到建号
    const login = await post(port, "/api/auth/login", { username: "probe_user", password: "secret123" });
    check(login.status === 401, "全程未创建账号（login 仍 401）");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

// ------------------------------------------- 3. TLS 配错即启动失败

function makeSelfSignedCert(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  return { key, cert };
}

async function waitForExit(child, ms = 5000) {
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    setTimeout(() => resolve(null), ms);
  });
}

async function testTlsFailFastVariants() {
  console.log("\n[4] TLS 材料不完整的其它两种形态也必须启动失败");
  const dir = mkdtempSync(join(tmpdir(), "zbt-cert-"));
  let cert;
  try {
    cert = makeSelfSignedCert(dir);
  } catch (e) {
    console.log(`  ! 跳过（本机没有可用的 openssl：${String(e).slice(0, 80)}）`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    // 4.1 只配 cert 不配 key
    {
      const port = freePort();
      const { child, logs } = startServer({
        PORT: String(port),
        DATA_FILE: join(dir, "data.json"),
        LOG_LEVEL: "info",
        TLS_CERT_PATH: cert.cert, // 只给 cert，不给 key
      });
      const exit = await waitForExit(child);
      check(exit !== null && exit !== 0, `只配 cert 时进程退出码非 0（实测 ${exit}）`);
      check(
        logs.some((l) => l.includes("TLS 配置不完整")),
        "日志说明是 TLS 配置不完整"
      );
      await stop(child);
    }
    // 4.2 路径指向不存在的文件
    {
      const port = freePort();
      const { child, logs } = startServer({
        PORT: String(port),
        DATA_FILE: join(dir, "data.json"),
        LOG_LEVEL: "info",
        TLS_KEY_PATH: join(dir, "no-such-key.pem"),
        TLS_CERT_PATH: cert.cert,
      });
      const exit = await waitForExit(child);
      check(exit !== null && exit !== 0, `证书文件不存在时退出码非 0（实测 ${exit}）`);
      check(
        logs.some((l) => l.includes("TLS 文件不存在")),
        "日志指明是文件不存在（而不是崩在 readFile 栈里）"
      );
      await stop(child);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("z-biz-tool-remote-server 安全回归测试（第二批：默认传输 / 闸门顺序 / TLS 配错即败）");
  await testDefaultTransportRejectsQueryToken();
  await testExplicitQueryTransportAcceptsQueryToken();
  await testRateLimitCountsInvalidBodies();
  await testTlsFailFastVariants();
  console.log(`\n结果: ${checks - failures}/${checks} 通过, ${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
