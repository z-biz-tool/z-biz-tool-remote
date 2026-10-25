#!/usr/bin/env node
// security-probe.mjs —— 对一套已部署的 z-biz-tool-remote-server 做**只读**安全探测。
//
// 背景：8cc68c7 在源码层收掉了三个暴露面（注册免鉴权 / 无 TLS / 令牌进 URL），
// 但修复躺在 git 里，边缘机 101.37.80.51 上跑的仍是旧镜像。本脚本把「修复是否
// 真的活在部署里」变成一条命令 + 一个退出码。
//
// 用法：
//   node scripts/security-probe.mjs [baseUrl]
//   PROBE_BASE_URL=https://101.37.80.51 node scripts/security-probe.mjs
//   node scripts/security-probe.mjs --help
//
// 四项探测（全部只读、限次，不会创建任何账号）：
//   A. 注册端点连打 N 次（默认 15，body 恒为 {} ⇒ 停在参数校验）：
//      期望出现 429 —— 证明限流闸门真的在跑，而不是每次都放行到参数校验。
//   B. 明文/加密：http:// 必须失败或重定向；https:// 必须通（顺带验证书链）。
//   C. 不带令牌的 WS 连接发帧，必须被拒（ERROR/AUTH_REQUIRED + close 4401）。
//   D. TLS 下的 /healthz 必须 200 且 ok:true。
//
// 退出码：0 = 全部 PASS（允许 WARN）；1 = 有 FAIL；2 = 用法/参数错误。
// 零依赖：只用 node 内置模块（fetch / net / tls / crypto），不需要 npm install。

import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const DEFAULT_ATTEMPTS = 15;

function usage() {
  process.stdout.write(
`security-probe.mjs — z-biz-tool-remote-server 部署面安全探测（只读）

用法:
  node scripts/security-probe.mjs [baseUrl]
  PROBE_BASE_URL=https://101.37.80.51 node scripts/security-probe.mjs

参数:
  baseUrl               被测地址，如 https://101.37.80.51 或 http://127.0.0.1:8080
                        也可用环境变量 PROBE_BASE_URL 指定（argv 优先）

选项:
  --attempts <n>        探测 A 的注册连打次数（默认 ${DEFAULT_ATTEMPTS}，硬上限 30）
  --limit <n>           期望的限流阈值 REGISTER_RATE_LIMIT（默认 5；仅用于报告展示，
                        不参与判定——阈值以响应头 X-RateLimit-Limit 为准）
  --timeout-ms <n>      单请求超时（默认 8000）
  -h, --help            显示本帮助

探测内容:
  A  注册端点连打，期望前 N 次之后出现 429（证明限流生效；不会建号）
  B  http:// 明文访问应失败/重定向；https:// 应通（证书链可信）
  C  不带令牌的 WS 连接发帧，应被 4401 拒绝
  D  TLS 下 /healthz 应 200 且 ok:true

退出码:
  0  全部通过（允许 WARN）
  1  存在 FAIL
  2  用法/参数错误
`);
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const out = { baseUrl: "", attempts: DEFAULT_ATTEMPTS, limit: 5, timeoutMs: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    } else if (a === "--attempts") {
      out.attempts = Number(argv[++i]);
    } else if (a === "--limit") {
      out.limit = Number(argv[++i]);
    } else if (a === "--timeout-ms") {
      out.timeoutMs = Number(argv[++i]);
    } else if (!out.baseUrl) {
      out.baseUrl = a;
    } else {
      process.stderr.write(`未知参数: ${a}\n`);
      usage();
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.attempts) || out.attempts < 1) {
    process.stderr.write("--attempts 必须是正整数\n");
    process.exit(2);
  }
  out.attempts = Math.min(out.attempts, 30); // 硬上限：探测也必须限次
  if (!out.baseUrl) out.baseUrl = process.env.PROBE_BASE_URL || "";
  if (!out.baseUrl) {
    process.stderr.write("缺少 baseUrl：argv 位置参数或环境变量 PROBE_BASE_URL 二选一\n\n");
    usage();
    process.exit(2);
  }
  return out;
}

