/**
 * zbiz:// 深链接的 **remote 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|------|--------|
 * | 协议 | `z-biz-tool-shared/protocol` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol` 的 `startDeepLinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 remote 该做什么** |
 *
 * ## remote 支持的动作
 *
 * | action | 含义 |
 * |--------|------|
 * | `open` | 唤到前台（缺省 action）。无参数时纯唤起，不报错 |
 *
 * ## 支持的参数
 *
 * | 参数 | 作用 |
 * |------|------|
 * | `device` | 设备 ID 或设备名：切到主界面并把设备列表搜索框填成它，**只定位，不发起控制** |
 * | `from`  | 发送方，仅用于日志与回执 |
 *
 * ## 两个刻意的「不」
 *
 * 1. **不自动发起控制请求**（`requestControl`）。
 *    深链是外部可触发的入口：一条网页链接就能让本机向另一台机器发起接管，
 *    而对端若设了「无需确认」或已信任本机，会**直接被接管屏幕与键鼠**。
 *    权限升级动作必须由用户在设备列表里点一下 —— 深链只负责把人和设备凑到一起。
 *
 * 2. **不接受 `session` / `token` 参数**。
 *    本仓台账已裁定「令牌不走 URL 查询串」（查询串会进历史、access_log、抓包、截图），
 *    深链的 query 与 WS URL 的 query 同样会落到这些地方，
 *    所以会话加入请在主界面手动粘贴会话 ID 与令牌。
 *    这里显式报 problem 而不是忽略 —— 忽略就是「点了没反应」。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * remote 的深链结果。
 *
 * `deviceQuery` 非 null 表示要定位到那台设备；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface RemoteDeepLinkOutcome {
  /** 要定位的设备（ID 或名称）；null 表示不带定位意图（纯唤起） */
  deviceQuery: string | null;
  /** 发送方（from），仅用于提示与日志 */
  from: string | null;
  /** 无法适配时的原因 */
  problem: string | null;
}

/** 会话类参数一律拒绝 —— 与本仓「令牌不走查询串」的裁定一致 */
const SESSION_PARAM_REJECTED =
  "会话 ID/令牌不走深链（链接会进历史与日志）：请打开本应用，在「加入会话」里手动填写";

/**
 * 把一条深链翻译成 remote 内的动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolveRemoteDeepLink(item: Handoff): RemoteDeepLinkOutcome {
  const outcome: RemoteDeepLinkOutcome = {
    deviceQuery: null,
    from: item.params.from ?? null,
    problem: null,
  };

  const action = item.action.trim() || "open";
  if (action !== "open") {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  // 会话类参数：给出来就必须说清楚为什么不行，不能默默丢掉
  const session = item.params.session?.trim() ?? "";
  const token = item.params.token?.trim() ?? "";
  if (session || token) {
    outcome.problem = SESSION_PARAM_REJECTED;
    return outcome;
  }

  const device = item.params.device?.trim() ?? "";
  if (device) outcome.deviceQuery = device;

  return outcome;
}
