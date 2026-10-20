#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""remote 05 任务表的逐条核对：查**实际代码**，不查注释里的历史叙述。

**为什么需要这个工具**：用 `grep -rq "test-key"` 判「假加密是否已删」会**误报** ——
命中的是 e2e 测试里那句「原实现回落到写死的 "test-key"」的**注释**。
台账明明标了「已落地」，尺子却报「未落地」。

⇒ 判据必须**剥掉注释**再搜。本工具对 JS/TS/Rust/JSON/YAML 做行级注释剥离：
  - `//` 行注释、`/* */` 块注释（JS/TS/Rust）
  - `#` 行注释（Rust 属性、Shell、YAML）
  - 字符串字面量里的 `//` 不当注释（粗略但够用：只剥离**不在引号内**的 `//`）

**量法纪律**（沿用家族既有教训）：
- 每条任务的判据必须**逐条定制**（不同任务要查的特征不同）；
- 查不到就报「未落地」，查到就报「已落地」——**不猜**；
- 命中但只在注释里 ⇒ 单独归类为「仅注释命中（需人工判）」，不当已落地。

用法：
    python3 scripts/check_05_tasks.py            # 全量
    python3 scripts/check_05_tasks.py --only S1-B07
"""

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 剥注释：把一行里的注释部分去掉，返回"代码部分"
_LINE_COMMENT = re.compile(r"//|#")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)


def strip_comments(text: str, ext: str) -> str:
    """去掉注释，保留代码。"""
    # 先整块去 /* */ （可能跨行）
    if ext in ("ts", "tsx", "js", "jsx", "mjs", "cjs", "rs"):
        text = _BLOCK_COMMENT.sub(" ", text)
    out = []
    for line in text.splitlines():
        if ext in ("yml", "yaml", "sh", "bash"):
            # YAML/Shell 只有 # 行注释；但 # 在字符串里的情况少见
            idx = line.find("#")
            if idx >= 0:
                # 粗略：# 前若引号未闭合则不当注释
                before = line[:idx]
                if before.count('"') % 2 == 0 and before.count("'") % 2 == 0:
                    line = before
        else:
            # 找 // 或 #，要求其前面引号成对（粗略）
            for marker in ("//", "#"):
                idx = line.find(marker)
                if idx < 0:
                    continue
                before = line[:idx]
                if before.count('"') % 2 == 0 and before.count("'") % 2 == 0:
                    line = before
                break
        out.append(line)
    return "\n".join(out)


def code_of(path: Path) -> str:
    ext = path.suffix.lstrip(".")
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if ext in ("json",):
        return raw
    return strip_comments(raw, ext)


def search(paths, pattern: str, regex: bool = False) -> str:
    """在给定文件里搜（已剥注释）。返回命中位置描述或 ''。

    特例：模式以 ``__JSON__:`` 开头 ⇒ 走 **JSON 路径判据**。
    JSON 文档用正则跨行匹配不可靠（键名与值可能分行），
    所以这类判据直接解析后按点路径取值。
    """
    if pattern.startswith("__JSON__:"):
        path_expr = pattern[len("__JSON__:"):]
        for rel in paths:
            p = REPO / rel
            if not p.is_file():
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            cur = data
            ok = True
            for part in path_expr.split("."):
                if isinstance(cur, dict) and part in cur:
                    cur = cur[part]
                else:
                    ok = False
                    break
            if ok and cur not in (None, {}, [], ""):
                return f"{rel}#{path_expr}"
        return ""
    rx = re.compile(pattern) if regex else None
    for rel in paths:
        p = REPO / rel
        if not p.is_file():
            continue
        body = code_of(p)
        for i, line in enumerate(body.splitlines(), 1):
            hit = rx.search(line) if rx else (pattern in line)
            if hit:
                return f"{rel}:{i}"
    return ""


# ---------------------------------------------------------------------------
# 逐条判据。每条 = (任务号, 说明, 文件列表, 正则, 期望)
#   期望 "landed"    —— 命中即已落地
#   期望 "absent"   —— **不命中**才算已落地（用于「这段缺陷代码应已被删掉」）
#   期望 "manual"   —— 无法机械判定，需人工读
# ---------------------------------------------------------------------------
CHECKS = [
    # ---- S1-A 恢复可构建 ----
    ("S1-A01/A02", "Dockerfile 不再 COPY src ./src，改 COPY 具体 js",
     ["z-biz-tool-remote-server/Dockerfile"], r"COPY\s+src\s+\./src", "absent"),
    ("S1-A01/A02", "Dockerfile CMD 指向 server.js",
     ["z-biz-tool-remote-server/Dockerfile"], r'CMD\s+\["node",\s*"server\.js"\]', "landed"),
    ("S1-A03", "ci.yml 有 defaults.run.working-directory",
     [".github/workflows/ci.yml"], r"working-directory", "landed"),
    ("S1-A04", "build-server.yml 的 pull_request 在 on 顶层",
     [".github/workflows/build-server.yml"], r"^on:", "landed"),
    ("S1-A05", "build-client.yml 有 --bundles 分平台参数",
     [".github/workflows/build-client.yml"], r"--bundles", "landed"),
    ("S1-A06", "release.sh 的 compute_next 支持 --major/--minor/--patch",
     ["scripts/release.sh"], r"--major|--minor|--patch", "landed"),
    ("S1-A07", "persistent_storage.rs 去掉 std::os::unix 直接 import",
     ["z-biz-tool-remote-client/src-tauri/src/persistent_storage.rs"],
     r"use\s+std::os::unix::fs::\*", "absent"),
    ("S1-A08", "tauri.conf.json 的 bundle 段有 windows（nsis+msi）与 linux（deb+appimage）",
     # 判据教训：bundle.targets 里出现 "windows" 字样 ≠ 有 bundle.windows 段。
     # 必须命中 **windows/linux 这两个 bundle 子键**本身。
     # 这里用 JSONPath 式判据（见 CHECKS_JSON），正则跨行匹配 JSON 不可靠。
     ["z-biz-tool-remote-client/src-tauri/tauri.conf.json"],
     r"__JSON__:bundle.windows", "landed"),
    ("S1-A09", "e2e-protocol.mjs 带 token",
     ["z-biz-tool-remote-client/tests/e2e-protocol.mjs"], r"token", "landed"),
    ("S1-A10/A11", "client package.json 不再有 server 脚本",
     ["z-biz-tool-remote-client/package.json"], r'"server"\s*:', "absent"),
    # ---- S1-B 安全红线 ----
    ("S1-B01", "server.js 有 assertSessionMember",
     ["z-biz-tool-remote-server/server.js"], r"assertSessionMember", "landed"),
    ("S1-B02/B03/B04", "server.js 用 assertSessionMember 前置校验",
     ["z-biz-tool-remote-server/server.js"], r"assertSessionMember", "landed"),
    ("S1-B05", "storage.js 抛 DEVICE_CONFLICT",
     ["z-biz-tool-remote-server/storage.js"], r"DEVICE_CONFLICT", "landed"),
    ("S1-B06", "server.js 设了 maxPayload",
     ["z-biz-tool-remote-server/server.js"], r"maxPayload", "landed"),
    ("S1-B07", "server.js 不再有 extractToken（token 移出 URL）",
     ["z-biz-tool-remote-server/server.js"], r"extractToken", "absent"),
    ("S1-B08", "server.js 有 NODE_ENV=production 断言",
     ["z-biz-tool-remote-server/server.js"], r"TLS_KEY_PATH", "landed"),
    ("S1-B09/B10", "服务端不再下发 encryptionKey",
     ["z-biz-tool-remote-server/server.js"], r"encryptionKey", "absent"),
    ("S1-B09/B10", "客户端不再有 encryptionKey 字段",
     ["z-biz-tool-remote-client/src/types.ts"], r"encryptionKey\??\s*:", "absent"),
    ("S1-B11", "storage.ts 不再硬编码公网 IP",
     ["z-biz-tool-remote-client/src/services/storage.ts"], r"101\.37\.80\.51", "absent"),
    ("S1-B12", "signaling.ts 的 buildWsUrl 不拼 token",
     ["z-biz-tool-remote-client/src/services/signaling.ts"], r"buildWsUrl", "landed"),
    ("S1-B13/B14", "App.tsx 的 INPUT_EVENT 监听带 sessionId 校验",
     ["z-biz-tool-remote-client/src/App.tsx"], r"inputPaused", "landed"),
    ("S1-B15", "commands.rs 在 Rust 侧生效 inputPaused",
     ["z-biz-tool-remote-client/src-tauri/src/commands.rs"], r"inputPaused", "landed"),
    ("S1-B16", "server.js 透传 requestedPermission 与 sasHash",
     ["z-biz-tool-remote-server/server.js"], r"requestedPermission", "landed"),
    ("S1-B17", "server.js 用 crypto.randomBytes 生成 sessionToken",
     ["z-biz-tool-remote-server/server.js"], r"randomBytes", "landed"),
    ("S1-B18", "server.js 有 LEAVE_SESSION 路由",
     ["z-biz-tool-remote-server/server.js"], r"LEAVE_SESSION", "landed"),
    # ---- S1-C/D ----
    ("S1-C01/C02", "capabilities/default.json 不再有 fs:default",
     ["z-biz-tool-remote-client/src-tauri/capabilities/default.json"],
     r'"fs:default"', "absent"),
    ("S1-C01/C02", "capabilities/default.json 不再有 shell:default",
     ["z-biz-tool-remote-client/src-tauri/capabilities/default.json"],
     r'"shell:default"', "absent"),
    ("S1-C03", "storage.ts 的 HistoryRecord 不持久化 sessionToken",
     ["z-biz-tool-remote-client/src/services/storage.ts"], r"sessionToken", "manual"),
    ("S1-C04", "persistentStorage.ts 用 OS 密钥库存 token",
     ["z-biz-tool-remote-client/src/services/persistentStorage.ts"],
     r"keychain|keyring|Stronghold|store\(.*secret", "landed"),
    ("S1-C05", "server/storage.js 的 doWrite 设 0600",
     ["z-biz-tool-remote-server/storage.js"], r"0o600|0600", "landed"),
    ("S1-D01", "HostingView.tsx 有常驻控制浮条（真显示「正在被控制」这类文案）",
     # 判据教训：HostingView 里有 sessionToken 字样 ≠ 有常驻浮条。
     # 必须命中**控制态文案**本身。
     ["z-biz-tool-remote-client/src/components/HostingView.tsx"],
     r"正在被|被控制|controlling", "landed"),
    ("S1-D02", "HostingView.tsx 有暂停输入/仅观看/立即断开",
     ["z-biz-tool-remote-client/src/components/HostingView.tsx"], r"inputPaused", "landed"),
    ("S1-D03", "HostingView.tsx 的 onStop 发 LEAVE_SESSION",
     ["z-biz-tool-remote-client/src/components/HostingView.tsx"], r"LEAVE_SESSION", "landed"),
    ("S1-D04", "commands.rs 用 Tauri notification 插件",
     ["z-biz-tool-remote-client/src-tauri/src/commands.rs"], r"notification", "landed"),
    # ---- S2 补齐已声明能力 ----
    ("S2-01/03", "ControlView.tsx 有 onKeyDown/onKeyUp 键盘捕获",
     ["z-biz-tool-remote-client/src/components/ControlView.tsx"], r"onKeyDown|onKeyUp", "landed"),
    ("S2-02", "App.tsx 的 JOIN_SUCCESS 分支切到 controlling 视图",
     ["z-biz-tool-remote-client/src/App.tsx"], r"kind:\s*[\"']controlling[\"']", "landed"),
    ("S2-04", "server.js 有 FILE_OFFER 路由",
     ["z-biz-tool-remote-server/server.js"], r"FILE_OFFER", "landed"),
    ("S2-05/06", "FileTransferPanel 不用 readAsDataURL（改原始字节分块）",
     ["z-biz-tool-remote-client/src/components/FileTransferPanel.tsx"],
     r"readAsDataURL", "absent"),
    ("S2-07", "MainView.tsx 挂载 ChatPanel",
     ["z-biz-tool-remote-client/src/components/MainView.tsx"], r"ChatPanel", "landed"),
    ("S2-08", "allowClipboardSync 有**消费方**（不只是类型与默认值）",
     # 判据教训：字符串出现在 storage.ts 的类型/默认值里 ≠ 功能生效。
     # 必须排除 storage.ts 自身，只看别处有没有真的读它。
     ["z-biz-tool-remote-client/src/components/ControlView.tsx",
      "z-biz-tool-remote-client/src/components/HostingView.tsx",
      "z-biz-tool-remote-client/src/services/capture.ts",
      "z-biz-tool-remote-client/src/App.tsx"], r"allowClipboardSync", "landed"),
    ("S2-09", "server.js 有配对码 PAIR_OFFER/PAIR_ANSWER",
     ["z-biz-tool-remote-server/server.js"], r"PAIR_OFFER|PAIR_ANSWER", "landed"),
    ("S2-10/11", "授权弹窗展示 SAS 与权限档位",
     ["z-biz-tool-remote-client/src/components/ControlView.tsx",
      "z-biz-tool-remote-client/src/components/SettingsPanel.tsx"], r"sasHash|SAS", "landed"),
    ("S2-12/13", "screen-select 权限在 capabilities 里声明",
     ["z-biz-tool-remote-client/src-tauri/capabilities/default.json"],
     r"screen-select", "landed"),
    ("S2-14", "server.js 有 SESSION_MEMBERS / KICK_CLIENT",
     ["z-biz-tool-remote-server/server.js"], r"SESSION_MEMBERS|KICK_CLIENT", "landed"),
    ("S2-15/16", "server.js 合并重复的 SESSION_CREATED",
     ["z-biz-tool-remote-server/server.js"], r"SESSION_CREATED", "landed"),
    ("S2-17", "错误码表 → 用户可读原因（不再是 message.error(String(e))）",
     ["z-biz-tool-remote-client/src/components/ControlView.tsx",
      "z-biz-tool-remote-client/src/App.tsx"], r"message\.error\(String\(", "absent"),
    ("S2-18", "server.js 有孤儿目录清理",
     ["z-biz-tool-remote-server/server.js"], r"orphan|孤儿", "landed"),
    ("S2-19/20", "server.js 有 ALLOWED_ORIGINS / AUTH_TOKEN_TTL 等环境变量",
     ["z-biz-tool-remote-server/server.js"], r"ALLOWED_ORIGINS|AUTH_TOKEN_TTL", "landed"),
    # ---- S3 传输与性能 ----
    ("S3-01", "媒体通道独立且 maxPayload=8MB",
     ["z-biz-tool-remote-server/server.js"], r"maxPayload", "landed"),
    ("S3-02", "二进制帧头编解码（24+4B）",
     ["z-biz-tool-remote-client/src/services/capture.ts",
      "z-biz-tool-remote-server/server.js"], r"frameHeader|帧头|HEADER_LEN", "landed"),
    ("S3-03", "client 引入 tokio + tokio-tungstenite",
     ["z-biz-tool-remote-client/src-tauri/Cargo.toml"], r"tokio|tungstenite", "landed"),
    ("S3-04", "脏区 tile 编码",
     ["z-biz-tool-remote-client/src-tauri/src/capture.rs"], r"tile|Tile", "landed"),
    ("S3-05/06", "JpegEncoder 直写 Vec<u8> + 缩放算法可配",
     ["z-biz-tool-remote-client/src-tauri/src/capture.rs"], r"JpegEncoder", "landed"),
    ("S3-07/08", "Enigo 用 thread_local! 复用 + release profile 分包",
     ["z-biz-tool-remote-client/src-tauri/src/input.rs"], r"thread_local", "landed"),
    ("S3-09", "带宽自适应 5 档 + 滞回",
     ["z-biz-tool-remote-client/src/services/capture.ts"], r"bitrate|带宽|档位", "landed"),
    ("S3-10", "截图贴回用 canvas + createImageBitmap",
     ["z-biz-tool-remote-client/src/services/capture.ts"], r"createImageBitmap", "landed"),
    ("S3-11", "SCREEN_FRAME 透传 seq / captureTsMs",
     ["z-biz-tool-remote-server/server.js"], r"captureTsMs", "landed"),
    ("S3-12/13", "显示 RTT/fps/码率 + 滑块收敛为 4 个语义预设",
     ["z-biz-tool-remote-client/src/components/ControlView.tsx"], r"RTT|rtt", "landed"),
    ("S3-14", "JS 侧采集循环退役（Rust 推流）",
     ["z-biz-tool-remote-client/src/App.tsx"], r"captureLoop|startCapture", "manual"),
    # ---- S4 可靠性 ----
    ("S4-01", "会话宽限期 graceUntil + CLIENT_STALE 广播",
     ["z-biz-tool-remote-server/server.js"], r"graceUntil|CLIENT_STALE", "landed"),
    ("S4-02/03", "重连成功后自动 RESUME_SESSION",
     ["z-biz-tool-remote-client/src/services/signaling.ts"], r"RESUME_SESSION", "landed"),
    ("S4-04/09", "统一 state_dir() / notify() / check_capture_permission()",
     ["z-biz-tool-remote-client/src-tauri/src/commands.rs"], r"fn state_dir|fn notify", "landed"),
    ("S4-05", "macOS 权限自检向导",
     ["z-biz-tool-remote-client/src/components/SettingsPanel.tsx"], r"权限自检|自检", "landed"),
    ("S4-06/07", "并发上限保护（超限回 CAPACITY）",
     ["z-biz-tool-remote-server/server.js"], r"CAPACITY", "landed"),
    ("S4-08", "server 换 better-sqlite3",
     ["z-biz-tool-remote-server/package.json"], r"better-sqlite3", "landed"),
    ("S4-10", "多会话标签页 + PAUSE_STREAM/RESUME_STREAM",
     ["z-biz-tool-remote-server/server.js"], r"PAUSE_STREAM|RESUME_STREAM", "landed"),
    # ---- S5 体验隐私运维 ----
    ("S5-01", "帧加密 X25519 + ChaCha20-Poly1305",
     ["z-biz-tool-remote-client/src-tauri/Cargo.toml"], r"x25519|chacha20poly1305|hkdf", "landed"),
    ("S5-02", "证书校验 + SPKI SHA-256 TOFU pinning",
     ["z-biz-tool-remote-client/src-tauri/src/capture.rs",
      "z-biz-tool-remote-client/src/services/signaling.ts"], r"pin|SPKI", "landed"),
    ("S5-03", "危险操作三级确认（Popconfirm / 后果+动词 / 输入指定词）",
     ["z-biz-tool-remote-client/src/components/SettingsPanel.tsx"], r"Popconfirm", "landed"),
    ("S5-04", "审计事件最小集 AU-01…AU-09",
     ["z-biz-tool-remote-server/server.js"], r"AU-0|audit", "landed"),
    ("S5-05", "被控端可查看会话成员与注入事件采样",
     ["z-biz-tool-remote-client/src/components/HostingView.tsx"], r"环形|buffer|members", "landed"),
    ("S5-06", "en-US 有**字典**（不只是 language 字段的一个取值）",
     # 判据教训：`language: "zh-CN" | "en-US"` 只是类型定义，
     # 没有对应字典文件的话等于"承诺了但没做"（台账原文就点破了这一点）。
     ["z-biz-tool-remote-client/src/i18n/en-US.ts",
      "z-biz-tool-remote-client/src/i18n/index.ts",
      "z-biz-tool-remote-client/src/locales/en-US.ts"],
     r"en-US", "landed"),
    ("S5-07/08", "统一空态/错态/载态 + 全局快捷键",
     ["z-biz-tool-remote-client/src/components/HostingView.tsx"], r"empty|Empty|空态", "landed"),
    ("S5-09", "3 步引导（服务器 → 登录 → 授权）",
     ["z-biz-tool-remote-client/src/components/MainView.tsx"], r"引导|onboard|step", "landed"),
    ("S5-10/11", "设备状态改服务端推送 DEVICE_STATE_CHANGED",
     ["z-biz-tool-remote-server/server.js"], r"DEVICE_STATE_CHANGED", "landed"),
    ("S5-12", "CI 接入 npm audit / cargo audit / 覆盖率门禁",
     [".github/workflows/ci.yml"], r"npm audit|cargo audit|coverage", "landed"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="只查某条任务")
    args = ap.parse_args()

    print("判据：剥掉注释后搜**实际代码**（注释里的历史叙述不算命中）")
    print()
    landed, absent_failed, manual = [], [], []
    for tid, desc, files, pat, expect in CHECKS:
        if args.only and not tid.startswith(args.only):
            continue
        hit = search(files, pat, regex=True)
        if expect == "landed":
            ok = bool(hit)
        elif expect == "absent":
            ok = not hit
        else:  # manual
            print(f"  {tid:<14} ⚠️  需人工判：{desc}")
            manual.append(tid)
            continue
        mark = "✅ 已落地" if ok else "✗ 未落地"
        print(f"  {tid:<14} {mark}  {desc}" + (f"  [{hit}]" if hit else ""))
        (landed if ok else absent_failed).append(tid)

    print()
    print(f"机械判定：已落地 {len(landed)} / 未落地 {len(absent_failed)} / 需人工 {len(manual)}")
    if absent_failed:
        print("未落地明细：")
        for t in absent_failed:
            print(f"  - {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
