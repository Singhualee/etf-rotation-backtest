#!/usr/bin/env python3
"""build_pro.py — 把 echarts.min.js / data.js / engine.js 内联进 app-pro.html,
生成 Pro 版的单文件交付物。

Pro 页面默认档位: 周五调仓 + 25 日动量 + 波动率目标 18% + 避险开启 + 成本 0.1%
(参数由页面控件读取, 此处只是说明默认值; 改动须与 需求规格说明书.md §8.2 及
 make_smoke_pro.py 里的 PRO_OPTS 保持一致, 否则测试期望值会与页面默认不符)"""
import os
import datetime as dt

# 脚本自身所在目录: 不写死绝对路径, 便于在 CI/其他机器上直接运行
DIR = os.path.dirname(os.path.abspath(__file__))
SRC = "app-pro.html"
OUT = f"{DIR}/ETF动量轮动回测Pro.html"


def read(p):
    return open(f"{DIR}/{p}", encoding="utf-8").read()


html = read(SRC)
for name, fname in [("echarts.min.js", "echarts.min.js"), ("data.js", "data.js"), ("engine.js", "engine.js")]:
    js = read(fname)
    assert "</script" not in js.lower(), f"{fname} 含 </script>, 需转义"
    tag = f'<script src="{name}"></script>'
    assert tag in html, f"未找到 {tag}"
    html = html.replace(tag, f"<script>\n{js}\n</script>")

html = html.replace(
    "<!DOCTYPE html>",
    "<!DOCTYPE html>\n<!-- Pro 单文件构建版, 由 build_pro.py 生成于 "
    + dt.datetime.now().strftime("%Y-%m-%d %H:%M") + " -->",
    1,
)

open(OUT, "w", encoding="utf-8").write(html)
print(f"构建完成: {OUT} ({len(html)/1024:.0f} KB)")
