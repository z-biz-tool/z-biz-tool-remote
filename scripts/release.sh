#!/usr/bin/env bash
#
# scripts/release.sh  (z-biz-tool-remote 专用)
# ------------------------------------------------------------------------------
# 这个仓库与其它 z-biz-tool 项目不同:
#   - 它有 client (Tauri 桌面端) + server (Node 服务) 两个子项目
#   - GitHub Actions 是 main 分支 push 触发的 (build-client.yml / build-server.yml),
#     不是 tag 触发, 因此 tag 主要作为版本标记, 真正驱动打包的是 push main 本身.
#
# 本脚本会:
#   1) 让你选择 bump client / server / both
#   2) 对选中的子项目:
#      - 读其 package.json 的 version, minor +1, patch 归零
#      - client 还会同步更新 z-biz-tool-remote-client/src-tauri/Cargo.toml
#        以及 z-biz-tool-remote-client/src-tauri/tauri.conf.json 的 version
#   3) 单次 commit 提交所有改动, push 到 main (触发 GH Actions)
#   4) 打一个或两个 v{version} tag 并 push (作为版本标记)
#
# 用法:
#   bash scripts/release.sh            # 交互式, 默认选 client
#   bash scripts/release.sh --server   # 只 bump server
#   bash scripts/release.sh --both     # 同时 bump client + server
#   bash scripts/release.sh --yes      # 全程不询问
#   bash scripts/release.sh --dry-run  # 只打印计划
# ------------------------------------------------------------------------------

set -euo pipefail

REPO_NAME="$(basename "$(pwd)")"
CLIENT_DIR="z-biz-tool-remote-client"
SERVER_DIR="z-biz-tool-remote-server"

# ---------- 颜色 ----------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
else
  C_RESET=""; C_BOLD=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""
fi

info()  { printf "${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()    { printf "${C_GREEN}✓ %s${C_RESET}\n" "$*"; }
warn()  { printf "${C_YELLOW}! %s${C_RESET}\n" "$*"; }
err()   { printf "${C_RED}✗ %s${C_RESET}\n" "$*" >&2; }

# ---------- 参数 ----------
DRY_RUN=0
ASSUME_YES=0
TARGET="client"   # 默认只 bump client
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=1 ;;
    --yes|-y)   ASSUME_YES=1 ;;
    --client)   TARGET="client" ;;
    --server)   TARGET="server" ;;
    --both)     TARGET="both" ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *) err "未知参数: $arg"; exit 2 ;;
  esac
done

run() {
  if [ $DRY_RUN -eq 1 ]; then
    printf "${C_YELLOW}[dry-run]${C_RESET} %s\n" "$*"
  else
    info "$*"
    "$@"
  fi
}

confirm() {
  local prompt="$1"
  if [ $ASSUME_YES -eq 1 ]; then return 0; fi
  printf "${C_BOLD}%s${C_RESET} [y/N] " "$prompt"
  read -r ans
  [ "$ans" = "y" ] || [ "$ans" = "Y" ]
}

# ---------- 预检 ----------
info "预检 [$REPO_NAME]"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "当前目录不是 git 仓库"; exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  err "工作区不干净, 请先 commit 或 stash 所有改动"
  git status --short
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  err "需要 python3"; exit 1
fi

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [ -z "$CURRENT_BRANCH" ]; then
  err "detached HEAD, 请先切到分支"; exit 1
fi
if [ "$CURRENT_BRANCH" != "main" ]; then
  warn "当前分支是 $CURRENT_BRANCH, 不是 main"
  confirm "继续在 $CURRENT_BRANCH 上发布?" || exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  err "没有配置 origin"; exit 1
fi

# ---------- 工具函数 ----------
read_version() {
  local pkg="$1"
  if [ ! -f "$pkg" ]; then
    err "找不到 $pkg"; exit 1
  fi
  python3 -c "
import json
with open('$pkg') as f: print(json.load(f)['version'])
"
}

