#!/usr/bin/env python3
"""抓取四只ETF前复权日线数据并生成 data.js
数据源: 腾讯行情接口 (web.ifzq.gtimg.cn, qfq 前复权, 单次最多640行, 按结束日期分页回溯)
"""
import json
import time
import datetime
import subprocess

ETFS = [
    ("sh513100", "513100", "纳指ETF"),
    ("sh511260", "511260", "十年国债ETF"),
    ("sh518850", "518850", "黄金ETF"),
    ("sh510300", "510300", "沪深300ETF"),
]

PAGE = 640
OUT = "/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest/data.js"


def curl(url):
    for attempt in range(4):
        proc = subprocess.run(
            ["curl", "-s", "--max-time", "30",
             "-A", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124", url],
            capture_output=True, text=True, timeout=40)
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout)
        print(f"  请求失败(第{attempt + 1}次, code={proc.returncode}), 重试...")
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"多次重试仍失败: {url[:80]}")


def fetch_page(symbol, end_date):
    url = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
           f"?param={symbol},day,2000-01-01,{end_date},{PAGE},qfq")
    payload = curl(url)
    body = payload.get("data", {}).get(symbol)
    if body is None:
        raise RuntimeError(f"{symbol}: 接口无数据")
    rows = body.get("qfqday") or body.get("day")
    if rows is None:
        raise RuntimeError(f"{symbol}: 无qfqday/day字段")
    return rows


def fetch_all(symbol):
    end = datetime.date.today().isoformat()
    all_rows = []
    while True:
        rows = fetch_page(symbol, end)
        if not rows:
            raise RuntimeError(f"{symbol}: 空页")
        all_rows = rows + all_rows
        if len(rows) < PAGE:
            break  # 已到上市首日
        earliest = rows[0][0]
        end = (datetime.date.fromisoformat(earliest)
               - datetime.timedelta(days=1)).isoformat()
        time.sleep(0.4)

    # 校验: 日期严格递增、收盘价为正
    dates, closes = [], []
    prev = None
    for r in all_rows:
        d, close = r[0], float(r[2])
        if close <= 0:
            raise RuntimeError(f"{symbol} {d}: 非法收盘价 {close}")
        if prev is not None and d <= prev:
            raise RuntimeError(f"{symbol}: 日期非严格递增 {prev} -> {d}")
        dates.append(d)
        closes.append(round(close, 6))
        prev = d
    return dates, closes


def main():
    result = {"etfs": []}
    print(f"{'代码':<8}{'简称':<12}{'首日':<12}{'末日':<12}{'行数':>6}")
    for symbol, code, label in ETFS:
        dates, closes = fetch_all(symbol)
        print(f"{code:<8}{label:<12}{dates[0]:<12}{dates[-1]:<12}{len(dates):>6}")
        result["etfs"].append({
            "code": code, "label": label, "symbol": symbol,
            "dates": dates, "closes": closes,
        })
        time.sleep(0.4)

    common = max(e["dates"][0] for e in result["etfs"])
    result["meta"] = {
        "fetchedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "腾讯行情 gtimg 日线 qfq 前复权",
        "commonStart": common,
        "riskFreeRate": 0.02,
    }

    gap_report = []
    for e in result["etfs"]:
        ds = [datetime.date.fromisoformat(d) for d in e["dates"]]
        for a, b in zip(ds, ds[1:]):
            if (b - a).days > 12:
                gap_report.append(f"{e['code']} {a} -> {b} 间隔{(b-a).days}天")
    print("长断档检查(>12自然日): " + ("; ".join(gap_report) if gap_report else "无"))

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// 由 fetch_data.py 自动生成, 勿手改\n")
        f.write("var ETF_DATA = ")
        f.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        f.write(";\n")
    print(f"共同起始日(四只均上市): {common}")
    print(f"已写入 {OUT}")


if __name__ == "__main__":
    main()
