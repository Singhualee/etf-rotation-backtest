#!/usr/bin/env python3
"""ci_check_build.py — 校验「用当前源码重新构建出的产物」与「仓库里已提交的产物」一致。

动机: app-pro.html / engine.js / data.js 改动后忘记跑 build_pro.py 是很常见的疏漏,
     而产物又是唯一交付物 —— 一旦脱节, 用户打开的就是旧页面, 测试却仍然全绿。
     本脚本把这种疏漏在 CI 上直接拦下来。

用法: 先跑 `python3 build_pro.py`, 再跑本脚本(CI 里就是这么做的)。

注意: 产物头部有一行"由 build_pro.py 生成于 YYYY-MM-DD HH:MM"构建时间戳,
     每次构建都不同, 因此比对前把它归一化成占位符再逐字节比较, 其余部分必须完全相同。
"""
import os
import re
import subprocess
import sys

DIR = os.path.dirname(os.path.abspath(__file__))
REL = "ETF动量轮动回测Pro.html"          # 仓库内的相对路径(提交与工作区共用)
OUT = os.path.join(DIR, REL)

TS_RE = re.compile(r"由 build_pro\.py 生成于 [\d\-]+ [\d:]+")


def normalize(s):
    return TS_RE.sub("由 build_pro.py 生成于 <ts>", s)


def main():
    if not os.path.exists(OUT):
        print(f"FAIL 未找到构建产物 {REL}, 请先运行 python3 build_pro.py")
        return 1

    # 取仓库中 HEAD 的版本(CI 里刚 checkout, 工作区的产物已被 build_pro.py 覆盖)
    r = subprocess.run(
        ["git", "show", f"HEAD:{REL}"],
        cwd=DIR, capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        print(f"FAIL 无法从 git 读取 {REL}: {r.stderr.strip()}")
        return 1

    built = normalize(open(OUT, encoding="utf-8").read())
    committed = normalize(r.stdout)

    if built == committed:
        print(f"OK 产物与源码一致 ({len(built) / 1024:.0f} KB)")
        return 0

    print("FAIL 构建产物与仓库中已提交的版本不一致")
    print("     说明 app-pro.html / engine.js / data.js 有改动, 但产物没重建。")
    print("     请在本地执行:  python3 build_pro.py")
    print("     然后把 ETF动量轮动回测Pro.html 一并提交。")

    # 给出第一处差异的位置, 便于定位
    for i, (a, b) in enumerate(zip(built, committed)):
        if a != b:
            lo = max(0, i - 60)
            print(f"     首处差异在第 {i} 字符附近:")
            print(f"       构建版: ...{built[lo:i + 60]!r}")
            print(f"       提交版: ...{committed[lo:i + 60]!r}")
            break
    else:
        print(f"     长度不同: 构建版 {len(built)} 字符 / 提交版 {len(committed)} 字符")
    return 1


if __name__ == "__main__":
    sys.exit(main())
