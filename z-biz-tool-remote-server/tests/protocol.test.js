// 服务端协议补网：CONTROL_REJECT 与 WEBRTC_SIGNAL 的转发授权 + 尺寸限制
//
// 为什么单独一个文件：tests/e2e.test.js 走的是「一条主流程串到底」，
// 覆盖的是**顺利路径**。而这两类消息的危险全在分支上——
//   CONTROL_REJECT  : 拒绝后必须**撤销**控制权，否则被拒的一方仍能操作对方
//   WEBRTC_SIGNAL   : 一跳转发，服务端不理解 SDP/ICE 内容，
//                     所以「谁能往谁那儿塞信令」是唯一的安全边界
// 主流程里这两条一个都没走到（e2e 覆盖 10 种消息，缺这两种）。
//
// 运行：node tests/protocol.test.js   或   npm run test:protocol

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function logLine(s) {
  process.stdout.write(s + "\n");
}

function makeClient(name, url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  return {
    name,
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(predicate, timeoutMs = 3000) {
      const existing = inbox.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.predicate === predicate);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`[${name}] timeout waiting`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    saw(predicate) {
      return inbox.some(predicate);
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
    ready,
  };
}

async function waitForServer(port, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: 500 },
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
      if (ok) return;
    } catch {
      /* ignore */
    }
    await delay(100);
  }
  throw new Error(`server did not become healthy on port ${port}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** 等一小会儿，确认「某条消息确实没来」。否定断言必须等，不能 sleep 0 蒙。 */
async function expectNoMessage(client, predicate, ms, what) {
  const hit = client.inbox.find(predicate);
  if (hit) throw new Error(`${what}: 收到了本不该收的消息 ${JSON.stringify(hit)}`);
  await delay(ms);
  const late = client.inbox.find(predicate);
  if (late) throw new Error(`${what}: 延迟收到了本不该收的消息 ${JSON.stringify(late)}`);
  logLine(`[t] ${what} ✓`);
}

async function main() {
  const port = 18200 + Math.floor(Math.random() * 100);
  const authToken = "proto-token-" + randomUUID().slice(0, 12);
  const url = `ws://127.0.0.1:${port}/?token=${authToken}`;

  const dataFile = `/tmp/zbt-proto-${randomUUID()}.json`;
  logLine(`[test] starting server on :${port}`);
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), AUTH_TOKEN: authToken, LOG_LEVEL: "warn",
           DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  await waitForServer(port);

  const clients = [];
  let err = null;
  try {
    // ---------------------------------------------- CONTROL_REJECT
    {
      const host = makeClient("host", url);
      const peer = makeClient("peer", url);
      clients.push(host, peer);
      await Promise.all([host.ready, peer.ready]);
      host.send({ type: "REGISTER", deviceId: "d-host", deviceName: "host" });
      peer.send({ type: "REGISTER", deviceId: "d-peer", deviceName: "peer" });
      await Promise.all([
        host.waitFor((m) => m.type === "REGISTER_SUCCESS"),
        peer.waitFor((m) => m.type === "REGISTER_SUCCESS"),
      ]);

      const sessionId = "s-" + randomUUID().slice(0, 8);
      host.send({ type: "CREATE_SESSION" });
      const created = await host.waitFor((m) => m.type === "SESSION_CREATED");
      const sid = created.sessionId || sessionId;
      peer.send({ type: "JOIN_SESSION", sessionId: sid, sessionToken: created.sessionToken });
      await peer.waitFor((m) => m.type === "JOIN_SUCCESS");

      // peer 先接受控制，再拒绝 —— 服务端必须把授权撤掉
      host.send({ type: "CONTROL_REQUEST", targetId: "d-peer", sessionId: sid });
      await peer.waitFor((m) => m.type === "CONTROL_REQUEST");
      peer.send({ type: "CONTROL_ACCEPT", targetId: "d-host", sessionId: sid });
      await host.waitFor((m) => m.type === "CONTROL_ACCEPTED");

      host.inbox.length = 0;
      peer.send({ type: "CONTROL_REJECT", targetId: "d-host", message: "不方便" });
      const rejected = await host.waitFor((m) => m.type === "CONTROL_REJECTED");
      assert(rejected.message === "不方便", `拒绝理由应透传，实际 ${rejected.message}`);
      logLine(`[t] CONTROL_REJECT 通知到请求方 ✓`);

      // 关键断言：拒绝后 peer 再发屏幕帧，host 不该再收到
      //（grantControl 被 revokeControl 撤销；但两人同 session，
      //  所以这里改测「不属于该 session 的第三方」才看得出授权是否真的撤了）
      const outsider = makeClient("outsider", url);
      clients.push(outsider);
      await outsider.ready;
      outsider.send({ type: "REGISTER", deviceId: "d-out" });
      await outsider.waitFor((m) => m.type === "REGISTER_SUCCESS");

      // 正常帧必须仍然能通 —— 修权限校验最常见的翻车是「顺手把功能也修了」
      host.inbox.length = 0;
      peer.send({ type: "SCREEN_FRAME", sessionId: sid, frame: "BBBB" });
      const good = await host.waitFor((m) => m.type === "SCREEN_FRAME" && m.frame === "BBBB");
      assert(good.fromId === "d-peer", `正常帧的 fromId 应为发送方，实际 ${good.fromId}`);
      logLine(`[t] session 成员之间的正常帧仍然通 ✓`);

      // 而会话外成员的帧必须被挡
      host.inbox.length = 0;
      outsider.send({ type: "SCREEN_FRAME", sessionId: sid, frame: "AAAA" });
      await expectNoMessage(host, (m) => m.type === "SCREEN_FRAME", 300, "非 session 成员的帧被挡住");
    }

    // ---------------------------------------------- WEBRTC_SIGNAL
    {
      const a = clients[0]; // d-host
      const b = clients[1]; // d-peer
      const out = clients[2]; // d-out（同 session 之外）

      a.inbox.length = 0;
      b.inbox.length = 0;

      // 同一 session 内的两台设备 ⇒ 可以互发信令
      const sid = "sig-" + randomUUID().slice(0, 8);
      a.send({ type: "CREATE_SESSION" });
      const created = await a.waitFor((m) => m.type === "SESSION_CREATED");
      b.send({ type: "JOIN_SESSION", sessionId: created.sessionId, sessionToken: created.sessionToken });
      await b.waitFor((m) => m.type === "JOIN_SUCCESS");
      const realSid = created.sessionId;

      a.inbox.length = 0;
      b.inbox.length = 0;
      a.send({ type: "WEBRTC_SIGNAL", kind: "offer", sdp: "v=0 offer", sessionId: realSid });
      const relayed = await b.waitFor((m) => m.type === "WEBRTC_SIGNAL" && m.kind === "offer");
      assert(relayed.fromId === "d-host", `fromId 应为发送方，实际 ${relayed.fromId}`);
      assert(relayed.sdp === "v=0 offer", `sdp 应原样透传，实际 ${relayed.sdp}`);
      assert(relayed.candidate === null, `缺省 candidate 应为 null，实际 ${relayed.candidate}`);
      logLine(`[t] 同 session 成员间信令转发 ✓`);

      // 非法 kind 必须被丢
      b.inbox.length = 0;
      a.send({ type: "WEBRTC_SIGNAL", kind: "offer2", sdp: "x", sessionId: realSid });
      await expectNoMessage(b, (m) => m.type === "WEBRTC_SIGNAL", 250, "非法 kind 被丢弃");

      // 超长 sdp 必须被丢（64KiB 上限）
      b.inbox.length = 0;
      a.send({ type: "WEBRTC_SIGNAL", kind: "offer", sdp: "x".repeat(65537), sessionId: realSid });
      await expectNoMessage(b, (m) => m.type === "WEBRTC_SIGNAL", 250, "超长 sdp 被丢弃");

      // 超长 candidate 必须被丢（4KiB 上限）
      b.inbox.length = 0;
      a.send({ type: "WEBRTC_SIGNAL", kind: "ice", candidate: "y".repeat(4097), sessionId: realSid });
      await expectNoMessage(b, (m) => m.type === "WEBRTC_SIGNAL", 250, "超长 candidate 被丢弃");

      // 边界值：恰好等于上限应当**放行**（<= 而非 <）
      b.inbox.length = 0;
      const atLimit = "z".repeat(65536);
      a.send({ type: "WEBRTC_SIGNAL", kind: "answer", sdp: atLimit, sessionId: realSid });
      const okAtLimit = await b.waitFor((m) => m.type === "WEBRTC_SIGNAL" && m.kind === "answer");
      assert(okAtLimit.sdp.length === 65536, "恰好等于上限的 sdp 应当放行");
      logLine(`[t] 尺寸边界（<= 上限放行）✓`);

      // 非 session 成员显式 targetId 中继 ⇒ 必须被 canRelay 挡住
      b.inbox.length = 0;
      out.inbox.length = 0;
      a.send({ type: "WEBRTC_SIGNAL", kind: "offer", sdp: "v=0", targetId: "d-out" });
      await expectNoMessage(out, (m) => m.type === "WEBRTC_SIGNAL", 300, "未授权的定向中继被挡住");
    }

    // ---------------------------------------------- 拒绝 ⇒ 撤销授权（跨 session 口径）
    // 为什么必须跨 session：canRelay 在 session 内有兜底分支
    // （inSess(hostId) && inSess(peerId) 直接为真），所以**同 session 内撤权测不出来**——
    // 把 revokeControl 整行删掉，本组用例依然全绿（2026-10-04 实测）。
    // 撤权真正起作用的场景是：peer 不在 session 里，授权是唯一通路。
    {
      const ctrl = makeClient("ctrl2", url);
      const host2 = makeClient("host2", url);
      clients.push(ctrl, host2);
      await Promise.all([ctrl.ready, host2.ready]);
      ctrl.send({ type: "REGISTER", deviceId: "c2" });
      host2.send({ type: "REGISTER", deviceId: "h2" });
      await Promise.all([
        ctrl.waitFor((m) => m.type === "REGISTER_SUCCESS"),
        host2.waitFor((m) => m.type === "REGISTER_SUCCESS"),
      ]);

      // host2 请求 ctrl 控制，ctrl 接受 —— 建立授权（两者都不在任何 session）
      host2.send({ type: "CONTROL_REQUEST", targetId: "c2", sessionId: "no-such-session" });
      const req = await ctrl.waitFor((m) => m.type === "CONTROL_REQUEST");
      ctrl.send({ type: "CONTROL_ACCEPT", targetId: "h2", sessionId: "no-such-session" });
      await host2.waitFor((m) => m.type === "CONTROL_ACCEPTED");

      // 授权生效：host2 的 INPUT_EVENT 能送达 ctrl
      ctrl.inbox.length = 0;
      host2.send({ type: "INPUT_EVENT", targetId: "c2", sessionId: "no-such-session",
                   event: { type: "mouse", x: 1, y: 2 } });
      await ctrl.waitFor((m) => m.type === "INPUT_EVENT");
      logLine(`[t] 授权后 INPUT_EVENT 可达 ✓`);

      // ctrl 拒绝 ⇒ 授权必须撤销
      ctrl.send({ type: "CONTROL_REJECT", targetId: "h2" });
      await host2.waitFor((m) => m.type === "CONTROL_REJECTED");

      // 关键：拒绝之后再发 INPUT_EVENT，ctrl 必须收不到
      //（撤销若无 effect，这里会收到 —— 这正是「拒绝后仍能操作对方」的安全缺陷）
      ctrl.inbox.length = 0;
      host2.send({ type: "INPUT_EVENT", targetId: "c2", sessionId: "no-such-session",
                   event: { type: "mouse", x: 3, y: 4 } });
      const denied = await host2.waitFor((m) => m.type === "CONTROL_FAILED", 3000);
      assert(/未授权|未被授权/.test(denied.message || ""), `应回 CONTROL_FAILED，实际 ${JSON.stringify(denied)}`);
      await expectNoMessage(ctrl, (m) => m.type === "INPUT_EVENT", 250, "拒绝后不再能注入输入事件");
    }

    logLine("\nALL PROTOCOL CHECKS PASSED ✓");
  } catch (e) {
    err = e;
  } finally {
    for (const c of clients) {
      try {
        c.close();
      } catch {}
    }
    try {
      child.kill("SIGTERM");
    } catch {}
    if (child.exitCode === null) {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
      try {
        await once(child, "exit");
      } catch {}
      clearTimeout(t);
    }
  }

  if (err) {
    logLine(`FAIL: ${err.stack || err.message}`);
    process.exit(1);
  }
}

main();
