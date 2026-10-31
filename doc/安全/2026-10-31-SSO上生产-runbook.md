# ctc 统一 SSO 上生产 Runbook（2026-10-31）

> 对象：边缘机 **101.37.80.51** 上的 `z-biz-tool-remote-server`（compose 服务名 `signaling`，容器名 `z-biz-signaling`）
> 代码提交：`cb96615`（客户端判据同源 + 服务端可测判据 + `.env`/compose 补 SSO 变量）
> 状态：**代码已就绪，生产未生效** —— 生产跑的进程还是没有 SSO 的旧代码。

## 0. 为什么现在还没生效

外网实测（Node https，本机 curl 对该域名有已知 TLS 缺陷会返回 000）：

| 端点 | 期望 | 实测 | 结论 |
|------|------|------|------|
| `GET /health` | 200 | 200，`uptimeSec≈516542`（约 6 天） | 进程自 2026-10-25 收口后**没重启过** |
| `GET /api/sso/config` | 未配时 204 | **404** | 旧代码里根本没这个路由 |
| `POST /api/auth/sso` | 未配时 503 | **404** | 同上 |

⇒ 生产机上跑的是 **10-25 收口时部署的旧代码**。SSO 代码虽已进仓（且生产仓
`z-biz/z-biz-tool-remote` 与上游 `z-biz-tool/z-biz-tool-remote` 的 `auth.js`/`server.js`
blob 哈希一致），但**没重新部署**。

## 1. 需要 CEO 提供的东西（我拿不到）

ctc 侧的 4 个端点参数。**缺任何一项都等于未启用** —— 服务端会继续返回 204，
客户端就不显示 SSO 入口（这是设计意图，不是故障）。

| 环境变量 | 含义 | 从哪问 |
|----------|------|--------|
| `SSO_AUTHORIZE_URL` | ctc 授权页地址 | ctc 管理员 |
| `SSO_TOKEN_URL` | ctc 令牌端点 | ctc 管理员 |
| `SSO_USERINFO_URL` | ctc 用户信息端点 | ctc 管理员 |
| `SSO_CLIENT_ID` | 本产品在 ctc 注册的 client id | ctc 管理员 |

另需 ctc 侧登记本产品的**回环回调地址**：

```
http://127.0.0.1:<端口>/callback
```

**端口这件事必须先跟 ctc 确认**，两种模式：

| ctc 侧的要求 | 做法 | 配置 |
|--------------|------|------|
| 允许「回环地址 + 任意端口」 | 保持默认（动态端口）。端口由客户端内核分配，**不可预测** ⇒ 更安全 | `SSO_REDIRECT_PORT` 留空 |
| 要求 `redirect_uri` 与预登记值**精确匹配**（多数 OIDC 服务端如此） | 指定一个固定端口，并把 `http://127.0.0.1:<该端口>/callback` 登记到 ctc 侧 | `SSO_REDIRECT_PORT=17888` |

固定端口的代价：端口可预测（可被同机其它进程抢注），且被占用时登录直接失败。
客户端此时**不会**悄悄退回动态端口 —— 那会让拼出去的 `redirect_uri` 与实际监听端口
对不上，表现为浏览器回调发到一个没人接的端口，登录永远等不到。

`SSO_SCOPE` 默认 `openid profile email`，`SSO_TIMEOUT_MS` 默认 10000，一般不用改。

## 2. 部署步骤（在 101.37.80.51 上执行）

### 2.1 前置与备份

```bash
ssh zifang@101.37.80.51
cd <仓库部署目录>          # 下文记作 $REPO
git fetch --all && git log --oneline -3     # 确认能看到 cb96615
git checkout cb96615

# 备份现状：镜像 + .env + data（data.json 是生产运行数据，别丢）
docker tag z-biz-tool-remote-server:latest z-biz-tool-remote-server:rollback-20261031
cp .env .env.bak-20261031 2>/dev/null
cp -r data data.bak-20261031 2>/dev/null
```

### 2.2 写入 SSO 配置