bump_file() {
  local file="$1" new_ver="$2"
  if [ ! -f "$file" ]; then
    warn "跳过 (文件不存在): $file"
    return 0
  fi
  if [ $DRY_RUN -eq 1 ]; then
    printf "${C_YELLOW}[dry-run]${C_RESET} %s -> %s\n" "$file" "$new_ver"
    return 0
  fi
  python3 - "$file" "$new_ver" <<'PY'
import re, sys
path, new_ver = sys.argv[1], sys.argv[2]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()
patterns = [
    (r'("version"\s*:\s*)"[^"]+"',  rf'\g<1>"{new_ver}"'),  # JSON
    (r'(^|\n)(version\s*=\s*)"[^"]+"', rf'\g<2>"{new_ver}"'),  # TOML
]
for pat, repl in patterns:
    new, n = re.subn(pat, repl, content, count=1)
    if n:
        content = new; break
else:
    sys.exit(f"未在 {path} 中找到 version 字段")
with open(path, 'w', encoding='utf-8') as f:
    f.write(content)
PY
  ok "更新 $file -> $new_ver"
}

compute_next() {
  local current="$1"
  IFS='.' read -r MAJOR MINOR _ <<<"$current"
  if [ -z "$MAJOR" ] || [ -z "$MINOR" ]; then
    err "无法解析版本号 '$current'"; exit 1
  fi
  echo "$MAJOR.$((MINOR + 1)).0"
}

# ---------- 计算各目标的新版本 ----------
CHANGED_PATHS=()
TAGS_TO_PUSH=()
SUMMARY_LINES=()

process_target() {
  local label="$1" dir="$2" cargo_rel="$3" tauri_rel="$4"
  local pkg_json="$dir/package.json"
  if [ ! -d "$dir" ]; then
    warn "目录不存在, 跳过 $label: $dir"; return 0
  fi
  local cur new
  cur="$(read_version "$pkg_json")"
  new="$(compute_next "$cur")"
  ok "$label 当前 $cur -> 新版本 $new"

  if git rev-parse "v$new" >/dev/null 2>&1; then
    err "tag v$new 已存在 (来自其他子项目?), 请先清理"
    exit 1
  fi

  bump_file "$pkg_json" "$new"
  CHANGED_PATHS+=("$pkg_json")
  [ -n "$cargo_rel"  ] && bump_file "$dir/$cargo_rel"  "$new" && CHANGED_PATHS+=("$dir/$cargo_rel")
  [ -n "$tauri_rel"  ] && bump_file "$dir/$tauri_rel"  "$new" && CHANGED_PATHS+=("$dir/$tauri_rel")
  TAGS_TO_PUSH+=("v$new")
  SUMMARY_LINES+=("  - $label: $cur -> $new (tag v$new)")
}

case "$TARGET" in
  client)
    process_target "client" "$CLIENT_DIR" "src-tauri/Cargo.toml" "src-tauri/tauri.conf.json" ;;
  server)
    process_target "server" "$SERVER_DIR" "" "" ;;
  both)
    process_target "client" "$CLIENT_DIR" "src-tauri/Cargo.toml" "src-tauri/tauri.conf.json"
    process_target "server" "$SERVER_DIR" "" "" ;;
esac

if [ ${#TAGS_TO_PUSH[@]} -eq 0 ]; then
  err "没有任何目标被处理, 退出"; exit 1
fi

# ---------- 总结计划 ----------
REMOTE_URL="$(git remote get-url origin)"
REPO_URL="$(echo "$REMOTE_URL" | sed -E 's#^(git@|https://)github.com[:/]+##; s#\.git$##')"
ACTIONS_URL="https://github.com/$REPO_URL/actions"

info "即将执行:"
printf '%s\n' "${SUMMARY_LINES[@]}"
cat <<EOF
  - git commit -m "chore(release): bump version"
  - git push origin $CURRENT_BRANCH   -> 触发 GitHub Actions: $ACTIONS_URL
  - git push tag(s): ${TAGS_TO_PUSH[*]}   (作为版本标记)
EOF

confirm "确认执行?" || { err "已取消"; exit 1; }

# ---------- 执行 ----------
run git add "${CHANGED_PATHS[@]}"
run git commit -m "chore(release): bump version (${TARGET})"

# 先 push main, 让 GH Actions 跑构建; 再 push tag
run git push origin "$CURRENT_BRANCH"
for t in "${TAGS_TO_PUSH[@]}"; do
  run git tag "$t"
  run git push origin "$t"
done

ok "发布完成! GitHub Actions 进度: $ACTIONS_URL"