// ---------- 小工具 ----------

const results = [];
function report(level, probe, what, detail) {
  results.push({ level, probe, what, detail: detail || "" });
  const mark = level === "PASS" ? "✓" : level === "WARN" ? "!" : "✗";
  const line = `  ${mark} [${probe}] ${what}${detail ? ` —— ${detail}` : ""}`;
  if (level === "FAIL") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/** 把 baseUrl 拆成 { origin, scheme, hostname, port }；port 缺省按协议补。 */
function parseBase(raw) {
  const u = new URL(raw);
  const scheme = u.protocol.replace(":", "");
  const port = u.port || (scheme === "https" ? "443" : "80");
  return {
    scheme,
    hostname: u.hostname,
    port,
    origin: `${scheme}://${u.hostname}:${port}`,
    wsOrigin: `${scheme === "https" ? "wss" : "ws"}://${u.hostname}:${port}`,
  };
}

// ---------- 零依赖 WebSocket 客户端（只够探测用） ----------

/**
 * 连 WS，可选 onOpen(send) 在握手成功后立即发帧。
 * 收齐服务端帧与 close code 后 resolve。
 * @returns {Promise<{handshake:number, frames:Array, closeCode:number|null, error:string}>}
 */
function wsProbe(url, { timeoutMs = 5000, onOpen } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isTls = u.protocol === "wss:";
    const port = Number(u.port) || (isTls ? 443 : 80);
    const secKey = crypto.randomBytes(16).toString("base64");
    const frames = [];
    let closeCode = null;
    let handshake = 0;
    let settled = false;
    let buf = Buffer.alloc(0);

    const finish = (error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch {}
      resolve({ handshake, frames, closeCode, error });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    const onConnect = () => {
      const path = (u.pathname || "/") + (u.search || "");
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${u.hostname}:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${secKey}\r\n` +
        "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    };

    const socket = isTls
      ? tls.connect({ ...tlsConnectOptions(u.hostname, port, false) }, onConnect)
      : net.connect({ host: u.hostname, port }, onConnect);

    socket.on("error", (e) => finish(String(e.message || e)));
    socket.on("close", () => finish());

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!handshake) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString("latin1");
        const m = head.match(/^HTTP\/1\.[01] (\d{3})/);
        handshake = m ? Number(m[1]) : 0;
        buf = buf.slice(idx + 4);
        if (handshake !== 101) {
          finish(`handshake ${handshake}`);
          return;
        }
        if (onOpen) {
          try { socket.write(encodeClientFrame(JSON.stringify(onOpen.message))); } catch {}
        }
      }
      // 解析服务端帧（服务端→客户端不带掩码）
      for (;;) {
        const parsed = parseServerFrame(buf);
        if (!parsed) break;
        buf = parsed.rest;
        const f = parsed.frame;
        if (f.opcode === 8) {
          closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
          finish();
          return;
        }
        if (f.opcode === 1) frames.push(safeJson(f.payload.toString("utf8")));
        // 9=ping 由服务端 30s 心跳触发，探测时长内不会遇到；10=pong 忽略
      }
    });

    function encodeClientFrame(text) {
      const payload = Buffer.from(text, "utf8");
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      let head;
      if (payload.length < 126) {
        head = Buffer.from([0x81, 0x80 | payload.length]);
      } else if (payload.length < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x81;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(payload.length, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x81;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      return Buffer.concat([head, mask, masked]);
    }

    function parseServerFrame(b) {
      if (b.length < 2) return null;
      const opcode = b[0] & 0x0f;
      const len7 = b[1] & 0x7f;
      let offset = 2;
      let len = len7;
      if (len7 === 126) {
        if (b.length < 4) return null;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len7 === 127) {
        if (b.length < 10) return null;
        len = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      if (b.length < offset + len) return null;
      return { frame: { opcode, payload: b.slice(offset, offset + len) }, rest: b.slice(offset + len) };
    }
  });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { type: "<non-json>", raw: s.slice(0, 120) }; }
}

// ---------- 探测 A：注册端点限流 ----------

async function probeRegisterRateLimit(base, opts) {
  const statuses = [];
  let limitHeader = null;
  let created = false;
  let serverError = false;
  for (let i = 0; i < opts.attempts; i++) {
    // body 恒为 {}：停在参数校验（username 缺失 ⇒ 400），永远建不了号。
    // 走 node:https 且关证书校验：证书链可信度是探测 B 的职责，
    // 不能因为自签证书把这里的网络失败误判成「闸门失效」。
    const res = await postJson(`${base.origin}/api/auth/register`, "{}", { timeoutMs: opts.timeoutMs });
    const status = res.status;
    if (res.headers["x-ratelimit-limit"]) limitHeader = res.headers["x-ratelimit-limit"];
    statuses.push(status);
    if (status === 201) created = true;
    if (status >= 500) serverError = true;
  }
  const first429 = statuses.indexOf(429);
  const detail = `状态码序列 ${JSON.stringify(statuses)}` +
    (limitHeader ? `，X-RateLimit-Limit=${limitHeader}` : "");
  if (created) {
    report("FAIL", "A", `连打 ${opts.attempts} 次竟然建了号（201）——注册闸门形同虚设`, detail);
  } else if (serverError) {
    report("FAIL", "A", "出现 5xx —— 服务端在处理注册探测时出错", detail);
  } else if (first429 >= 0) {
    const unexpected = statuses.filter((s) => s !== 400 && s !== 403 && s !== 429 && s !== 0);
    if (unexpected.length) {
      report("WARN", "A", `429 已出现（第 ${first429 + 1} 次），但混入了异常状态码`, `${detail}，异常=${JSON.stringify(unexpected)}`);
    } else {
      report("PASS", "A", `第 ${first429 + 1} 次起被限流（429），共 ${opts.attempts} 次探测未建号`, detail);
    }
  } else {
    report("FAIL", "A", `${opts.attempts} 次连打全部放行、无一次 429 —— 限流闸门未生效（REGISTER_RATE_LIMIT=0 或阈值过高）`, detail);
  }
}

// ---------- 探测 B：明文 / 加密 ----------

async function probeTransport(base, opts) {
  // B1: https 必须通（显式用 https:// + base 的 host:port，不随 base URL 的协议而变）。
  // 先严格验证书链；若因证书不可信失败，再关校验重试——
  // 用来区分「根本没开 TLS」与「开了 TLS 但证书不被本机信任」。
  const httpsUrl = `https://${base.hostname}:${base.port}/healthz`;
  const strict = await getWithBody(httpsUrl, { timeoutMs: opts.timeoutMs, insecure: false });
  if (strict.status === 200) {
    report("PASS", "B", "https:// 可达且证书链受信任");
  } else {
    const loose = await getWithBody(httpsUrl, { timeoutMs: opts.timeoutMs, insecure: true });
    if (loose.status === 200) {
      report("WARN", "B", "https:// 可通达但证书链不被本机信任（自签证书或缺中间件）", `严格模式错误: ${strict.err}`);
    } else {
      report("FAIL", "B", "https:// 不可达 —— 端口上没有 TLS（或服务未起）", `${strict.err} / ${loose.err}`);
    }
  }

  // B2: 同端口明文必须失败/重定向（证明该端口上跑的确实是 TLS，不是明文）
  const plainSamePort = await getWithBody(`http://${base.hostname}:${base.port}/healthz`, { timeoutMs: opts.timeoutMs });
  if (plainSamePort.status === 0) {
    report("PASS", "B", `同端口明文 http://…:${base.port} 连不上（端口只讲 TLS）`, plainSamePort.err);
  } else if (plainSamePort.status >= 300 && plainSamePort.status < 400) {
    report("PASS", "B", `同端口明文被重定向（${plainSamePort.status}）`);
  } else if (plainSamePort.status === 200) {
    report("FAIL", "B", `同端口明文返回 200 —— http://:${base.port} 可直接明文访问`);
  } else {
    report("WARN", "B", `同端口明文返回 ${plainSamePort.status}`);
  }

  // B3: 80 端口（若与 base 端口不同）也不能明文放行
  if (base.port !== "80") {
    const port80 = await getWithBody(`http://${base.hostname}/healthz`, { timeoutMs: Math.min(opts.timeoutMs, 4000) });
    if (port80.status === 0) {
      report("PASS", "B", "80 端口明文不可达（符合收口预期）");
    } else if (port80.status >= 300 && port80.status < 400) {
      report("PASS", "B", `80 端口重定向到 https（${port80.status}）`);
    } else if (port80.status === 200) {
      report("WARN", "B", "80 端口明文返回 200 —— 存在明文入口（若前面有反代跳转属预期，否则应收口）");
    } else {
      report("PASS", "B", `80 端口返回 ${port80.status}（非 200，视为不可用）`);
    }
  }
}

// ---------- 探测 C：WS 无令牌必须被拒 ----------

async function probeWsAuth(base, opts) {
  const wsBase = `${base.wsOrigin}/`;

  // C1: 握手后直接发协议帧（REGISTER），鉴权前必须被拒
  const r1 = await wsProbe(wsBase, {
    timeoutMs: opts.timeoutMs,
    onOpen: { message: { type: "REGISTER", deviceId: "probe" } },
  });
  const rejectedByFrame =
    r1.frames.some((f) => f.type === "ERROR" && (f.code === "AUTH_REQUIRED" || f.code === "UNAUTHORIZED")) ||
    r1.closeCode === 4401;
  if (r1.handshake === 401) {
    report("PASS", "C", "无令牌 WS 握手即被 401 拒绝（query 模式的握手鉴权）");
  } else if (rejectedByFrame) {
    report("PASS", "C", "无令牌发帧被拒（ERROR/AUTH_REQUIRED 或 close 4401）",
      `close=${r1.closeCode} frames=${JSON.stringify(r1.frames.map((f) => f.type || f.code))}`);
  } else if (r1.handshake === 101) {
    report("FAIL", "C", "无令牌的 WS 连上且发帧未被拒 —— 鉴权前竟放行协议帧",
      `close=${r1.closeCode} frames=${JSON.stringify(r1.frames).slice(0, 160)}`);
  } else {
    report("FAIL", "C", "WS 连接异常（既非 101 也非 401）", `handshake=${r1.handshake} err=${r1.error}`);
  }

  // C2: 首帧带一个无效令牌，同样必须 4401
  const r2 = await wsProbe(wsBase, {
    timeoutMs: opts.timeoutMs,
    onOpen: { message: { type: "AUTH", token: "probe-invalid-token" } },
  });
  if (r2.closeCode === 4401 || r2.frames.some((f) => f.type === "ERROR" && f.code === "UNAUTHORIZED")) {
    report("PASS", "C", "无效令牌首帧被 4401 拒绝");
  } else if (r2.handshake === 401) {
    report("PASS", "C", "无效令牌在握手层即被 401 拒绝");
  } else if (r2.frames.some((f) => f.type === "AUTH_OK")) {
    report("FAIL", "C", "无效令牌竟然通过了鉴权（AUTH_OK）");
  } else {
    report("FAIL", "C", "无效令牌未被明确拒绝", `handshake=${r2.handshake} close=${r2.closeCode} err=${r2.error}`);
  }
}

/** hostname 是 IP 字面量时不设 servername（RFC 6066 禁止 IP SNI，Node 会告警）。 */
function tlsConnectOptions(hostname, port, rejectUnauthorized) {
  const isIp = net.isIP(hostname) !== 0;
  return isIp
    ? { host: hostname, port, rejectUnauthorized }
    : { host: hostname, port, servername: hostname, rejectUnauthorized };
}

/** 打一次 GET 并返回 {status, body, err}；insecure=true 时关闭证书校验。 */
function getWithBody(url, { timeoutMs, insecure = false }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? import("node:https") : import("node:http");
    mod.then((m) => {
      const opts = u.protocol === "https:"
        ? { ...tlsConnectOptions(u.hostname, Number(u.port) || 443, !insecure), path: u.pathname, method: "GET" }
        : { host: u.hostname, port: Number(u.port) || 80, path: u.pathname, method: "GET" };
      const req = m.request(
        url,
        { ...opts, timeout: timeoutMs },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body, err: "" }));
        }
      );
      req.on("error", (err) => resolve({ status: 0, body: "", err: String(err.message || err) }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: 0, body: "", err: "timeout" });
      });
      req.end();
    });
  });
}

