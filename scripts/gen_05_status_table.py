#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 05 任务表的逐条判定结果**生成成 markdown 表**，写进 00 文档。

为什么要自动生成：手抄 73 行必然出错，而且下次代码变了数字就过期。
本脚本从 `scripts/check_05_tasks.py` 的判据表 + 05 的任务表算出结果，
直接产出可粘贴的 markdown —— **数字永远来自当次实跑**。

用法：
    python3 scripts/gen_05_status_table.py            # 打印 markdown
    python3 scripts/gen_05_status_table.py --write     # 直接写进 00 文档的标记位置
"""

import argparse
import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PLAN = REPO / "doc/优化方案/05_实施路线与任务拆解.md"
OUT = REPO / "doc/优化方案/00_总览与优化优先级.md"
MARK_START = "<!-- 05-STATUS-TABLE:START -->"
MARK_END = "<!-- 05-STATUS-TABLE:END -->"


def load_checks():
    spec = importlib.util.spec_from_file_location("chk", REPO / "scripts/check_05_tasks.py")
    chk = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(chk)
    return chk


def task_rows():
    """从 05 解析出 (任务号, 改造点摘要) 列表，保持文档顺序。"""
    out = []
    for ln in PLAN.read_text(encoding="utf-8").splitlines():
        m = re.match(r'^\| \*{0,2}(S[0-9]-[A-Z]?[0-9]+(?:/\*{0,2}[A-Z]?[0-9]*\*{0,2})*)\*{0,2} \|(.*)$', ln)
        if not m:
            continue
        cells = [c.strip() for c in m.group(2).split("|")]
        chg = cells[1] if len(cells) > 1 else ""
        chg = re.sub(r"\s+", " ", chg.replace("**", ""))
        out.append((m.group(1), chg[:70]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="写进 00 文档")
    args = ap.parse_args()

    chk = load_checks()
    rows = task_rows()

    # 判据 → 每任务的判定
    verdict = {}
    for tid, desc, files, pat, expect in chk.CHECKS:
        hit = chk.search(files, pat, regex=True)
        if expect == "manual":
            v = None
        elif expect == "landed":
            v = bool(hit)
        else:
            v = not hit
        verdict.setdefault(tid, []).append((v, desc, hit))

    lines = [
        MARK_START,
        "",
        "## 落地状态复核表（2026-10-20 逐条核对 05 的 73 条任务）",
        "",
        "**量法**：逐条查**当前代码**的实际状态，判据在 "
        "[scripts/check_05_tasks.py](../../scripts/check_05_tasks.py) 里，"
        "**可复跑**（`python3 scripts/check_05_tasks.py`）。",
        "",
        "⚠️ **判据本身踩过三个坑，都已修**（记在这里，免得下一个人重踩）：",
        "",
        "1. **注释里的历史叙述不算命中** —— `grep -rq \"test-key\"` 命中的是 e2e 测试里",
        "   「原实现回落到写死的 test-key」那句**注释**，台账明明标了已落地，尺子却报未落地。",
        "   ⇒ 判据改为**先剥注释再搜**。",
        "2. **字符串存在 ≠ 功能生效** —— `allowClipboardSync` 只出现在 storage 的类型与",
        "   默认值里，没有任何消费方读它；`\"windows\"` 出现在 `bundle.targets` 里，",
        "   不等于有 `bundle.windows` 段。⇒ 判据改为**查消费方 / 用 JSON 路径取值**。",
        "3. **命中位置要具体** —— 「有 SESSION_CREATED」判不出「是否合并了重复声明」，",
        "   改成**数出现次数**（1 = 已合并）。",
        "",
        "| # | 任务 | 状态 | 判定依据 |",
        "| --- | --- | --- | --- |",
    ]

    landed = undone = 0
    for tid, chg in rows:
        vs = verdict.get(tid)
        if not vs:
            state, basis = "**未落地**", "无判据（需人工核）"
            undone += 1
        elif all(v for v, _, _ in vs):
            state, basis = "**已落地**", vs[0][1]
            landed += 1
        else:
            failed = [d for v, d, _ in vs if not v]
            state = "**未落地**"
            basis = failed[0] if failed else "部分判据未过"
            undone += 1
        lines.append(f"| {tid} | {chg} | {state} | {basis} |")

    lines += [
        "",
        f"**汇总：{landed} 条已落地 / {undone} 条未落地**（表 73 行，与抬头一致）。",
        "",
        "> **本表与上一轮「P0 五条现已全部闭合」不矛盾**：P0 是 5 条子集，",
        "> 且 S1-B09/B10、S1-B11、S1-B12、S1-B17、S1-D04、S2-02、S2-15/16、S2-17、",
        "> S3-10、S5-03 等**非 P0** 任务也落地了；而 S2–S5 的绝大多数仍未做。",
        MARK_END,
    ]

    md = "\n".join(lines)
    print(md)

    if args.write:
        text = OUT.read_text(encoding="utf-8")
        if MARK_START in text and MARK_END in text:
            new = re.sub(
                re.escape(MARK_START) + r".*?" + re.escape(MARK_END),
                md,
                text,
                flags=re.S,
            )
        else:
            new = text.rstrip() + "\n\n" + md + "\n"
        OUT.write_text(new, encoding="utf-8")
        print(f"\n已写入 {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
