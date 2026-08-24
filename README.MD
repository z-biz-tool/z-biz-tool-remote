# z-biz-tool-remote

> 跨平台远程控制桌面客户端 — 基于 Tauri 2 重写的 TeamViewer-like 应用

![tech](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri)
![tech](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![tech](https://img.shields.io/badge/AntD-6-0170FE?logo=antdesign)
![tech](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![tech](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust)
![tech](https://img.shields.io/badge/xcap-0.9-orange)
![tech](https://img.shields.io/badge/enigo-0.3-orange)
![tech](https://img.shields.io/badge/ws-8.18-green)

跨平台远程控制桌面客户端，参照同仓库 `z-biz-tool-*` 系列（Tauri 2 + React 19 + Vite + Rust）的项目结构改造自原 Electron 版。

## 功能

- **被控（Host）**：创建一个会话，把会话 ID + 令牌交给控制方，本机屏幕被实时编码为 JPEG 通过信令服务器转发。
- **控制（Client）**：加入会话后向目标设备请求控制，同意后看到对方屏幕画面，鼠标/键盘事件被转发到对端。
- **设置**：信令服务器地址、画面质量（JPEG）、帧率、剪贴板/文件权限、自动重连间隔等。
- **信任设备**：被信任设备发起控制请求时自动放行。
- **剪贴板同步**（v1 通过 `key-type` 事件走键盘注入）。

## 协议

信令层 WebSocket 消息格式与原 Electron 客户端兼容，可复用原有 Node 信令服务器（`server.js`）。客户端与信令服务器之间的消息类型见 `src/types.ts`。

## 架构

```
src/                   React 前端（Vite）
  main.tsx             入口
  App.tsx              根组件 + 信令事件路由
  components/          视图：登录/主页/被控/控制
  stores/              zustand 状态
  services/
    signaling.ts       WebSocket 客户端（封装/重连）
    capture.ts         截屏循环（按 fps 调度）
    storage.ts         localStorage 包装
  types.ts             协议消息类型
  i18n.ts              文案

src-tauri/             Rust 后端
  src/
    main.rs            入口
    lib.rs             Tauri Builder、注册插件和命令
    commands.rs        Tauri 命令：capture_screen / list_displays / simulate_input / get_app_info
    capture.rs         截屏：xcap 0.9 + image 0.25（JPEG 编码）
    input.rs           键鼠注入：enigo 0.3（每次新建 Enigo，避开 macOS 的 !Send 限制）
  Cargo.toml           依赖：tauri 2、tauri-plugin-{clipboard-manager,dialog,fs,shell}、xcap、enigo
  tauri.conf.json      窗口/打包配置
  capabilities/        Tauri 2 权限
```

## 开发

```bash
# 装依赖
npm install

# 开发模式（前端 + Tauri 自动重启）
npm run tauri:dev

# 类型检查
npm run typecheck

# 只打前端
npm run build

# 出 .app（不打 DMG，快）
npm run tauri:build

# 出 macOS DMG
npm run tauri:build:dmg
```

## 产物

`src-tauri/target/release/bundle/dmg/z-biz-tool-remote_0.1.0_aarch64.dmg`

挂载后把 `z-biz-tool-remote.app` 拖到 `/Applications` 即可。**首次启动需要右键 → 打开**绕过未签名 Gatekeeper。

## 已知限制

- 截屏走的是「JS 调度 → Rust 截屏 → JPEG → JS 通过 WS 转发」的同步循环，FPS 较高时 IPC 会有一定开销。如果要更高的帧率或更稳定的表现，可改成 Rust 端起 tokio 循环并通过 Tauri event 直接推给前端。
- 第一次建立远程控制时，被控端会弹一个确认对话框（如开启 `requirePermission`）。信任列表中的设备会跳过。
- 没有做代码签名，多用户分发时需要自行处理 Gatekeeper。
- 信令服务器需要单独部署，原来的 Node 实现可以继续用；只要满足本项目里 `src/types.ts` 的协议即可。