/** POST JSON 并返回 {status, headers, err}；证书校验默认关闭——探测 A 只关心闸门行为，
 *  证书链可信度是探测 B 的职责，不能因为自签证书把 A 误判成网络失败。 */
function postJson(url, bodyText, { timeoutMs, contentType = "application/json" } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? import("node:https") : import("node:http");
    mod.then((m) => {
      const opts = u.protocol === "https:"
        ? { ...tlsConnectOptions(u.hostname, Number(u.port) || 443, false), path: u.pathname, method: "POST" }
        : { host: u.hostname, port: Number(u.port) || 80, path: u.pathname, method: "POST" };
      const req = m.request(
        url,
        {
          ...opts,
          timeout: timeoutMs,
          headers: { "content-type": contentType, "content-length": Buffer.byteLength(bodyText) },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers, err: "" });
        }
      );
      req.on("error", (err) => resolve({ status: 0, headers: {}, err: String(err.message || err) }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ status: 0, headers: {}, err: "timeout" });
      });
      req.end(bodyText);
    });
  });
}

async function probeHealthz(base, opts) {
  // D 关心的是「TLS 下健康检查是否正常」，证书链可信度由探测 B 负责，
  // 所以这里关掉证书校验，避免自签证书把 D 误判成 FAIL。
  const r = await getWithBody(`${base.origin}/healthz`, { timeoutMs: opts.timeoutMs, insecure: true });
  let ok = false;
  try { ok = JSON.parse(r.body).ok === true; } catch {}
  if (r.status === 200 && ok) {
    report("PASS", "D", "/healthz 返回 200 且 ok:true", r.body.slice(0, 120));
  } else {
    report("FAIL", "D", `/healthz 异常（status=${r.status}）`, (r.body || r.err).slice(0, 120));
  }
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = parseBase(opts.baseUrl);
  process.stdout.write(`security-probe: base=${base.origin} attempts=${opts.attempts} timeout=${opts.timeoutMs}ms\n\n`);

  await probeRegisterRateLimit(base, opts);
  await probeTransport(base, opts);
  await probeWsAuth(base, opts);
  await probeHealthz(base, opts);

  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  const passes = results.filter((r) => r.level === "PASS").length;
  process.stdout.write(`\n结果: ${passes} PASS / ${warns} WARN / ${fails} FAIL —— `);
  if (fails > 0) {
    process.stdout.write("存在 FAIL，退出码 1\n");
    process.exit(1);
  }
  process.stdout.write(warns > 0 ? "有 WARN 需人工复核，退出码 0\n" : "全部通过，退出码 0\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`探测脚本异常: ${e && e.stack ? e.stack : String(e)}\n`);
  process.exit(1);
});
