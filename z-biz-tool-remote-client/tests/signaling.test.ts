// 信令状态机测试：phase 迁移、重连退避、协议分支、发送失败计数
// 运行：npm run test  （node --experimental-strip-types --test tests/*.test.ts）
//
// 为什么这层必须有网：signaling.ts 544 行，是本仓 WebRTC 协议的状态中枢，
// 8 个上行命令 + 8 类下行消息 + 5 态连接机全在里面，而此前 tests/ 只测了
// backoff 与 telemetry（296 行纯函数）。状态机一旦改错，现场症状是
// 「偶发连不上」或「画面偶尔卡住」——**单测之外没有任何东西能抓住它**。
//
// 测法：注入一个假 WebSocket（构造器只被 new 一次，全部交互经 onopen/onmessage/
// onclose），把外部世界换掉，状态机照原样跑。不用真网络、不用真 ws 包。
import { test } from "node:test";
import assert from "node:assert/strict";

import { SignalingClient, type SocketState } from "../src/services/signaling.ts";

/** 假 WebSocket：记录所有 send，并允许测试手动推动事件。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;

  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closeCalls = 0;
  // 不能写 `constructor(public url: string)`：node --experimental-strip-types
  // 是**仅擦除**类型，不做参数属性改写，遇到就报
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。显式字段 + 显式赋值。
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeSocket.CLOSED;
  }

  // ---- 测试驱动 ----
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  recv(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverClose(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  sentTypes(): string[] {
    return this.sent.map((s) => JSON.parse(s).type);
  }
}

// 收集假 window.setInterval / setTimeout 注册的回调，测试里可手动驱动。
const timers: Array<() => void> = [];
const timeouts: Array<() => void> = [];

/**
 * 装上假 WebSocket + 假 window，**并把建好的 client 交给用例**。
 * 第一版这里自己 new 了一个 client 去挂 state 监听、却没把它返回给用例，
 * 于是用例里又 new 了一个 —— 事件全收在 helper 那个实例上，
 * states 永远是空数组。症状是 `Cannot read properties of undefined`。
 * helper 必须把「被测对象」交出去，否则它测的是另一个实例。
 */
function withFakeWs<T>(fn: (ctx: {
  client: SignalingClient;
  states: SocketState[];
  last: () => FakeSocket;
}) => T): T {
  const g = globalThis as unknown as {
    WebSocket?: unknown;
    document?: unknown;
    window?: unknown;
  };
  const hadWs = "WebSocket" in g;
  const hadDoc = "document" in g;
  const hadWin = "window" in g;
  const prevWs = g.WebSocket;
  const prevDoc = g.document;
  const prevWin = g.window;
  FakeSocket.instances = [];
  timers.length = 0;
  timeouts.length = 0;
  g.WebSocket = FakeSocket;
  delete g.document; // bindVisibility 里 typeof document === 'undefined' 才会跳过
  // startRttProbe 用 window.setInterval，scheduleReconnect 用 window.setTimeout，
  // 两者都返回**数字句柄**（浏览器行为）并由 clearXxx 取消。
  // 假实现把回调收进数组、不真跑：重连定时器真跑起来会让测试进程挂住，
  // 而且退避是秒级/十秒级，等不起。
  g.window = {
    setInterval: (fn: () => void, _ms: number) => {
      timers.push(fn);
      return timers.length;
    },
    clearInterval: (_h: number) => {
      /* 句柄不真跑，无需撤销 */
    },
    setTimeout: (fn: () => void, _ms: number) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout: (_h: number) => {
      /* 同上 */
    },
  };
  const states: SocketState[] = [];
  try {
    const c = new SignalingClient();
    c.on("state", (s) => states.push(s));
    return fn({ client: c, states, last: () => FakeSocket.instances[FakeSocket.instances.length - 1] });
  } finally {
    if (hadWs) g.WebSocket = prevWs;
    else delete g.WebSocket;
    if (hadDoc) g.document = prevDoc;
    else delete g.document;
    if (hadWin) g.window = prevWin;
    else delete g.window;
  }
}

