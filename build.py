#!/usr/bin/env python3
"""build.py — 把 echarts.min.js / data.js / engine.js 内联进 app.html, 生成单文件交付版"""
import os
import re
import datetime as dt

# 脚本自身所在目录: 不写死绝对路径, 便于在 CI/其他机器上直接运行
DIR = os.path.dirname(os.path.abspath(__file__))
OUT = f"{DIR}/ETF动量轮动回测.html"


def read(p):
    return open(f"{DIR}/{p}", encoding="utf-8").read()


html = read("app.html")
for name, fname in [("echarts.min.js", "echarts.min.js"), ("data.js", "data.js"), ("engine.js", "engine.js")]:
    js = read(fname)
    assert "</script" not in js.lower(), f"{fname} 含 </script>, 需转义"
    tag = f'<script src="{name}"></script>'
    assert tag in html, f"未找到 {tag}"
    html = html.replace(tag, f"<script>\n{js}\n</script>")

# 页面标题区加数据截止信息已在 app 内处理; 版本注释放到文件头 (只替换第一处, 即真正的 doctype)
html = html.replace(
    "<!DOCTYPE html>",
    "<!DOCTYPE html>\n<!-- 单文件构建版, 由 build.py 生成于 "
    + dt.datetime.now().strftime("%Y-%m-%d %H:%M") + " -->",
    1,
)

open(OUT, "w", encoding="utf-8").write(html)
print(f"构建完成: {OUT} ({len(html)/1024:.0f} KB)")
