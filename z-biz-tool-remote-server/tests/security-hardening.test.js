// 安全加固回归测试（注册闸门 / TLS / 令牌不出现在 URL 查询串）。
//
//   node tests/security-hardening.test.js
// or:    npm run test:hardening
//
// 为什么这层必须有网：这三项都是**运行时行为**，静态读代码看不出来 ——
//   · 注册端点到底回 400 还是 429 / 403；
//   · 配了证书之后端口上到底跑的是不是 TLS（ssl.wrap_socket 能不能握手成功）；
//   · 服务端还认不认 URL 查询串里的令牌。
//
// 硬口径：**不注册任何真实账号** —— 所有注册尝试要么用非法参数（停在校验前），
// 要么被闸门挡掉；「邀请码正确」那条路径也用非法 username 验证（期望 400 而不是 403），
// 所以整个文件跑完也不会在存储里留下任何用户。

import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import https from "node:https";
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

function startServer(env) {
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, ...env },
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

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
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
  ws.on("close", (code) => {
    closeCode = code;
  });
  const done = new Promise((resolve) => {
    ws.on("close", () => resolve({ frames, closeCode, opened }));
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

// ---------------------------------------------------------------- 1. 注册限流

async function testRegisterRateLimit() {
  console.log("\n[1] 注册端点按 IP 限流（超限 429，而不是每次都 400 参数校验错）");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-hard-")), "data.json");
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
    for (let i = 0; i < 6; i++) {
      // 非法参数：只验闸门，不建号
      const r = await post(port, "/api/auth/register", {});
      codes.push(r.status);
    }
    console.log(`    状态码序列: ${JSON.stringify(codes)}`);
    check(codes.slice(0, 3).every((c) => c === 400), "前 3 次仍是参数校验错(400)");
    check(codes.slice(3).every((c) => c === 429), "第 4 次起被限流(429)");
    const r = await post(port, "/api/auth/register", {});
    check(r.headers.get("retry-after") !== null, "429 带 Retry-After 头");
    check(r.headers.get("x-ratelimit-limit") === "3", "带 X-RateLimit-Limit 头");
    // 没有真的建号
    const login = await post(port, "/api/auth/login", { username: "nobody", password: "secret123" });
    check(login.status === 401, "限流期间没有创建任何账号（login 仍 401）");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 2. 邀请码

async function testInviteCode() {
  console.log("\n[2] 注册端点邀请码（缺码/错码 403）");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-hard-")), "data.json");
  const { child } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "warn",
    AUTH_TOKEN: "",
    INVITE_CODE: "s3cret-invite",
    REGISTER_RATE_LIMIT: "0",
  });
  try {
    check(await waitForHealth(port), "server healthy");
    const noCode = await post(port, "/api/auth/register", { username: "probe", password: "secret123" });
    check(noCode.status === 403, `缺邀请码 → 403（实测 ${noCode.status}）`);
    const wrongCode = await post(port, "/api/auth/register", {
      username: "probe",
      password: "secret123",
      inviteCode: "nope",
    });
    check(wrongCode.status === 403, `错邀请码 → 403（实测 ${wrongCode.status}）`);
    // 邀请码正确 → 闸门放行（用非法 username 验证，停在 400，不会建号）
    const rightCode = await post(port, "/api/auth/register", {
      username: "",
      password: "secret123",
      inviteCode: "s3cret-invite",
    });
    check(rightCode.status === 400, `邀请码正确 → 闸门放行(400 而非 403)（实测 ${rightCode.status}）`);
    const login = await post(port, "/api/auth/login", { username: "probe", password: "secret123" });
    check(login.status === 401, "被闸门挡下的注册没有建号（login 仍 401）");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 3. TLS

function makeSelfSignedCert(dir) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost",
  ], { stdio: "ignore" });
  return { key, cert };
}