// ---------------------------------------------------------------- 状态机

test("connect → open：phase 走 connecting → online，并先发 REGISTER", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d1", deviceName: "我的机" });
    const sock = last();
    // connect() 内部先 disconnect() 再 openSocket()，所以序列是 idle → connecting。
    // 断言「首个进入的连接态是 connecting」而不是「第一个事件就是 connecting」——
    // 前者钉行为，后者把 disconnect 的收尾动作也当成了契约。
    assert.deepEqual(states.filter((s) => s.phase !== "idle").map((s) => s.phase), ["connecting"]);

    sock.open();
    assert.equal(states[states.length - 1].phase, "online");
    const reg = JSON.parse(sock.sent[0]);
    assert.equal(reg.type, "REGISTER");
    assert.equal(reg.deviceId, "d1");
    assert.equal(reg.deviceName, "我的机");
    c.disconnect();
  });
});

test("token 会被拼进 ws URL；已有 token 参数时不重复追加", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d", token: "tk1" });
    assert.equal(last().url, "wss://h/s?token=tk1");
    c.disconnect();

    c.connect({ url: "wss://h/s?token=old", deviceId: "d", token: "tk2" });
    assert.equal(last().url, "wss://h/s?token=old", "已有 token 就该原样保留");
    c.disconnect();
  });
});

test("主动 disconnect ⇒ phase 落到 idle，不排重连", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    c.disconnect();
    assert.equal(states[states.length - 1].phase, "idle");
    c.disconnect();
  });
});

test("异常断开 ⇒ 进入 reconnecting 并带 attempt 与 retryInMs", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    last().serverClose(1006);

    const tail = states[states.length - 1];
    assert.equal(tail.phase, "reconnecting");
    assert.equal(tail.attempt, 1);
    assert.ok(tail.retryInMs === null || typeof tail.retryInMs === "number");
    assert.match(String(tail.reason), /连接中断/);
    c.disconnect();
  });
});

test("终止类 close code（1008）⇒ phase failed，不再重连", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    last().serverClose(1008);

    const tail = states[states.length - 1];
    assert.equal(tail.phase, "failed", `1008 是服务端拒绝，应终止，实际 ${tail.phase}`);
    assert.match(String(tail.reason), /1008/);
    c.disconnect();
  });
});

test("可重试的 close code（1000 之外的非终态，如 1011）⇒ 不进 failed", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    last().serverClose(1011);
    assert.notEqual(states[states.length - 1].phase, "failed");
    c.disconnect();
  });
});

// ---------------------------------------------------------------- 协议分支

test("收到 PING ⇒ 回 PONG", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();
    sock.sent.length = 0;

    sock.recv({ type: "PING" });
    assert.deepEqual(sock.sentTypes(), ["PONG"]);
    c.disconnect();
  });
});

test("ERROR/UNKNOWN_TYPE+WEBRTC_SIGNAL ⇒ 判为不支持中继，但不进 failed", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();
    sock.recv({ type: "ERROR", code: "UNKNOWN_TYPE", message: "WEBRTC_SIGNAL" });

    assert.equal(
      states[states.length - 1].phase,
      "online",
      "老服务端不支持 WebRTC 是能力降级，不是连接失败",
    );
    c.disconnect();
  });
});

test("ERROR/终止类 code ⇒ phase failed 并主动断开", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();
    const closesBefore = sock.closeCalls;
    sock.recv({ type: "ERROR", code: "UNAUTHORIZED", message: "令牌无效" });

    assert.equal(states[states.length - 1].phase, "failed");
    assert.ok(sock.closeCalls > closesBefore, "判 failed 后应主动关掉 socket");
    c.disconnect();
  });
});

test("failed 之后再次 connect ⇒ 重新进入 connecting（终态不粘住）", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    last().serverClose(1008);
    assert.equal(states[states.length - 1].phase, "failed");

    // 用户改了令牌后重连：connect() 内部先调 disconnect()，
    // 而 disconnect() 已被改成「phase 是 failed 时不刷 idle」——
    // 必须确认重连不会被这个保护卡在 failed 上。
    c.connect({ url: "wss://h/s", deviceId: "d" });
    assert.equal(
      states[states.length - 1].phase,
      "connecting",
      "重连必须离开 failed，否则用户改完令牌也连不上",
    );
    c.disconnect();
  });
});

