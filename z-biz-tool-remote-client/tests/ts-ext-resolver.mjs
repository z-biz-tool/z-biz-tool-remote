// 加载期补 .ts 扩展名：父 URL 解析不出扩展名时，按 .ts 重试一次。
// 只处理「无扩展名」这一种情况；带 .ts/.js/.json 的原样放过。
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!specifier.startsWith(".") || !context.parentURL) throw err;
    // 只对「相对路径 + 没有已知扩展名」补后缀
    if (/\.[cm]?[jt]sx?$|\.json$|\.css$|\.node$/.test(specifier)) throw err;
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const candidate = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    throw err;
  }
}
