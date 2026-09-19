#!/usr/bin/env python3
"""build_pro.py — 把 echarts.min.js / data.js / engine.js 内联进 app-pro.html,
生成新策略(周四调仓+25日动量+避险)的单文件交付版"""
import datetime as dt

DIR = "/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest"
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
