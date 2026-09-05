// 极简 i18n：当前仅中文，预留 key 以便后续扩展
type Dict = Record<string, string>;

const zh: Dict = {
  "app.title": "z-biz-tool-remote",
  "app.subtitle": "跨平台远程控制",
  "header.connected": "已连接",
  "header.connecting": "连接中…",
  "header.offline": "未连接",
  "header.device": "本机ID",
  "login.title": "连接到信令服务器",
  "login.server": "信令服务器",
  "login.connect": "连接",
  "login.disconnect": "断开",
  "login.autoConnect": "启动时自动连接",
  "main.devices": "在线设备",
  "main.refresh": "刷新",
  "main.createSession": "创建会话（成为被控端）",
  "main.joinSession": "加入会话",
  "main.sessionId": "会话ID",
  "main.sessionToken": "会话令牌",
  "main.join": "加入",
  "main.requestControl": "请求控制",
  "main.trust": "信任此设备",
  "main.untrust": "取消信任",
  "main.empty": "暂无在线设备",
  "hosting.title": "正在被远程控制",
  "hosting.shareHint": "将会话ID和令牌发给控制方",
  "hosting.stop": "结束会话",
  "control.title": "远程控制中",
  "control.disconnect": "断开",
  "control.pause": "暂停画面",
  "control.resume": "继续画面",
  "control.sendClipboard": "同步剪贴板",
  "control.empty": "等待主机画面…",
  "settings.title": "设置",
  "settings.server": "信令服务器",
  "settings.quality": "画面质量 (JPEG)",
  "settings.fps": "帧率",
  "settings.lang": "语言",
  "settings.security": "安全",
  "settings.requirePermission": "需要用户确认才能被控制",
  "settings.clipboardSync": "允许剪贴板同步",
  "settings.fileTransfer": "允许文件传输",
  "settings.chat": "允许聊天",
  "settings.monitor": "共享显示器",
  "settings.reconnect": "重连间隔 (ms)",
  "settings.save": "保存",
  "dialog.controlRequest": "设备 {id} 请求控制你的电脑",
  "dialog.accept": "允许",
  "dialog.reject": "拒绝",
  "toast.connected": "已连接到信令服务器",
  "toast.connectFailed": "连接失败:服务端拒绝(检查 token/URL)",
  "toast.disconnected": "已断开",
  "toast.connectedAs": "本机 ID: {id}",
  "toast.hosting": "已创建会话: {id}",
  "toast.controlling": "已加入会话，正在控制 {id}",
  "toast.rejected": "对方拒绝了你的控制请求",
  "toast.failed": "操作失败: {msg}",
  "toast.copied": "已复制",
  "toast.noServer": "未配置信令服务器",
  "toast.notHosting": "当前不是被控状态",
  "toast.notControlling": "当前没有控制会话",
  "toast.notOnline": "目标设备不在线",
  "errors.permissionDenied": "用户拒绝",
  "chat.empty": "暂无消息",
  "chat.placeholder": "输入消息...",
  "chat.me": "我",
  "chat.remote": "对方",
  "fileTransfer.title": "文件传输",
  "fileTransfer.send": "发送文件",
  "fileTransfer.receive": "待接受的文件",
  "fileTransfer.progress": "传输进度",
};

type Vars = Record<string, string | number>;

export function t(key: string, vars?: Vars): string {
  let s = zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

export type Lang = "zh-CN";
export const LANG: Lang = "zh-CN";