async function testTls() {
  console.log("\n[3] TLS / WSS（配了证书就走 TLS，握手成功而不是 WRONG_VERSION_NUMBER）");
  const dir = mkdtempSync(join(tmpdir(), "zbt-cert-"));
  let cert;
  try {
    cert = makeSelfSignedCert(dir);
  } catch (e) {
    console.log(`  ! 跳过（本机没有可用的 openssl：${String(e).slice(0, 80)}）`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const port = freePort();
  const dataFile = join(dir, "data.json");
  const { child, logs } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "info",
    TLS_KEY_PATH: cert.key,
    TLS_CERT_PATH: cert.cert,
  });
  try {
    check(await waitForHealth(port, "https"), "https /healthz 可用");
    // 真正的握手判定：ssl.wrap_socket 的等价物（tls.connect）
    const handshake = await new Promise((resolve) => {
      const sock = tls.connect(
        { host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" },
        () => resolve({ ok: true, authorized: sock.authorized, cipher: sock.getCipher() })
      );
      sock.on("error", (e) => resolve({ ok: false, err: String(e) }));
      setTimeout(() => resolve({ ok: false, err: "timeout" }), 4000);
    });
    console.log(`    握手结果: ${JSON.stringify(handshake)}`);
    check(handshake.ok === true, "tls.connect 握手成功（不是 WRONG_VERSION_NUMBER）");
    // 明文 HTTP 打过去必须失败（证明端口上跑的确实是 TLS）
    let plainOk = true;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      plainOk = false;
    }
    check(plainOk === false, "同一端口上的明文 HTTP 请求失败（说明确实是 TLS）");
    // 根路径自述的协议要跟着变成 wss
    const body = await new Promise((resolve) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve(buf));
        }
      );
      req.on("error", () => resolve(""));
      req.end();
    });
    check(body.includes("wss://"), "根路径自述协议为 wss://");
    check(
      logs.some((l) => l.includes('"tls":"enabled"')),
      "启动日志里 tls=enabled"
    );
  } finally {
    await stop(child);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testTlsFailFast() {
  console.log("\n[4] TLS 配错时必须启动失败（不再静默回落成明文）");
  const dir = mkdtempSync(join(tmpdir(), "zbt-cert-"));
  const cert = makeSelfSignedCert(dir);
  const port = freePort();
  const { child, logs } = startServer({
    PORT: String(port),
    DATA_FILE: join(dir, "data.json"),
    LOG_LEVEL: "info",
    TLS_KEY_PATH: cert.key, // 只给 key，不给 cert
  });
  const exit = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    setTimeout(() => resolve(null), 5000);
  });
  check(exit !== null && exit !== 0, `只配 key 时进程退出码非 0（实测 ${exit}）`);
  check(
    logs.some((l) => l.includes("TLS 配置不完整")),
    "日志说明是 TLS 配置不完整（而不是静默降级）"
  );
  await stop(child);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- 5. 令牌不出现在 URL 查询串

async function testTokenTransportFrame() {
  console.log("\n[5] 默认传输方式：令牌走首帧，URL 查询串里的令牌**不被读取**");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-hard-")), "data.json");
  const token = "shared-token-" + randomUUID().slice(0, 8);
  const { child, logs } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "info",
    AUTH_TOKEN: token,
    WS_AUTH_TIMEOUT_MS: "800",
  });
  try {
    check(await waitForHealth(port), "server healthy");
    // 5.1 查询串带令牌 ⇒ 不认（首帧没来就断连）
    const legacy = openWs(`ws://127.0.0.1:${port}/?token=${token}`);
    const legacyResult = await legacy.done;
    check(
      !legacyResult.frames.some((f) => f.type === "AUTH_OK"),
      "查询串里的令牌没有被接受（没有 AUTH_OK）"
    );
    check(legacyResult.closeCode === 4401, `未鉴权连接被断开（close=${legacyResult.closeCode}）`);
    // 5.2 首帧带令牌 ⇒ 认
    const framed = openWs(`ws://127.0.0.1:${port}/`, { authToken: token });
    await delay(300);
    framed.ws.send(JSON.stringify({ type: "REGISTER", deviceId: "dev-A" }));
    await delay(300);
    check(
      framed.frames.some((f) => f.type === "AUTH_OK"),
      "首帧 AUTH 通过后服务端回 AUTH_OK"
    );
    check(
      framed.frames.some((f) => f.type === "REGISTER_SUCCESS"),
      "首帧 AUTH 之后的 REGISTER 正常处理"
    );
    framed.ws.close();
    // 5.3 日志里不能出现明文令牌
    const allLogs = logs.join("");
    check(!allLogs.includes(token), "服务端日志里没有明文令牌");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

async function testTokenTransportLegacyCompat() {
  console.log("\n[6] 兼容开关：WS_TOKEN_TRANSPORT=both 时老客户端（?token=）仍可用");
  const port = freePort();
  const dataFile = join(mkdtempSync(join(tmpdir(), "zbt-hard-")), "data.json");
  const token = "shared-token-" + randomUUID().slice(0, 8);
  const { child, logs } = startServer({
    PORT: String(port),
    DATA_FILE: dataFile,
    LOG_LEVEL: "info",
    AUTH_TOKEN: token,
    WS_TOKEN_TRANSPORT: "both",
  });
  try {
    check(await waitForHealth(port), "server healthy");
    const legacy = openWs(`ws://127.0.0.1:${port}/?token=${token}`);
    await delay(400);
    legacy.ws.send(JSON.stringify({ type: "REGISTER", deviceId: "dev-B" }));
    await delay(400);
    check(
      legacy.frames.some((f) => f.type === "REGISTER_SUCCESS"),
      "both 模式下 ?token= 仍能完成协议流程"
    );
    legacy.ws.close();
    // 错的令牌在日志里必须打码
    const bad = openWs(`ws://127.0.0.1:${port}/?token=super-secret-value`);
    await delay(600);
    bad.ws.close();
    const allLogs = logs.join("");
    check(!allLogs.includes("super-secret-value"), "被拒的令牌在日志里被打码");
    check(allLogs.includes("token=***"), "日志里查询串令牌显示为 token=***");
  } finally {
    await stop(child);
    rmSync(join(dataFile, ".."), { recursive: true, force: true });
  }
}

async function main() {
  console.log("z-biz-tool-remote-server 安全加固回归测试");
  await testRegisterRateLimit();
  await testInviteCode();
  await testTls();
  await testTlsFailFast();
  await testTokenTransportFrame();
  await testTokenTransportLegacyCompat();
  console.log(`\n结果: ${checks - failures}/${checks} 通过, ${failures} 失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
