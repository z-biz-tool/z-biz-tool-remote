// 键位映射单测（台账 C-01 / S2-01：远程键盘输入）
//
// 为什么值得单独测：这张表是**跨语言契约**——TS 发什么名字，决定 Rust
// `input.rs::map_key()` 能不能认出来。发错了不会报类型错，只会在用户打字时
// 静默丢键（Rust 侧返回「未知键」），而这正是本仓此前「远程无法打字」的根因。
import { test } from "node:test";
import assert from "node:assert/strict";

import { codeToKeyName, shouldCaptureKey } from "../src/services/keymap.ts";

test("字母与数字用物理键位，不受大小写/布局影响", () => {
  assert.equal(codeToKeyName("KeyA"), "a");
  assert.equal(codeToKeyName("KeyZ"), "z");
  assert.equal(codeToKeyName("Digit0"), "0");
  assert.equal(codeToKeyName("Digit9"), "9");
  assert.equal(codeToKeyName("Numpad7"), "7");
});

test("修饰键与编辑键映射成 input.rs 认的名字", () => {
  assert.equal(codeToKeyName("ShiftLeft"), "shift");
  assert.equal(codeToKeyName("ControlRight"), "ctrl");
  assert.equal(codeToKeyName("AltLeft"), "alt");
  assert.equal(codeToKeyName("MetaRight"), "meta");
  assert.equal(codeToKeyName("Enter"), "enter");
  assert.equal(codeToKeyName("NumpadEnter"), "enter");
  assert.equal(codeToKeyName("Backspace"), "backspace");
  assert.equal(codeToKeyName("ArrowUp"), "arrowup");
  assert.equal(codeToKeyName("PageDown"), "pagedown");
  assert.equal(codeToKeyName("CapsLock"), "capslock");
});

test("符号区落到单字符（Rust 侧走 Key::Unicode）", () => {
  assert.equal(codeToKeyName("Minus"), "-");
  assert.equal(codeToKeyName("Comma"), ",");
  assert.equal(codeToKeyName("Slash"), "/");
  assert.equal(codeToKeyName("Backslash"), "\\");
  assert.equal(codeToKeyName("Backquote"), "`");
});

test("F1–F12 有映射，F13 不乱发", () => {
  assert.equal(codeToKeyName("F1"), "f1");
  assert.equal(codeToKeyName("F12"), "f12");
  assert.equal(codeToKeyName("F13"), null);
});

test("Rust 不支持的键返回 null（不制造一次注定失败的注入）", () => {
  assert.equal(codeToKeyName("Insert"), null);
  assert.equal(codeToKeyName("PrintScreen"), null);
  assert.equal(codeToKeyName("AudioVolumeUp"), null);
  assert.equal(codeToKeyName(""), null);
  assert.equal(shouldCaptureKey("Insert"), false);
  assert.equal(shouldCaptureKey("KeyA"), true);
});

test("绝不把 e.code 原样透传（那是旧实现的坑）", () => {
  for (const code of ["KeyA", "Digit1", "ArrowUp", "ShiftLeft"]) {
    const mapped = codeToKeyName(code);
    assert.ok(mapped && mapped !== code, `${code} 被原样透传了`);
  }
});
