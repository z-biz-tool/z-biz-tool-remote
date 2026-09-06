// End-to-end smoke test for z-biz-tool-remote-server.
//
// Boots a server on a random free port, then runs a 2-client scenario
// (host + controller) through the full protocol:
//   REGISTER -> GET_ONLINE_DEVICES -> CREATE_SESSION -> JOIN_SESSION
//   -> CONTROL_REQUEST -> CONTROL_ACCEPT -> SCREEN_FRAME -> INPUT_EVENT
//   -> disconnect -> SESSION_CLOSED.
//
// Run:   node tests/e2e.test.js
// or:    npm test
//
// Exit code: 0 on success, 1 on any failed assertion / timeout.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";

const TEST_TIMEOUT_MS = 15000;

function logLine(s) {
  process.stdout.write(s + "\n");
}

function shortJson(o) {
  const s = JSON.stringify(o);
  return s.length > 140 ? s.slice(0, 140) + "..." : s;
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
          reject(new Error(`[${name}] timeout waiting for predicate`));
        }, timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
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

function startServer(env) {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  return child;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function run() {
  const port = 18080 + Math.floor(Math.random() * 100);
  const authToken = "test-token-" + Math.random().toString(36).slice(2, 14);
  const url = `ws://127.0.0.1:${port}/?token=${authToken}`;

  logLine(`[test] starting server on :${port}`);
  const child = startServer({
    PORT: String(port),
    AUTH_TOKEN: authToken,
    LOG_LEVEL: "warn", // keep test output clean
  });

  let serverError = null;
  child.on("exit", (code, signal) => {
    if (code !== 0 && code !== null && !shuttingDown) {
      serverError = new Error(`server exited early code=${code} signal=${signal}`);
    }
  });

  let shuttingDown = false;
  const overallTimer = setTimeout(() => {
    serverError = new Error("overall test timeout");
  }, TEST_TIMEOUT_MS);

  try {
    await waitForServer(port);
    logLine("[test] server healthy");

    // 1. Healthz JSON shape
    {
      const body = await new Promise((resolve, reject) => {
        httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET" }, (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({ status: res.statusCode, body: buf }));
        }).on("error", reject).end();
      });
      assert(body.status === 200, "healthz status 200");
      const parsed = JSON.parse(body.body);
      assert(parsed.ok === true, "healthz.ok === true");
      assert(typeof parsed.uptimeSec === "number", "healthz.uptimeSec");
      assert(parsed.online === 0, "healthz.online === 0");
      logLine(`[test] healthz OK (${JSON.stringify(parsed)})`);
    }

    // 2. Auth gate: bad token must be rejected
    {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong`);
      const result = await new Promise((resolve) => {
        bad.on("open", () => resolve({ opened: true }));
        bad.on("error", (e) => resolve({ opened: false, msg: e.message }));
        bad.on("unexpected-response", (req, res) => resolve({ opened: false, status: res.statusCode }));
        setTimeout(() => resolve({ opened: "timeout" }), 2000);
      });
      logLine(`[test] bad-token connect: ${JSON.stringify(result)}`);
      assert(!result.opened, "bad token must not open");
    }

    // 3. Two-client happy path
    const host = makeClient("host", url);
    const ctrl = makeClient("ctrl", url);
    await Promise.all([host.ready, ctrl.ready]);
    logLine("[test] both connected");

    // 3.1 register
    host.send({ type: "REGISTER", deviceId: "host-A" });
    const hostReg = await host.waitFor((m) => m.type === "REGISTER_SUCCESS");
    logLine(`[host] <= ${shortJson(hostReg)}`);
    assert(hostReg.deviceId === "host-A", "host deviceId");
    assert(typeof hostReg.encryptionKey === "string", "host encryptionKey");

    ctrl.send({ type: "REGISTER", deviceId: "ctrl-B" });
    const ctrlReg = await ctrl.waitFor((m) => m.type === "REGISTER_SUCCESS");
    logLine(`[ctrl] <= ${shortJson(ctrlReg)}`);
    assert(ctrlReg.deviceId === "ctrl-B", "ctrl deviceId");

    const hostId = hostReg.deviceId;
    const ctrlId = ctrlReg.deviceId;

    // 3.2 online devices
    ctrl.send({ type: "GET_ONLINE_DEVICES" });
    const dev = await ctrl.waitFor((m) => m.type === "ONLINE_DEVICES");
    logLine(`[ctrl] <= ${shortJson(dev)}`);
    assert(dev.devices.find((d) => d.id === hostId), "host in online list");
    assert(dev.devices.find((d) => d.id === ctrlId), "ctrl in online list");

    // 3.3 create session
    host.send({ type: "CREATE_SESSION" });
    const created = await host.waitFor((m) => m.type === "SESSION_CREATED");
    logLine(`[host] <= ${shortJson(created)}`);
    const { sessionId, sessionToken } = created;
    assert(typeof sessionId === "string" && sessionId.length >= 8, "sessionId");
    assert(typeof sessionToken === "string" && sessionToken.length >= 12, "sessionToken >=12 chars");

    // 3.4 ctrl joins
    ctrl.send({ type: "JOIN_SESSION", sessionId, sessionToken });
    const join = await ctrl.waitFor((m) => m.type === "JOIN_SUCCESS");
    logLine(`[ctrl] <= ${shortJson(join)}`);
    assert(join.hostId === hostId, "JOIN_SUCCESS hostId");

    // host should be told
    const clientJoined = await host.waitFor((m) => m.type === "CLIENT_JOINED" && m.clientId === ctrlId);
    logLine(`[host] <= ${shortJson(clientJoined)}`);

    // 3.5 control negotiation
    ctrl.send({ type: "CONTROL_REQUEST", targetId: hostId, sessionId });
    const req = await host.waitFor((m) => m.type === "CONTROL_REQUEST" && m.fromId === ctrlId);
    logLine(`[host] <= ${shortJson(req)}`);
    assert(req.sessionId === sessionId, "control req sessionId");

    host.send({ type: "CONTROL_ACCEPT", targetId: ctrlId, sessionId });
    const accepted = await ctrl.waitFor((m) => m.type === "CONTROL_ACCEPTED");
    logLine(`[ctrl] <= ${shortJson(accepted)}`);
    assert(accepted.targetId === hostId, "CONTROL_ACCEPTED targetId");

    // 3.6 screen frame relay
    const frame = "BASE64FRAME==" + Date.now();
    host.send({ type: "SCREEN_FRAME", sessionId, frame, timestamp: Date.now(), quality: 80 });
    const fwd = await ctrl.waitFor((m) => m.type === "SCREEN_FRAME" && m.fromId === hostId);
    logLine(`[ctrl] <= ${shortJson(fwd)}`);
    assert(fwd.frame === frame, "frame payload");

    // 3.7 input event relay
    ctrl.send({
      type: "INPUT_EVENT",
      targetId: hostId,
      sessionId,
      event: { type: "mouse-move", x: 100, y: 200 },
    });
    const inEvt = await host.waitFor((m) => m.type === "INPUT_EVENT" && m.event?.x === 100);
    logLine(`[host] <= ${shortJson(inEvt)}`);
    assert(inEvt.sessionId === sessionId, "input event sessionId");

    // 3.8 PING/PONG
    host.send({ type: "PING" });
    const pong = await host.waitFor((m) => m.type === "PONG");
    logLine(`[host] <= ${shortJson(pong)}`);

    // 3.9 host drops -> SESSION_CLOSED to ctrl
    host.close();
    const closed = await ctrl.waitFor((m) => m.type === "SESSION_CLOSED", 5000);
    logLine(`[ctrl] <= ${shortJson(closed)}`);
    assert(typeof closed.message === "string", "SESSION_CLOSED message");

    ctrl.close();

    // 3.10 healthz after: online should drop to 0
    await delay(100);
    const after = await new Promise((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET" }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve(JSON.parse(buf)));
      }).on("error", reject).end();
    });
    logLine(`[test] post-test healthz: ${JSON.stringify(after)}`);
    assert(after.online === 0, "online === 0 after disconnect");
    assert(after.totalConnections >= 2, "totalConnections >= 2");

    logLine("\nALL E2E CHECKS PASSED ✓");
  } catch (e) {
    serverError = serverError || e;
  } finally {
    clearTimeout(overallTimer);
    shuttingDown = true;
    try {
      child.kill("SIGTERM");
    } catch {}
    // wait for exit
    if (child.exitCode === null) {
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 6000);
      try {
        await once(child, "exit");
      } catch {}
      clearTimeout(killTimer);
    }
  }

  if (serverError) {
    logLine(`FAIL: ${serverError.stack || serverError.message}`);
    process.exit(1);
  }
}

run();
