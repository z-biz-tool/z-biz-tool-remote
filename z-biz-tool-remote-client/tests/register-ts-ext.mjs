// 让 `node --test` 能加载内部用无扩展名相对 import 的 TS 源文件。
//
// 背景：src/services/signaling.ts 内部写的是 `from "./backoff"`（无 .ts），
// 这是 TS + bundler 世界的正常写法，但 Node 的 ESM 解析器要求显式扩展名。
// 既有 tests/pure.test.ts 之所以没撞上，是因为它只 import 了 telemetry.ts ——
// 那个文件没有内部相对 import。import signaling.ts 就必然撞上。
//
// 为什么不改源码加 .ts 后缀：那会让 tsc/vite/tsc --noEmit 的既有配置与
// bundler 解析路径全都要跟着核对，属于为迁就测试而改产品代码。此处用解析钩子
// 在**加载期**补扩展名，源码一个字不动。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(pathToFileURL("./tests/ts-ext-resolver.mjs"));
