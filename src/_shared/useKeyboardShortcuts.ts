import { useEffect } from "react";

export interface ShortcutSpec {
  /** 主键（如 "k"、"ArrowLeft"） */
  key: string;
  /** 是否需要修饰键（默认不区分大小写，组合键以当前 isMeta/isCtrl/isShift/isAlt 匹配） */
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** 触发时的回调 */
  handler: (e: KeyboardEvent) => void;
  /** 是否允许在输入控件聚焦时触发，默认 false */
  allowInInput?: boolean;
  /** 阻止默认行为，默认 true */
  preventDefault?: boolean;
  /** 描述（用于快捷键面板） */
  description?: string;
}

/**
 * 判断当前焦点是否处于可输入控件内（input/textarea/contenteditable）
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function matchSpec(spec: ShortcutSpec, e: KeyboardEvent): boolean {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  if (!!spec.meta !== e.metaKey) return false;
  if (!!spec.ctrl !== modKey) return false;
  if (!!spec.shift !== e.shiftKey) return false;
  if (!!spec.alt !== e.altKey) return false;

  // 主键匹配（大小写不敏感 + 支持 " "、"Escape" 等）
  const wanted = spec.key.length === 1 ? spec.key.toLowerCase() : spec.key;
  const actual = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return wanted === actual;
}

/**
 * 全局快捷键 hook。
 * - 焦点在输入控件时默认不响应（可单独覆盖 allowInInput）
 * - 自动 preventDefault（可关闭）
 */
export function useKeyboardShortcuts(specs: ShortcutSpec[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const inEditable = isEditableTarget(e.target);
      for (const spec of specs) {
        if (!matchSpec(spec, e)) continue;
        if (inEditable && !spec.allowInInput) continue;
        if (spec.preventDefault !== false) e.preventDefault();
        spec.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [specs, enabled]);
}

/**
 * 将快捷键规格渲染为可读的键位提示（如 "⌘ + Shift + L"）
 */
export function formatShortcut(spec: ShortcutSpec): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const parts: string[] = [];
  if (spec.meta || spec.ctrl) parts.push(isMac ? "⌘" : "Ctrl");
  if (spec.alt) parts.push(isMac ? "⌥" : "Alt");
  if (spec.shift) parts.push(isMac ? "⇧" : "Shift");
  let key = spec.key;
  if (key === " ") key = "Space";
  if (key === "ArrowLeft") key = "←";
  if (key === "ArrowRight") key = "→";
  if (key === "ArrowUp") key = "↑";
  if (key === "ArrowDown") key = "↓";
  if (key === "Escape") key = "Esc";
  if (key === "Enter") key = "⏎";
  if (key === "Backspace") key = "⌫";
  parts.push(key);
  return parts.join(" + ");
}