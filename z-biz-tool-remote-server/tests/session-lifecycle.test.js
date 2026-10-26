// 会话生命周期 + 设备归属 + 单条消息上限（台账 S1-B18 / S-04 / S-05 / S1-B06）
//
//   node tests/session-lifecycle.test.js
//
// 为什么这三条要一起测：它们都只在**运行时的状态迁移**里才成立 ——
//   · LEAVE_SESSION：离开后对端必须收到 CLIENT_LEFT、离开者必须收到终态
//     SESSION_CLOSED，并且**授权必须一起作废**（否则人走了还能继续注入输入）；
//   · 设备归属：deviceId 是账号资产，离线设备的 id 不能被别的账号抢注；
//   · maxPayload：超限消息必须被传输层直接拒绝（1009），而不是先解析进内存。
//
// 硬口径：三条都必须「正向仍可用」——修这类问题最常见的翻车是顺手把功能改坏，
// 所以每组都带一条正常路径断言。

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const MAX_PAYLOAD = 64 * 1024;

function logLine(s) {
  process.stdout.write(s + "\n");
}

function makeClient(name, url, token) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
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
    ws.once("open", () => {
      if (token) ws.send(JSON.stringify({ type: "AUTH", token }));
      resolve();
    });
    ws.once("error", reject);
  });

  return {
    name,
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor(predicate, timeoutMs = 4000) {
      const existing = inbox.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`[${name}] timeout waiting`)),
          timeoutMs
        );
        waiters.push({ predicate, resolve, timer });
      });
    },
    close() {
      try {
        ws.close();
      } catch {}
    },
    ready,
  };
}

