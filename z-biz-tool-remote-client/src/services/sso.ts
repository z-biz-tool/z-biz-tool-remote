// ctc 统一 SSO 的客户端适配层。
//
// 分工（**别把协议逻辑搬到这里**）：
//   - 协议流程：z-biz-tool-shared/src/sso/oauth.ts（能被 node 单测覆盖）
//   - IO 胶水：src-tauri/src/sso.rs（cap-sso：回环服务器 / 开浏览器 / 密钥库）
//   - 本文件：把 Tauri 的 invoke 包成上面那个模块要的 `SsoEnvironment`
//
// ## ctc 的端点配置从服务端拿，不烧进客户端
//
// 授权页地址、令牌端点这些属于**会变的运维配置**。若烧进客户端二进制，
// ctc 换个域名就得给全家族客户端发一次更新。
//
// 所以从 `GET /api/sso/config` 拿。服务端没配 SSO 时这个端点返回空 ——
// 客户端据此**不显示登录入口**，而不是显示一个点了必失败的按钮。
// 这正是「SSO 是可选的」在实现层的含义。

import { invoke } from "@tauri-apps/api/core";
import {
  authorizeWithSso,
  SsoSessionStore,
  type SecureStore,
  type SsoConfig,
  type SsoEnvironment,
  type SsoSession,
} from "z-biz-tool-shared/sso";

/** 服务端下发的 SSO 配置（不含 redirectUri —— 那由客户端自己拼）。 */
export interface SsoServerConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  clientId: string;
  scope: string;
}

/**
 * 拉取服务端的 SSO 配置。
 *
 * 返回 `null` 表示服务端没启用 SSO —— **不是错误**，
 * 调用方据此决定「不显示入口」。
 */
