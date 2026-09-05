// 信令协议 smoke test：两个 mock 客户端连本地 server，跑完整流程
// node tests/e2e-protocol.mjs
import { WebSocket } from "ws";

const URL = process.env.SIG_URL || "ws://127.0.0.1:18080";

function makeClient(name) {
  const ws = new WebSocket(URL);
  const inbox = [];
  const waiters = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    const w = waiters.find((w) => w.predicate(msg));
    if (w) {
      const resolve = w.resolve;
      waiters.splice(waiters.indexOf(w), 1);
      resolve(msg);
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  return {
    name,
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    waitFor: (predicate, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const existing = inbox.find(predicate);
        if (existing) return resolve(existing);
        const t = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.predicate === predicate);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`[${name}] timeout waiting for message`));
        }, timeoutMs);
        waiters.push({ predicate, resolve: (m) => { clearTimeout(t); resolve(m); } });
      }),
    close: () => ws.close(),
    ready,
  };
}

function log(name, msg) {
  console.log(`  [${name}] <= ${JSON.stringify(msg).slice(0, 120)}${JSON.stringify(msg).length > 120 ? "..." : ""}`);
}

async function main() {
  console.log(`connecting to ${URL}`);
  const host = makeClient("host");
  const ctrl = makeClient("ctrl");
  await Promise.all([host.ready, ctrl.ready]);
  console.log("both connected");

  // 1. register
  host.send({ type: "REGISTER", deviceId: "host-A" });
  const hostReg = await host.waitFor((m) => m.type === "REGISTER_SUCCESS");
  log("host", hostReg);
  const hostId = hostReg.deviceId;

  ctrl.send({ type: "REGISTER", deviceId: "ctrl-B" });
  const ctrlReg = await ctrl.waitFor((m) => m.type === "REGISTER_SUCCESS");
  log("ctrl", ctrlReg);
  const ctrlId = ctrlReg.deviceId;

  // 2. online devices
  ctrl.send({ type: "GET_ONLINE_DEVICES" });
  const dev = await ctrl.waitFor((m) => m.type === "ONLINE_DEVICES");
  log("ctrl", dev);
  if (!dev.devices.find((d) => d.id === hostId)) {
    throw new Error(`expected host ${hostId} in online list`);
  }

  // 3. host creates session
  host.send({ type: "CREATE_SESSION" });
  const created = await host.waitFor((m) => m.type === "SESSION_CREATED");
  log("host", created);
  const { sessionId, sessionToken } = created;

  // 4. ctrl joins
  ctrl.send({ type: "JOIN_SESSION", sessionId, sessionToken });
  const join = await ctrl.waitFor((m) => m.type === "JOIN_SUCCESS");
  log("ctrl", join);
  if (join.hostId !== hostId) throw new Error("JOIN_SUCCESS hostId mismatch");

  // 5. ctrl requests control
  ctrl.send({ type: "CONTROL_REQUEST", targetId: hostId, sessionId });
  const req = await host.waitFor((m) => m.type === "CONTROL_REQUEST" && m.fromId === ctrlId);
  log("host", req);

  // 6. host accepts
  host.send({ type: "CONTROL_ACCEPT", targetId: ctrlId, sessionId });
  const accepted = await ctrl.waitFor((m) => m.type === "CONTROL_ACCEPTED");
  log("ctrl", accepted);
  if (accepted.targetId !== hostId) throw new Error("CONTROL_ACCEPTED targetId mismatch");

  // 7. host sends a screen frame
  const frame = "BASE64FRAME==" + Date.now();
  host.send({ type: "SCREEN_FRAME", sessionId, frame, timestamp: Date.now(), quality: 80 });
  const fwd = await ctrl.waitFor((m) => m.type === "SCREEN_FRAME" && m.fromId === hostId);
  log("ctrl", fwd);
  if (fwd.frame !== frame) throw new Error("frame mismatch");

  // 8. ctrl sends an input event
  ctrl.send({
    type: "INPUT_EVENT",
    targetId: hostId,
    sessionId,
    event: { type: "mouse-move", x: 100, y: 200 },
  });
  const inEvt = await host.waitFor((m) => m.type === "INPUT_EVENT" && m.event?.x === 100);
  log("host", inEvt);

  // 9. host closes session (simulated via disconnect)
  host.close();
  const closed = await ctrl.waitFor((m) => m.type === "SESSION_CLOSED", 5000);
  log("ctrl", closed);

  ctrl.close();

  console.log("\nALL PROTOCOL CHECKS PASSED ✓");
  console.log(`  hostId=${hostId}  ctrlId=${ctrlId}  sessionId=${sessionId}`);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
