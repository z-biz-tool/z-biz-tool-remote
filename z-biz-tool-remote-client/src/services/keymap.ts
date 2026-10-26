// 物理键位 → 被控端键名。
//
// 为什么不是把 `KeyboardEvent.key` 直接发过去：
//   · `key` 受布局/输入法/修饰键影响（AZERTY 上 z 与 w 互换、Shift 后变成大写字母、
//     输入法激活时变成 "Process"），远端会打错字；
//   · 物理键位 `code`（KeyA / Digit1 / ArrowUp）稳定，但 Rust 侧
//     `input.rs::map_key()` 认的是 "a"/"1"/"arrowup" 这类名字 ——
//     直接把 e.code 丢过去会全部落空（map_key 返回 None → 注入报错）。
// 所以这一层是**协议适配**，两端各测各的：这里测映射表，Rust 侧测 map_key。
//
// 返回 null = 这个键不往远端发（本机没有对应实现，硬发只会得到一次注入失败）。
export function codeToKeyName(code: string): string | null {
  if (!code) return null;

  // 字母 / 数字
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];

  // 符号区（与 input.rs 的「单字符 → Key::Unicode」分支对齐）
  const punctuation: Record<string, string> = {
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    NumpadAdd: "+",
    NumpadSubtract: "-",
    NumpadMultiply: "*",
    NumpadDivide: "/",
    NumpadDecimal: ".",
  };
  if (punctuation[code]) return punctuation[code];

  // 特殊键（名字必须与 input.rs::map_key 的匹配臂一致）
  const special: Record<string, string> = {
    Enter: "enter",
    NumpadEnter: "enter",
    Tab: "tab",
    Escape: "escape",
    Backspace: "backspace",
    Delete: "delete",
    Space: "space",
    ShiftLeft: "shift",
    ShiftRight: "shift",
    ControlLeft: "ctrl",
    ControlRight: "ctrl",
    AltLeft: "alt",
    AltRight: "alt",
    MetaLeft: "meta",
    MetaRight: "meta",
    CapsLock: "capslock",
    ArrowUp: "arrowup",
    ArrowDown: "arrowdown",
    ArrowLeft: "arrowleft",
    ArrowRight: "arrowright",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
  };
  if (special[code]) return special[code];

  const fn = /^F([1-9]|1[0-2])$/.exec(code);
  if (fn) return `f${fn[1]}`;

  // Insert / PrintScreen / 媒体键…：Rust 侧无对应 variant，宁可不发也不发半截
  return null;
}

/** 这个键是否应当被本地 `preventDefault` 拦下（拦了才不会触发浏览器/系统快捷键）。 */
export function shouldCaptureKey(code: string): boolean {
  return codeToKeyName(code) !== null;
}