export async function fetchSsoConfig(base: string): Promise<SsoServerConfig | null> {
  const url = `${base}/api/sso/config`;
  // 网络层的失败也当「没启用」：地址写错、服务端没起来时，
  // 用户看到的应该是「没有 SSO 入口」，而不是登录页上一个未捕获的异常。
  // SSO 是可选入口，它的配置探测不该有能力把登录页弄崩。
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let text: string;
  try {
    text = await res.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const c = json as Record<string, unknown>;
  // 缺任何一项都当作「没启用」—— 半套配置比没有配置更糟：
  // 用户会看到入口、点了、然后在中途失败。
  const str = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
  const authorizeUrl = str("authorizeUrl");
  const tokenUrl = str("tokenUrl");
  const clientId = str("clientId");
  const scope = str("scope");
  if (!authorizeUrl || !tokenUrl || !clientId || !scope) return null;

  return {
    authorizeUrl,
    tokenUrl,
    userInfoUrl: typeof c.userInfoUrl === "string" ? (c.userInfoUrl as string) : undefined,
    clientId,
    scope,
  };
}

/** 回环服务器的端口占位符。`{PORT}` 会被替换成实际监听的端口。 */
const REDIRECT_URI_TEMPLATE = "http://127.0.0.1:{PORT}/callback";

/**
 * 造一个跑在 Tauri 里的 `SsoEnvironment`。
 *
 * `port` 必须是**这轮登录已经绑定的**端口 —— 拼出来的 `redirectUri`
 * 要和实际监听的一致，否则浏览器回调会连到没人接的端口。
 */
export function createTauriSsoEnvironment(port: number): SsoEnvironment & {
  redirectUri: string;
} {
  const redirectUri = REDIRECT_URI_TEMPLATE.replace("{PORT}", String(port));

  const env: SsoEnvironment & { redirectUri: string } = {
    redirectUri,

    startCallbackServer: async () => {
      // 端口已经在 `startSsoLogin` 里绑好了，这里只给一个视图：
      // `SsoEnvironment` 的形状要求「起服务」返回句柄，而实际的起服务
      // 必须发生在拿端口之前（顺序是 OAuth 决定的，调不过来）。
      return {
        port,
        waitForCallback: async () => {
          // 这条命令会阻塞到浏览器回调 / 超时 / 取消 —— 前端不 await 它去阻塞 UI。
          return await invoke<string>("sso_wait_callback");
        },
        close: async () => {
          await invoke<void>("sso_cancel_callback");
        },
      };
    },

    openBrowser: async (url: string) => {
      await invoke<void>("sso_open_browser", { url });
    },

    fetch: async (url, init) => {
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return {
        ok: res.ok,
        status: res.status,
        text: async () => await res.text(),
      };
    },

    random: (bytes: number): string => {
      const buf = new Uint8Array(bytes);
      crypto.getRandomValues(buf);
      // 逐字节转成 latin1 字符串 —— 下游 createCodeVerifier 用
      // `charCodeAt(i) & 0xff` 取回原始字节，往返无损。
      let s = "";
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return s;
    },

    sha256Base64Url: async (text: string): Promise<string> => {
      const data = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", data);
      return bytesToBase64Url(new Uint8Array(digest));
    },
  };

  return env;
}

/**
 * 字节串 → base64url（无填充）。
 *
 * **不能用 `btoa` 直接转字符串再替换**：PKCE 的 challenge 必须是对
 * verifier 的**字节**做 SHA-256 后再 base64url，中间任何一次有损编码
 * （比如 UTF-8 往返）都会让 ctc 侧算出不同的 challenge，然后以
 * `invalid_grant` 拒掉 —— 那个报错完全看不出根因。
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 起一轮登录：绑端口 → 开浏览器 → 等回调 → 换 token → 取身份。
 *
 * 绑端口单独抽出来，是因为 `redirectUri` 必须在跳浏览器**之前**就定下来，
 * 而它的端口又要先于授权页存在 —— 这个顺序只有把「绑端口」提前才成立。
 */
export async function startSsoLogin(
  config: SsoServerConfig,
): Promise<Awaited<ReturnType<typeof authorizeWithSso>>> {
  // 先绑端口、拿实际端口，再去走流程。
  const port = await invoke<number>("sso_start_callback");
  const env = createTauriSsoEnvironment(port);
  return await authorizeWithSso({ ...config, redirectUri: env.redirectUri }, env);
}

/* ------------------------------------------------------------------ *
 * 会话存储
 * ------------------------------------------------------------------ */

/**
 * 适配 Tauri 的 `SecureStore`。
 *
 * cap-sso 那层把整个会话当成**一条**密钥库条目（account = `sso.tokens`）存，
 * 而 `SsoSessionStore` 也只用一个 key。所以这里直接透传 ——
 * 不做 key 到 account 的映射，那只会引入「读到一半」的中间态。
 */
const tauriSecureStore: SecureStore = {
  get: async () => {
    const raw = await invoke<string | null>("sso_get_tokens");
    return raw ?? null;
  },
  set: async (_key, value) => {
    await invoke<void>("sso_set_tokens", { value });
  },
  delete: async () => {
    // 直接删整条目，不先读再判断 —— 「有没有」这件事已经由后端处理了，
    // 这里再读一遍就是拿一个可能已经过期的中间结果去判断。
    await invoke<void>("sso_clear_tokens");
  },
};

/**
 * SSO 会话的读写入口（token 进密钥库，展示信息进 localStorage）。
 *
 * **别显式传 `localStorage`**：那会在 import 时就求值，而本文件的单测跑在
 * node 里，那里没有 localStorage —— 模块加载即抛，整个测试文件进不来。
 * `SsoSessionStore` 自己会探测并在缺失时回退成空实现，WebView 里它必然存在。
 */
export const ssoSessionStore = new SsoSessionStore(tauriSecureStore);

/** 探测密钥库是否可用。不可用时前端不该显示 SSO 入口。 */
export async function secureStoreAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("sso_secure_store_available");
  } catch {
    return false;
  }
}

/** 用 ctc 的 access_token 换 remote 自己的会话（服务端负责验证）。 */
export async function exchangeForRemoteSession(
  base: string,
  ctcAccessToken: string,
): Promise<{
  user: { id: string; username: string; createdAt: number };
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const res = await fetch(`${base}/api/auth/sso`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ctcAccessToken }),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: string } | null)?.error || `HTTP ${res.status}`;
    throw new Error(err);
  }
  return body as Awaited<ReturnType<typeof exchangeForRemoteSession>>;
}

/** 退出 SSO 登录：清密钥库。 */
export async function clearSsoSession(): Promise<void> {
  await ssoSessionStore.clear();
}

/** 读回已保存的 SSO 会话（用于「上次是谁登录的」）。 */
export async function loadSsoSession(): Promise<{ tokens: unknown; profile: unknown } | null> {
  return await ssoSessionStore.load();
}

/** 会话类型再导出，供 UI 使用。 */
export type { SsoSession, SsoConfig };