test("用户主动 disconnect ⇒ 仍落到 idle（终态保护不能反噬主动断开）", () => {
  withFakeWs(({ client: c, states, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    last().open();
    assert.equal(states[states.length - 1].phase, "online");

    c.disconnect();
    assert.equal(
      states[states.length - 1].phase,
      "idle",
      "主动断开必须落 idle；「failed 时不覆盖」这条保护不能波及其它路径",
    );
  });
});

test("WEBRTC_SIGNAL ⇒ 转成 webrtc-signal 事件，fromId 缺省补空串", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();

    const got: unknown[] = [];
    c.on("webrtc-signal", (p) => got.push(p));
    sock.recv({ type: "WEBRTC_SIGNAL", kind: "offer", sdp: "v=0" });

    assert.equal(got.length, 1);
    assert.deepEqual(got[0], { kind: "offer", sdp: "v=0", candidate: undefined, fromId: "", sessionId: undefined });
    c.disconnect();
  });
});

test("SCREEN_FRAME / CHAT_MESSAGE / FILE_TRANSFER_* 各转对应事件", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();

    const frames: unknown[] = [];
    const chats: unknown[] = [];
    const reqs: unknown[] = [];
    const prog: unknown[] = [];
    c.on("screen-frame", (p) => frames.push(p));
    c.on("chat-message", (p) => chats.push(p));
    c.on("file-transfer-request", (p) => reqs.push(p));
    c.on("file-transfer-progress", (p) => prog.push(p));

    sock.recv({ type: "SCREEN_FRAME", frame: "base64==", fromId: "peer" });
    sock.recv({ type: "CHAT_MESSAGE", message: "在吗", fromId: "peer", timestamp: 7 });
    sock.recv({ type: "FILE_TRANSFER_REQUEST", requestId: "r1", fileName: "a.pdf", fileSize: 10, fromId: "peer" });
    sock.recv({ type: "FILE_TRANSFER_PROGRESS", requestId: "r1", progress: 0.5, fromId: "peer" });

    assert.deepEqual(frames, [{ frame: "base64==", fromId: "peer" }]);
    assert.deepEqual(chats, [{ message: "在吗", fromId: "peer", timestamp: 7 }]);
    assert.deepEqual(reqs, [{ requestId: "r1", fileName: "a.pdf", fileSize: 10, fromId: "peer" }]);
    assert.deepEqual(prog, [{ requestId: "r1", progress: 0.5, fromId: "peer" }]);
    c.disconnect();
  });
});

test("无法解析的 JSON 静默丢弃，不炸也不产生事件", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const sock = last();
    sock.open();

    const msgs: unknown[] = [];
    c.on("message", (p) => msgs.push(p));
    sock.onmessage?.({ data: "{不是 JSON" });

    assert.equal(msgs.length, 0);
    c.disconnect();
  });
});

// ---------------------------------------------------------------- 发送

test("socket 未开时 send 返回 false（不静默当成功）", () => {
  withFakeWs(({ client: c }) => {
    // 还没 connect，ws 为 null
    assert.equal(c.send({ type: "CREATE_SESSION" }), false);
  });
});

test("重复 connect 同一 URL 不重建 socket", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const first = last();
    c.connect({ url: "wss://h/s", deviceId: "d" });
    assert.equal(FakeSocket.instances.length, 1, "同 URL 重复 connect 不该再建一条连接");
    assert.equal(first, last());
    c.disconnect();
  });
});

test("换 URL 时重建 socket", () => {
  withFakeWs(({ client: c, last }) => {
    c.connect({ url: "wss://h/s", deviceId: "d" });
    const first = last();
    c.connect({ url: "wss://h2/s", deviceId: "d" });
    assert.equal(FakeSocket.instances.length, 2);
    assert.notEqual(first, last());
    c.disconnect();
  });
});
