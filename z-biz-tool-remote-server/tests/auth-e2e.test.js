// E2E for the new user-account layer.
//
//   1. register alice
//   2. register bob
//   3. alice logs in, opens WS with access token, claims device alice-mac
//   4. alice opens a 2nd device (alice-iphone) from same user
//   5. LIST_MY_DEVICES returns both
//   6. PATCH device name
//   7. connect-to-my-device: alice-iphone -> requestControl alice-mac
//   8. refresh token rotates
//   9. logout invalidates
//
// Run:   node tests/auth-e2e.test.js
// or:    npm run test:auth

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

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
function post(port, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await readBody(r) }));
}
function patch(port, path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await readBody(r) }));
}
function del(port, path, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "DELETE",
    headers,
  }).then(async (r) => ({ status: r.status, body: null }));
}

function openWs(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        const w = waiters[i];
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    ws,
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) => {
      const e = inbox.find(pred);
      if (e) return Promise.resolve(e);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          const i = waiters.findIndex((w) => w.pred === pred);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timeout`));
        }, ms);
        waiters.push({ pred, resolve, timer: t });
      });
    },
    close: () => ws.close(),
    ready,
  };
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

function assert(c, m) {
  if (!c) throw new Error(`assert: ${m}`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "zbt-auth-"));
  const dataFile = join(dir, "data.json");
  const port = 19099;
  console.log(`[t] dataFile = ${dataFile}`);

  // Start server (no legacy AUTH_TOKEN)
  const env = { ...process.env, DATA_FILE: dataFile, PORT: String(port) };
  delete env.AUTH_TOKEN;
  const child = spawn(process.execPath, ["server.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[srv] ${b}`));
  await waitForServer(port);
  console.log("[t] server healthy");

  try {
    // 1. Register alice
    const r1 = await post(port, "/api/auth/register", { username: "alice", password: "secret123" });
    assert(r1.status === 201, `alice register: ${r1.status}`);
    assert(r1.body.accessToken && r1.body.refreshToken, "alice tokens");
    const aliceAccess = r1.body.accessToken;
    const aliceRefresh = r1.body.refreshToken;
    const aliceUser = r1.body.user;
    console.log(`[t] alice registered, userId=${aliceUser.id}`);

    // 2. Register bob
    const r2 = await post(port, "/api/auth/register", { username: "bob", password: "pass4567" });
    assert(r2.status === 201, `bob register: ${r2.status}`);
    const bobAccess = r2.body.accessToken;
    const bobUser = r2.body.user;
    console.log(`[t] bob registered, userId=${bobUser.id}`);

    // 2b. Duplicate register -> 409
    const rDup = await post(port, "/api/auth/register", { username: "alice", password: "secret123" });
    assert(rDup.status === 409, `duplicate register: ${rDup.status}`);
    console.log("[t] duplicate register → 409 ✓");

    // 3. Alice opens WS, claims device
    const alice1 = openWs(port, aliceAccess);
    await alice1.ready;
    alice1.send({ type: "REGISTER", deviceId: "alice-mac", deviceName: "Alice 的 MacBook" });
    const reg1 = await alice1.waitFor((m) => m.type === "REGISTER_SUCCESS");
    assert(reg1.userId === aliceUser.id, "alice1 register userId");
    assert(reg1.username === "alice", "alice1 register username");
    console.log(`[t] alice1 REGISTER_SUCCESS (${reg1.deviceId})`);

    // 5. Alice opens a 2nd device
    const alice2 = openWs(port, aliceAccess);
    await alice2.ready;
    alice2.send({ type: "REGISTER", deviceId: "alice-iphone", deviceName: "Alice 的 iPhone" });
    const reg2 = await alice2.waitFor((m) => m.type === "REGISTER_SUCCESS");
    assert(reg2.userId === aliceUser.id, "alice2 userId");
    console.log(`[t] alice2 REGISTER_SUCCESS (${reg2.deviceId})`);

    // 5b. LIST_MY_DEVICES
    alice1.send({ type: "LIST_MY_DEVICES" });
    const myDevs = await alice1.waitFor((m) => m.type === "MY_DEVICES");
    const ids = myDevs.devices.map((d) => d.id).sort();
    assert(JSON.stringify(ids) === JSON.stringify(["alice-iphone", "alice-mac"]), `my devices: ${ids}`);
    console.log(`[t] LIST_MY_DEVICES returned ${ids.length} devices ✓`);

    // 5c. Bob's LIST_MY_DEVICES returns only bob's own device (cross-user isolation)
    const bobWs = openWs(port, bobAccess);
    await bobWs.ready;
    bobWs.send({ type: "REGISTER", deviceId: "bob-laptop" });
    await bobWs.waitFor((m) => m.type === "REGISTER_SUCCESS");
    bobWs.send({ type: "LIST_MY_DEVICES" });
    const bobDevs = await bobWs.waitFor((m) => m.type === "MY_DEVICES");
    assert(bobDevs.devices.length === 1, `bob devices: ${bobDevs.devices.length}`);
    assert(bobDevs.devices[0].id === "bob-laptop", "bob's only device is bob-laptop");
    // critical: bob should NOT see alice's devices
    for (const d of bobDevs.devices) {
      assert(d.id !== "alice-mac" && d.id !== "alice-iphone", `bob saw alice's ${d.id}`);
    }
    console.log("[t] cross-user isolation OK (bob sees only his own) ✓");

    // 6. PATCH device name
    const patch1 = await patch(port, "/api/devices/alice-mac", { name: "Alice 的家用机" }, aliceAccess);
    assert(patch1.status === 200, "patch status");
    // Wait for the NEXT MY_DEVICES (after PATCH) — previous ones in inbox are stale.
    const before = alice1.inbox.filter((m) => m.type === "MY_DEVICES").length;
    alice1.send({ type: "LIST_MY_DEVICES" });
    const renamed = await alice1.waitFor(
      (m) => m.type === "MY_DEVICES" && alice1.inbox.filter((x) => x.type === "MY_DEVICES").indexOf(m) >= before
    );
    const d2 = renamed.devices.find((d) => d.id === "alice-mac");
    assert(d2.name === "Alice 的家用机", `renamed: ${d2.name}`);
    console.log(`[t] device renamed to "${d2.name}" ✓`);

    // 6b. PATCH with no auth -> 401
    const patch2 = await patch(port, "/api/devices/alice-mac", { name: "hax" });
    assert(patch2.status === 401, "patch without auth");
    console.log("[t] PATCH without auth → 401 ✓");

    // 6c. PATCH another user's device -> 404
    const patch3 = await patch(port, "/api/devices/bob-laptop", { name: "hax" }, aliceAccess);
    assert(patch3.status === 404, "patch other user");
    console.log("[t] PATCH cross-user → 404 ✓");

    // 7. Connect to my device
    // alice-iphone -> requestControl alice-mac
    alice2.send({
      type: "CONTROL_REQUEST",
      targetId: "alice-mac",
      sessionId: "auto-test-session",
    });
    const ctrlReq = await alice1.waitFor(
      (m) => m.type === "CONTROL_REQUEST" && m.fromId === "alice-iphone"
    );
    assert(ctrlReq.sessionId === "auto-test-session", "control req sessionId");
    console.log(`[t] alice1 received CONTROL_REQUEST from alice-iphone ✓`);

    // 8. Refresh token
    const rR = await post(port, "/api/auth/refresh", { refreshToken: aliceRefresh });
    assert(rR.status === 200, "refresh status");
    assert(rR.body.accessToken !== aliceAccess, "rotated access");
    console.log("[t] refresh rotated tokens ✓");

    // 8b. Old refresh token should be invalidated (rotation)
    const rR2 = await post(port, "/api/auth/refresh", { refreshToken: aliceRefresh });
    assert(rR2.status === 401, "old refresh should fail");
    console.log("[t] old refresh rejected after rotation ✓");

    // 9. Logout invalidates
    const lo = await post(port, "/api/auth/logout", undefined, rR.body.accessToken);
    assert(lo.status === 204, "logout");
    // After logout, me should 401
    const me = await get(port, "/api/me"); // no token
    assert(me.status === 401, "me after logout no token");
    // Also with the now-invalid access token
    const me2 = await fetch(`http://127.0.0.1:${port}/api/me`, {
      headers: { authorization: `Bearer ${rR.body.accessToken}` },
    });
    assert(me2.status === 401, "me with logged-out token");
    // Use the OLD refresh token too (already invalid from rotation, but logout adds belt+suspenders)
    const rR3 = await post(port, "/api/auth/refresh", { refreshToken: aliceRefresh });
    assert(rR3.status === 401, "refresh after logout");
    console.log("[t] logout invalidated session ✓");

    alice1.close();
    alice2.close();
    bobWs.close();
  } finally {
    child.kill("SIGTERM");
    await delay(500);
    if (child.exitCode === null) child.kill("SIGKILL");
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\nALL AUTH E2E CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
