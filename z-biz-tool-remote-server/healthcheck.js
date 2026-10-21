// 容器健康检查探针：GET /healthz。
//
// 为什么不用 wget（Dockerfile 与 compose 原来都用 `wget -qO- http://…/healthz`）：
//   开了 TLS 之后探针地址要变成 https://127.0.0.1:8080/healthz，而边缘机上的
//   certbot 证书 SAN 里**没有 127.0.0.1**，busybox wget 会因证书校验失败而返回
//   非 0 ⇒ 容器被判 unhealthy ⇒ restart 策略把它反复重启 ⇒ 服务看起来「时好时坏」。
//
// 这里用 node 的 https 模块，并且**只在这一个探针里**关掉证书校验
// （rejectUnauthorized:false）；进程其它行为不受影响。
//
// 候选地址依次尝试：HEALTHCHECK_URL（显式指定）→ https → http。
// 这样 TLS 开关怎么切，探针都能探到 —— 不用「开了 TLS 还要记得改健康检查地址」。
import http from "node:http";
import https from "node:https";

const PORT = process.env.PORT || "8080";
const candidates = [
  process.env.HEALTHCHECK_URL,
  `https://127.0.0.1:${PORT}/healthz`,
  `http://127.0.0.1:${PORT}/healthz`,
].filter(Boolean);

function probe(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const req = mod.get(
      url,
      { rejectUnauthorized: false, timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => finish(res.statusCode === 200 && body.includes('"ok":true')));
      }
    );
    req.on("error", () => finish(false));
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
  });
}

for (const url of candidates) {
  if (await probe(url)) process.exit(0);
}
process.exit(1);
