# z-biz-tool-remote

跨平台远程控制工具，基于 WebSocket 信令服务器。

## 目录结构

- `z-biz-tool-remote-client/` - Tauri 桌面客户端（主机/控制端）
- `z-biz-tool-remote-server/` - WebSocket 信令服务器

## 快速开始

### 启动服务器
```bash
cd z-biz-tool-remote-server
npm install
npm start
```

### 构建客户端
```bash
cd z-biz-tool-remote-client
npm install
npm run tauri:dev   # 开发模式
npm run tauri:build # 打包
```