```bash
# 追加到 .env（4 项必填）
cat >> .env <<'EOF'
SSO_AUTHORIZE_URL=https://<ctc-host>/oauth2/authorize
SSO_TOKEN_URL=https://<ctc-host>/oauth2/token
SSO_USERINFO_URL=https://<ctc-host>/oauth2/userinfo
SSO_CLIENT_ID=z-biz-tool-remote
EOF

# 若 ctc 要求 redirect_uri 精确匹配，追加固定端口（并在 ctc 侧登记同一个地址）：
# echo 'SSO_REDIRECT_PORT=17888' >> .env
```

> `.env` 里**只填 ctc 的端点**，不要填 `redirect_uri` 整条 URI —— 客户端自己拼。

### 2.3 重建并重启

```bash
cd $REPO/z-biz-tool-remote-server
docker compose build signaling
docker compose up -d signaling
docker compose logs -f signaling      # 看启动日志，确认没有 SSO 相关报错
```

### 2.4 验证（三条，缺一不可）

```bash
# ① 配置已下发（200 + 4 个字段齐全，**不含** redirectUri）
curl -s -i https://remote.zopc.top/api/sso/config | head -20

# ② 未授权访问仍 401（接了 SSO 不该放松鉴权）
curl -s -o /dev/null -w '%{http_code}\n' https://remote.zopc.top/api/me

# ③ 账号密码登录照常（SSO 是多一种入口，不是替代）
curl -s -X POST -H 'content-type: application/json' \
  -d '{"username":"<已有账号>","password":"<密码>"}' https://remote.zopc.top/api/auth/login
```

预期：① 200 且 body 有 `authorizeUrl`/`tokenUrl`/`userInfoUrl`/`clientId`/`scope`；
② 401；③ 200。

> 本机 curl 对该域名可能返回 000（LibreSSL TLS 缺陷），改用 Node：
> `node -e "require('https').get('https://remote.zopc.top/api/sso/config',r=>{r.pipe(process.stdout)})"`

### 2.5 回滚

```bash
cd $REPO/z-biz-tool-remote-server
docker compose down
docker tag z-biz-tool-remote-server:rollback-20261031 z-biz-tool-remote-server:latest
docker compose up -d signaling
# .env 里删掉 4 个 SSO_ 变量（留着也只是「未启用」，但回滚要干净）
```

## 3. 客户端侧验证

SSO 入口是**条件渲染**的：`GET /api/sso/config` 返回 200 且配置齐全时，登录页
才出现「用 ctc 账号登录」按钮；返回 204（未配）时**按钮不出现**。

⇒ 这是个天然的验收信号：**按钮出现 = 配置下发成功；按钮不出现 = 服务端没配或没重启**。

密钥库不可用时按钮也不出现（且点了会提示改用密码登录）—— 这是有意的：
token 只能落明文存储时，比没有 SSO 更糟。

## 4. 遗留（不在本次范围，但要记）

生产仍是 `setsid nohup` 直跑还是 compose？本 runbook 按 compose 写
（runbook `2026-10-21` 明确写了「compose 服务名 `signaling`」），但 10-25 收口记录
里写的是 `setsid nohup node src/server.js`（旧 `src/` 布局）。
**执行前先确认生产当前到底是哪种方式**：

```bash
docker ps | grep -i signaling
ps aux | grep -i "node.*server" | grep -v grep
```

两种方式的改法不同：
- **compose** → 按 §2.3 重建容器。
- **裸 node** → 生产代码树是**另一棵树**（旧 `src/` 布局），
  必须先把 `cb96615` 的 `auth.js`/`server.js`/`storage.js` 移植过去再重启；
  这正是 10-25 那次「修复被提交到了一个和生产没有关系的代码树」的失败模式。

## 5. 一句话给 CEO

代码侧已全部就绪并通过门禁（客户端 81 条 / 服务端全量 / Docker 门禁修好后转绿）。
**要 SSO 真的可用，只差两件我做不了的事**：① 给我 ctc 的 4 个端点参数；
② 给我生产机的 SSH 密码（或者你自己按 §2 跑一遍）。