async function waitForServer(port, attempts = 40) {
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

function postJson(port, path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const port = 18400 + Math.floor(Math.random() * 100);
  const dir = mkdtempSync(join(tmpdir(), "zbt-life-"));
  const dataFile = join(dir, "data.json");
  const url = `ws://127.0.0.1:${port}/`;

  logLine(`[test] starting server on :${port} (maxPayload=${MAX_PAYLOAD})`);
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      AUTH_TOKEN: "",
      REGISTER_RATE_LIMIT: "0",
      WS_MAX_PAYLOAD: String(MAX_PAYLOAD),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[srv] ${b}`));

  const clients = [];
  let err = null;
  try {
    await waitForServer(port);

    const alice = await postJson(port, "/api/auth/register", {
      username: "lifealice",
      password: "secret123",
    });
    const bob = await postJson(port, "/api/auth/register", {
      username: "lifebob",
      password: "secret123",
    });
    const carol = await postJson(port, "/api/auth/register", {
      username: "lifecarol",
      password: "secret123",
    });
    assert(alice.status === 201 && bob.status === 201 && carol.status === 201, "注册三个账号");

    const host = makeClient("host", url, alice.body.accessToken);
    const ctrl = makeClient("ctrl", url, bob.body.accessToken);
    const watch = makeClient("watch", url, carol.body.accessToken);
    clients.push(host, ctrl, watch);
    await Promise.all([host.ready, ctrl.ready, watch.ready]);

    host.send({ type: "REGISTER", deviceId: "alice-mac" });
    ctrl.send({ type: "REGISTER", deviceId: "bob-laptop" });
    watch.send({ type: "REGISTER", deviceId: "carol-pc" });
    const regs = await Promise.all([
      host.waitFor((m) => m.type === "REGISTER_SUCCESS"),
      ctrl.waitFor((m) => m.type === "REGISTER_SUCCESS"),
      watch.waitFor((m) => m.type === "REGISTER_SUCCESS"),
    ]);
    for (const r of regs) assert(r.deviceIdReassigned === false, `首次注册不该改 id: ${r.deviceId}`);

    // ---------------- 1. LEAVE_SESSION（控制端离开）
    host.send({ type: "CREATE_SESSION" });
    const created = await host.waitFor((m) => m.type === "SESSION_CREATED");
    const sid = created.sessionId;
    ctrl.send({ type: "JOIN_SESSION", sessionId: sid, sessionToken: created.sessionToken });
    await ctrl.waitFor((m) => m.type === "JOIN_SUCCESS");
    watch.send({ type: "JOIN_SESSION", sessionId: sid, sessionToken: created.sessionToken });
    await watch.waitFor((m) => m.type === "JOIN_SUCCESS");

    // 建立控制授权，并确认输入可达（正向基线）
    ctrl.send({ type: "CONTROL_REQUEST", targetId: "alice-mac", sessionId: sid });
    await host.waitFor((m) => m.type === "CONTROL_REQUEST" && m.fromId === "bob-laptop");
    host.send({ type: "CONTROL_ACCEPT", targetId: "bob-laptop", sessionId: sid });
    await ctrl.waitFor((m) => m.type === "CONTROL_ACCEPTED");

    ctrl.send({
      type: "INPUT_EVENT",
      targetId: "alice-mac",
      sessionId: sid,
      event: { type: "mouse-move", x: 5, y: 6 },
    });
    await host.waitFor((m) => m.type === "INPUT_EVENT" && m.event?.x === 5);
    logLine("[t] 授权后输入可达 ✓");

    host.inbox.length = 0;
    watch.inbox.length = 0;
    ctrl.inbox.length = 0;
    ctrl.send({ type: "LEAVE_SESSION", sessionId: sid, reason: "用户点了断开" });

    const leftAck = await ctrl.waitFor((m) => m.type === "SESSION_CLOSED");
    assert(/离开/.test(leftAck.message || ""), `离开者应收到终态，实际 ${JSON.stringify(leftAck)}`);
    logLine("[t] 离开者收到 SESSION_CLOSED（不是静默）✓");

    const hostSaw = await host.waitFor((m) => m.type === "CLIENT_LEFT" && m.clientId === "bob-laptop");
    assert(hostSaw.sessionId === sid, "CLIENT_LEFT 带 sessionId");
    logLine("[t] 被控端收到 CLIENT_LEFT ✓");

    const watchSaw = await watch.waitFor((m) => m.type === "CLIENT_LEFT" && m.clientId === "bob-laptop");
    assert(watchSaw.reason === "用户点了断开", "离开理由应透传");
    logLine("[t] 同会话其它成员收到 CLIENT_LEFT（reason 透传）✓");

    // 关键：离开后授权必须一起作废
    host.inbox.length = 0;
    ctrl.send({
      type: "INPUT_EVENT",
      targetId: "alice-mac",
      sessionId: sid,
      event: { type: "mouse-move", x: 9, y: 9 },
    });
    const denied = await ctrl.waitFor((m) => m.type === "CONTROL_FAILED");
    assert(/授权/.test(denied.message || ""), `离开后注入应被拒，实际 ${JSON.stringify(denied)}`);
    await delay(200);
    assert(
      !host.inbox.some((m) => m.type === "INPUT_EVENT"),
      "离开后 host 不得再收到 INPUT_EVENT"
    );
    logLine("[t] 离开后授权作废（不能继续注入）✓");

    // 幂等：重复离开不炸（此时已不是成员，也必须是可落 UI 的终态，而不是静默）
    ctrl.inbox.length = 0;
    ctrl.send({ type: "LEAVE_SESSION", sessionId: sid });
    const again = await ctrl.waitFor((m) => m.type === "SESSION_CLOSED");
    assert(typeof again.message === "string" && again.message.length > 0, "重复离开也要有说明文案");
    logLine("[t] 重复 LEAVE_SESSION 幂等 ✓");

    // ---------------- 2. LEAVE_SESSION（主持人结束）
    host.inbox.length = 0;
    watch.inbox.length = 0;
    host.send({ type: "LEAVE_SESSION", sessionId: sid });
    await host.waitFor((m) => m.type === "SESSION_CLOSED");
    const watchClosed = await watch.waitFor((m) => m.type === "SESSION_CLOSED");
    assert(/主持人/.test(watchClosed.message || ""), `成员应被告知主持人结束，实际 ${watchClosed.message}`);
    logLine("[t] 主持人结束 ⇒ 全会话收到 SESSION_CLOSED ✓");

    // ---------------- 2.5 一键互控：客户端真实字段 fromId + 服务端建会话
    // 客户端 acceptControl() 发的是 fromId；服务端若只读 targetId 会拿到
    // undefined，既不回执也不授权（台账 S1-B16 / Z-08）。这里按客户端真实
    // 报文形状走一遍，并要求服务端真的建出一个可注入输入的会话。
    host.inbox.length = 0;
    ctrl.inbox.length = 0;
    ctrl.send({ type: "CONTROL_REQUEST", targetId: "alice-mac", sessionId: "", ephemeral: true });
    const req = await host.waitFor((m) => m.type === "CONTROL_REQUEST" && m.fromId === "bob-laptop");
    assert(req.ephemeral === true, "一键控制应标记 ephemeral");
    assert(req.sameUser === false, `跨账号请求 sameUser 必须由服务端算成 false，实际 ${req.sameUser}`);

    host.send({ type: "CONTROL_ACCEPT", fromId: "bob-laptop", sessionId: "", ephemeral: true });
    const hostCreated = await host.waitFor((m) => m.type === "SESSION_CREATED");
    const ctrlAccepted = await ctrl.waitFor((m) => m.type === "CONTROL_ACCEPTED");
    assert(
      ctrlAccepted.sessionId === hostCreated.sessionId && Boolean(ctrlAccepted.sessionId),
      `接受后必须产生真实会话，host=${hostCreated.sessionId} ctrl=${ctrlAccepted.sessionId}`
    );
    assert(ctrlAccepted.sessionToken === hostCreated.sessionToken, "双方拿到的 sessionToken 必须一致");
    assert(ctrlAccepted.role === "client", "请求方必须收到 role=client");
    logLine(`[t] 一键互控建会话 ${hostCreated.sessionId}（token/role 已下发）✓`);

    ctrl.send({
      type: "INPUT_EVENT",
      targetId: "alice-mac",
      sessionId: hostCreated.sessionId,
      event: { type: "mouse-move", x: 7, y: 8 },
    });
    await host.waitFor((m) => m.type === "INPUT_EVENT" && m.event?.x === 7);
    logLine("[t] 一键互控授权后输入可达 ✓");

    // 收尾：被控端结束会话
    host.inbox.length = 0;
    ctrl.inbox.length = 0;
    host.send({ type: "LEAVE_SESSION", sessionId: hostCreated.sessionId });
    await host.waitFor((m) => m.type === "SESSION_CLOSED");

    // ---------------- 3. 设备归属不可覆写
    host.close();
    await delay(300);
    const thief = makeClient("thief", url, bob.body.accessToken);
    clients.push(thief);
    await thief.ready;
    thief.send({ type: "REGISTER", deviceId: "alice-mac" });
    const stolen = await thief.waitFor((m) => m.type === "REGISTER_SUCCESS");
    assert(stolen.deviceId !== "alice-mac", `别人的设备 id 不得被采用，实际 ${stolen.deviceId}`);
    assert(stolen.deviceIdReassigned === true, "应标记 deviceIdReassigned");
    assert(stolen.deviceIdConflict === true, "应标记 deviceIdConflict");
    logLine(`[t] 抢注被改派为新 id：${stolen.deviceId} ✓`);

    thief.send({ type: "LIST_MY_DEVICES" });
    const thiefDevs = await thief.waitFor((m) => m.type === "MY_DEVICES");
    assert(
      !thiefDevs.devices.some((d) => d.id === "alice-mac"),
      "抢注者不得在「我的设备」里看到 alice-mac"
    );

    const aliceAgain = makeClient("alice-again", url, alice.body.accessToken);
    clients.push(aliceAgain);
    await aliceAgain.ready;
    aliceAgain.send({ type: "REGISTER", deviceId: "alice-mac" });
    const aliceReg = await aliceAgain.waitFor((m) => m.type === "REGISTER_SUCCESS");
    assert(aliceReg.deviceId === "alice-mac", "设备原主人仍可用原 id");
    aliceAgain.send({ type: "LIST_MY_DEVICES" });
    const aliceDevs = await aliceAgain.waitFor((m) => m.type === "MY_DEVICES");
    assert(
      aliceDevs.devices.some((d) => d.id === "alice-mac"),
      "alice-mac 必须仍在 alice 名下"
    );
    logLine("[t] 归属未被覆写（原主人仍持有）✓");

    // ---------------- 4. maxPayload
    {
      const big = new WebSocket(url);
      const code = await new Promise((resolve, reject) => {
        big.on("open", () => {
          big.send(JSON.stringify({ type: "AUTH", token: bob.body.accessToken }));
          // 超过 WS_MAX_PAYLOAD 的单条消息：传输层应直接 1009 断开
          big.send(JSON.stringify({ type: "SCREEN_FRAME", sessionId: "x", frame: "y".repeat(MAX_PAYLOAD * 2) }));
        });
        big.on("close", (c) => resolve(c));
        big.on("error", () => resolve(-1));
        setTimeout(() => reject(new Error("超限消息没有导致断开")), 4000);
      });
      assert(code === 1009 || code === -1, `超限消息应以 1009 断开，实际 ${code}`);
      logLine(`[t] 超限消息被传输层拒绝（close=${code}）✓`);
    }

    // 服务端仍存活（不是被一条大消息带崩）
    const alive = makeClient("alive", url, carol.body.accessToken);
    clients.push(alive);
    await alive.ready;
    alive.send({ type: "REGISTER", deviceId: "carol-pc" });
    const aliveReg = await alive.waitFor((m) => m.type === "REGISTER_SUCCESS");
    assert(Boolean(aliveReg.deviceId), "超限消息后服务端仍可正常注册");
    logLine("[t] 超限消息后服务端仍可用 ✓");

    logLine("\nALL SESSION LIFECYCLE CHECKS PASSED ✓");
  } catch (e) {
    err = e;
  } finally {
    for (const c of clients) c.close();
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
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  if (err) {
    logLine(`FAIL: ${err.stack || err.message}`);
    process.exit(1);
  }
}

main();
