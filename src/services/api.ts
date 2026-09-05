// HTTP API client for z-biz-tool-remote-server.
//
// Talks to:
//   POST /api/auth/register    {username, password} -> 201 + tokens
//   POST /api/auth/login       {username, password} -> 200 + tokens
//   POST /api/auth/refresh     {refreshToken}        -> 200 + new tokens
//   POST /api/auth/logout                              -> 204
//   GET  /api/me                                      -> {user, devices}
//   PATCH /api/devices/:id    {name}                  -> 200
//   DELETE /api/devices/:id                            -> 204
//
// Auto-refresh: when any request returns 401, the wrapper tries to
// refresh the access token once and replays the original request.

import { getAuth, setAuth, type AuthSession } from "./storage";

// Convert ws://host:port  ->  http://host:port
// Convert wss://host:port ->  https://host:port
export function serverUrlToHttpBase(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}`;
  } catch {
    return serverUrl;
  }
}

async function rawFetch(base: string, path: string, init: RequestInit, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) || {}),
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return res;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, msg: string) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Public API

export async function register(
  base: string,
  username: string,
  password: string
): Promise<AuthSession> {
  const res = await rawFetch(base, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) {
    const body = await readBody(res);
    throw new ApiError(res.status, body, `register failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Omit<AuthSession, "accessToken" | "refreshToken" | "expiresAt"> & {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
  const sess: AuthSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: body.expiresAt,
    user: body.user,
  };
  setAuth(sess);
  return sess;
}

export async function login(
  base: string,
  username: string,
  password: string
): Promise<AuthSession> {
  const res = await rawFetch(base, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) {
    const body = await readBody(res);
    throw new ApiError(res.status, body, `login failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { user: AuthSession["user"]; accessToken: string; refreshToken: string; expiresAt: number };
  const sess: AuthSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: body.expiresAt,
    user: body.user,
  };
  setAuth(sess);
  return sess;
}

export async function logout(base: string): Promise<void> {
  const auth = getAuth();
  if (!auth) return;
  try {
    await rawFetch(base, "/api/auth/logout", { method: "POST" }, auth.accessToken);
  } catch {
    /* ignore network errors on logout */
  }
  setAuth(null);
}

async function refreshAccessToken(base: string): Promise<AuthSession | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const res = await rawFetch(base, "/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: auth.refreshToken }),
    });
    if (res.status !== 200) {
      setAuth(null);
      return null;
    }
    const body = (await res.json()) as { accessToken: string; refreshToken: string; expiresAt: number };
    const next: AuthSession = { ...auth, ...body };
    setAuth(next);
    return next;
  } catch {
    return null;
  }
}

/**
 * Public refresh: pass an explicit refreshToken (do not require getAuth() to
 * be populated). Used by App.tsx during auto-restore, where the disk-loaded
 * auth may be about to expire.
 */
export async function refresh(
  base: string,
  refreshToken: string
): Promise<AuthSession | null> {
  try {
    const res = await rawFetch(base, "/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    if (res.status !== 200) {
      setAuth(null);
      return null;
    }
    const body = (await res.json()) as { accessToken: string; refreshToken: string; expiresAt: number };
    const existing = getAuth();
    const next: AuthSession = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt,
      user: existing?.user ?? { id: "", username: "", createdAt: 0 },
    };
    setAuth(next);
    return next;
  } catch {
    return null;
  }
}

// Authenticated request with one auto-refresh retry on 401.
export async function authedFetch(
  base: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const auth = getAuth();
  if (!auth) throw new ApiError(401, null, "not logged in");
  let res = await rawFetch(base, path, init, auth.accessToken);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken(base);
    if (refreshed) {
      res = await rawFetch(base, path, init, refreshed.accessToken);
    }
  }
  return res;
}

export async function fetchMe(
  base: string
): Promise<{ user: AuthSession["user"]; devices: Array<{ id: string; name: string; lastSeen: number; createdAt: number }> }> {
  const res = await authedFetch(base, "/api/me");
  if (!res.ok) {
    const body = await readBody(res);
    throw new ApiError(res.status, body, `me failed: HTTP ${res.status}`);
  }
  return res.json() as Promise<{ user: AuthSession["user"]; devices: Array<{ id: string; name: string; lastSeen: number; createdAt: number }> }>;
}

export async function renameDevice(
  base: string,
  deviceId: string,
  name: string
): Promise<void> {
  const res = await authedFetch(base, `/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await readBody(res);
    throw new ApiError(res.status, body, `rename failed: HTTP ${res.status}`);
  }
}

export async function deleteDevice(base: string, deviceId: string): Promise<void> {
  const res = await authedFetch(base, `/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const body = await readBody(res);
    throw new ApiError(res.status, body, `delete failed: HTTP ${res.status}`);
  }
}
