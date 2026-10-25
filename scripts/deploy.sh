#!/usr/bin/env bash
# z-biz-tool-remote 安全修复 · 生产部署脚本
# ---------------------------------------------------------------------------
# 前置（当前 WorkBuddy 会话无生产机凭证，本脚本由 CEO 在已配置 SSH 的机器执行）：
#   1) 本机 ~/.ssh 已能免密登录 101.37.80.51（DEPLOY_USER@DEPLOY_HOST）
#   2) 已安装 rsync / docker / docker-compose / certbot / node
#   3) 已生成 INVITE_CODE（脚本内自动生成，也可从密码库取）
# 安全修复内容见 git commit 8cc68c7 + doc/安全/2026-10-21-暴露面修复-部署runbook.md
# ---------------------------------------------------------------------------
set -euo pipefail

HOST="${DEPLOY_HOST:-101.37.80.51}"
SSH_USER="${DEPLOY_USER:-root}"
APP_DIR="${DEPLOY_DIR:-/opt/z-biz-tool-remote}"
# 灰度顺序（来自 runbook）：先 frame-only，观察无 token-in-query 后切 both，最后 full
WS_TOKEN_TRANSPORT="${WS_TOKEN_TRANSPORT:-frame}"
INVITE_CODE="${INVITE_CODE:-$(openssl rand -hex 16)}"
REGISTER_RATE_LIMIT="${REGISTER_RATE_LIMIT:-10}"
REGISTER_WINDOW="${REGISTER_WINDOW:-60}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
HTTPS_PORT="${HTTPS_PORT:-443}"

echo "== 0. 部署前自检（目标当前状态，只读探测） =="
node scripts/security-probe.mjs --base-url "https://$HOST" || true

echo "== 1. 同步源码到生产机 =="
rsync -avz --exclude node_modules --exclude target --exclude .git \
  ./ "$SSH_USER@$HOST:$APP_DIR/"

echo "== 2. TLS 证书（certbot 首次需 80 端口放行） =="
ssh "$SSH_USER@$HOST" \
  "certbot certonly --standalone -d remote.zbiz.example --non-interactive --agree-tos -m admin@zbiz.example || echo '证书已存在，跳过'"

echo "== 3. 起服务（HTTPS 443，token 走 frame，注册限流 10/60s） =="
ssh "$SSH_USER@$HOST" "cd $APP_DIR && \
  WS_TOKEN_TRANSPORT=$WS_TOKEN_TRANSPORT \
  INVITE_CODE=$INVITE_CODE \
  REGISTER_RATE_LIMIT=$REGISTER_RATE_LIMIT \
  REGISTER_WINDOW=$REGISTER_WINDOW \
  BIND_ADDR=$BIND_ADDR \
  HTTPS_PORT=$HTTPS_PORT \
  docker compose up -d"

echo "== 4. 安全组收口（需在云控制台执行，CLI 仅示例） =="
echo "  【必须】入站规则：仅放 443，删除 8080 放行（当前探测 8080 仍 OPEN = 未收口）"
echo "  腾讯云示例：tccli vpc DeleteSecurityGroupPolicies --SecurityGroupPolicySet '{\"Ingress\":[{\"Protocol\":\"TCP\",\"Port\":\"8080\"}]}'"
echo "  阿里云示例：aliyun ecs RevokeSecurityGroup --PortRange 8080/8080 --IpProtocol tcp"

echo "== 5. 部署后验证（应全部通过：注册限流 429 / 强制 TLS / 无 token-in-query / 健康检查 200） =="
node scripts/security-probe.mjs --base-url "https://$HOST"

echo "== 6. 回滚 =="
echo "  ssh $SSH_USER@$HOST \"cd $APP_DIR && docker compose down && docker compose up -d <上一个可用镜像 tag>\""

echo "完成。若第 5 步有 ✘，先回滚再排查，切勿带病上线。"
