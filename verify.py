#!/usr/bin/env python3
"""verify.py — 用 Python 独立实现同一策略, 与 engine.js 的结果交叉验证
规则: 每周五(休市顺延当周最后交易日)收盘比较过去20个自身交易日涨幅, 全仓切换最大者
      并列保持原持仓; 信号与成交同用收盘价; 无费用; 夏普无风险利率=2%
"""
import json
import math
import os
import datetime as dt
from collections import defaultdict

# 脚本自身所在目录: 不写死绝对路径, 以便在 CI/其他机器上直接运行
DIR = os.path.dirname(os.path.abspath(__file__))
LOOKBACK = 20
RF = 0.02


def load_data():
    raw = open(f"{DIR}/data.js", encoding="utf-8").read()
    # data.js 含两条顶层语句: var ETF_DATA = {...}; 与 ETF_DATA.extended = {...};
    # 基准回测只用第一条; extended 仅供网页端"长历史(2013起)"模式拼接, 此处忽略。
    data, _ = json.JSONDecoder().raw_decode(raw, raw.index("{"))
    return data


def monday_of(d):
    return d - dt.timedelta(days=d.weekday())


def run(bt_data):
    etfs = bt_data["etfs"]
    K = len(etfs)
    calendar = sorted({d for e in etfs for d in e["dates"]})
    n = len(calendar)

    ffill = [[None] * n for _ in range(K)]
    own_idx = [[-1] * n for _ in range(K)]
    for k, e in enumerate(etfs):
        pi = -1
        for i, dd in enumerate(calendar):
            while pi + 1 < len(e["dates"]) and e["dates"][pi + 1] <= dd:
                pi += 1
            own_idx[k][i] = pi
            ffill[k][i] = e["closes"][pi] if pi >= 0 else None

    def momentum(i, k):
        idx = own_idx[k][i]
        if idx < LOOKBACK:
            return None
        return etfs[k]["closes"][idx] / etfs[k]["closes"][idx - LOOKBACK] - 1

    start = next(i for i in range(n)
                if all(own_idx[k][i] >= LOOKBACK for k in range(K)))

    week_last = {}
    for i in range(start, n):
        wk = monday_of(dt.date.fromisoformat(calendar[i]))
        week_last[wk] = i
    reb = set(week_last.values())

    first_reb = next(i for i in range(start, n) if i in reb)

    dates, nav, holding, switches = [], [], [], []
    held, prev = None, 1.0
    for i in range(first_reb, n):
        v = 1.0 if held is None else prev * ffill[held][i] / ffill[held][i - 1]
        if i in reb:
            best, best_k = -math.inf, -1
            momenta = {}
            for k in range(K):
                m = momentum(i, k)
                momenta[k] = m
                if m is not None and m > best:
                    best, best_k = m, k
            if best_k >= 0:
                if held is None:
                    switches.append({"date": calendar[i], "from": None, "to": best_k, "momenta": momenta})
                    held = best_k
                elif best_k != held and best > momenta[held]:
                    switches.append({"date": calendar[i], "from": held, "to": best_k, "momenta": momenta})
                    held = best_k
        dates.append(calendar[i])
        nav.append(v)
        holding.append(-1 if held is None else held)
        prev = v

    benchmarks = [[ffill[k][i] / ffill[k][first_reb] for i in range(first_reb, n)] for k in range(K)]
    # ---- 纯对比基准(独立通道: 不参与选股/调仓/成本/等权, 也不进入 calendar 与起点判定) ----
    compare, compare_start, compare_codes = [], [], []
    cmp_raw = bt_data.get("compare")
    if cmp_raw and cmp_raw.get("dates") and cmp_raw.get("closes"):
        cdates, ccloses = cmp_raw["dates"], cmp_raw["closes"]
        px, pi = [], -1
        for i in range(n):
            while pi + 1 < len(cdates) and cdates[pi + 1] <= calendar[i]:
                pi += 1
            px.append(ccloses[pi] if pi >= 0 else None)
        ci = next((i for i in range(first_reb, n) if px[i] is not None), None)
        if ci is not None:
            compare.append([None if i < ci else px[i] / px[ci] for i in range(first_reb, n)])
            compare_start.append(ci - first_reb)
            compare_codes.append(cmp_raw.get("code", ""))
    # 等权持有(5%带宽再平衡): 期初各25%买入后持有,
    # 任一ETF权重偏离25%超过5个百分点(权重<20%或>30%)时, 当日收盘再平衡回等权
    band_units = [0.25 / ffill[k][first_reb] for k in range(K)]
    band_equal_nav, band_reb_count = [], 0
    for i in range(first_reb, n):
        v = sum(band_units[k] * ffill[k][i] for k in range(K))
        need = any(abs(band_units[k] * ffill[k][i] / v - 0.25) > 0.05 for k in range(K))
        if need:
            band_units = [v / (K * ffill[k][i]) for k in range(K)]
            band_reb_count += 1
        band_equal_nav.append(v)

    # 指标
    rs = [nav[i] / nav[i - 1] - 1 for i in range(1, len(nav))]
    m = sum(rs) / len(rs)
    sd = math.sqrt(sum((x - m) ** 2 for x in rs) / (len(rs) - 1))
    peak, max_dd, dd_sq = nav[0], 0.0, 0.0
    for v2 in nav:
        peak = max(peak, v2)
        dd = 1 - v2 / peak
        max_dd = max(max_dd, dd)
        dd_sq += dd * dd
    cur_dd = 1 - nav[-1] / max(nav)
    total = nav[-1] / nav[0] - 1
    annualized = (nav[-1] / nav[0]) ** (252 / (len(nav) - 1)) - 1
    sharpe = (m - RF / 252) / sd * math.sqrt(252)
    # 溃疡指数: 日频回撤深度的均方根(惩罚深度与持续时间); 马丁比率 = 超额年化收益 / 溃疡指数
    ulcer = math.sqrt(dd_sq / len(nav))
    calmar = annualized / max_dd if max_dd > 0 else None
    martin = (annualized - RF) / ulcer if ulcer > 0 else None

    week_end = {}
    for i in range(len(nav)):
        wk = monday_of(dt.date.fromisoformat(dates[i]))
        week_end[wk] = i
    idxs = [week_end[w] for w in sorted(week_end)]
    wins, prev_ref = 0, nav[0]
    for li in idxs:
        if li > 0:
            if nav[li] / prev_ref - 1 > 0:
                wins += 1
            prev_ref = nav[li]
    weeks = len([li for li in idxs if li > 0])

    return {
        "firstDate": dates[0], "lastDate": dates[-1], "nDays": len(dates),
        "nav": nav, "holding": holding,
        "compare": compare, "compareStart": compare_start, "compareCodes": compare_codes,
        "bandEqualNav": band_equal_nav, "bandRebCount": band_reb_count,
        "benchmarks": benchmarks,
        "switches": [{"date": s["date"], "from": s["from"], "to": s["to"]} for s in switches],
        "metrics": {
            "total": total, "annualized": annualized, "vol": sd * math.sqrt(252),
            "sharpe": sharpe, "maxDD": max_dd, "currentDD": cur_dd,
            "calmar": calmar, "ulcer": ulcer, "martin": martin,
            "weeklyWinRate": wins / weeks if weeks else 0,
            "switches": len(switches) - 1,  # 不含建仓
        },
    }


def main():
    data = load_data()
    py = run(data)
    js = json.load(open(f"{DIR}/engine_result.json", encoding="utf-8"))

    ok = True

    def cmp(name, a, b, tol=1e-9):
        nonlocal ok
        if a is None or b is None:
            good = (a is None) == (b is None)
        else:
            good = abs(a - b) <= tol
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'}  {name}: py={a!r} js={b!r}")

    print("== 基本信息 ==")
    for k in ("firstDate", "lastDate", "nDays"):
        good = py[k] == js[k]
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'}  {k}: py={py[k]} js={js[k]}")

    print("== 净值序列 ==")
    if len(py["nav"]) != len(js["nav"]):
        ok = False
        print(f"  FAIL  长度不一致 py={len(py['nav'])} js={len(js['nav'])}")
    else:
        diff = max(abs(a - b) for a, b in zip(py["nav"], js["nav"]))
        cmp("净值最大绝对偏差", diff, 0, 1e-10)
        diff_he = max(abs(a - b) for a, b in zip(py["bandEqualNav"], js["bandEqualNav"]))
        cmp("等权5%带宽再平衡净值最大绝对偏差", diff_he, 0, 1e-10)
        cmp("等权5%带宽再平衡次数", py["bandRebCount"], js["bandRebCount"], tol=0.5)
        for k in range(len(py["benchmarks"])):
            db = max(abs(a - b) for a, b in zip(py["benchmarks"][k], js["benchmarks"][k]))
            cmp(f"基准{data['etfs'][k]['code']}净值最大偏差", db, 0, 1e-10)
        for k in range(len(py["compare"])):
            pairs = [(a, b) for a, b in zip(py["compare"][k], js["compare"][k]) if a is not None and b is not None]
            db = max((abs(a - b) for a, b in pairs), default=0.0)
            cmp(f"对比基准{py['compareCodes'][k]}净值最大偏差", db, 0, 1e-10)
            cmp(f"对比基准{py['compareCodes'][k]}起始下标", py["compareStart"][k], js["compareStart"][k], tol=0.5)
        mism = [i for i, (a, b) in enumerate(zip(py["holding"], js["holding"])) if a != b]
        print(f"  {'PASS' if not mism else 'FAIL'}  持仓序列一致 ({len(mism)}处不一致)")

    print("== 调仓记录 ==")
    py_sw = py["switches"]
    js_sw = js["switches"]
    good = len(py_sw) == len(js_sw) and all(
        a["date"] == b["date"] and a["from"] == b["from"] and a["to"] == b["to"]
        for a, b in zip(py_sw, js_sw))
    ok = ok and good
    print(f"  {'PASS' if good else 'FAIL'}  调仓记录完全一致 (共{len(py_sw)}条, py {len(js_sw)}条)")
    if not good:
        for a, b in list(zip(py_sw, js_sw))[:10]:
            if a != b:
                print("    py:", a, " js:", b)

    print("== 指标 ==")
    for k in ("total", "annualized", "vol", "sharpe", "maxDD", "currentDD",
              "calmar", "ulcer", "martin", "weeklyWinRate", "switches"):
        cmp(k, py["metrics"][k], js["metrics"][k], tol=1e-9)

    print()
    print("总体结论:", "ALL PASS ✓ 双实现一致" if ok else "存在差异, 需排查 ✗")
    print(f"\n策略概要(Python独立实现): 回测区间 {py['firstDate']} ~ {py['lastDate']}, {py['nDays']}个交易日")
    print(f"  总收益率: {py['metrics']['total']*100:.2f}%")
    print(f"  年化收益率: {py['metrics']['annualized']*100:.2f}%")
    print(f"  夏普比率(rf=2%): {py['metrics']['sharpe']:.3f}")
    print(f"  最大回撤: {py['metrics']['maxDD']*100:.2f}%")
    print(f"  当前回撤: {py['metrics']['currentDD']*100:.2f}%")
    print(f"  卡玛比率: {py['metrics']['calmar']:.3f}")
    print(f"  溃疡指数: {py['metrics']['ulcer']*100:.2f}%")
    print(f"  马丁比率: {py['metrics']['martin']:.3f}")
    print(f"  切换次数: {py['metrics']['switches']}")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
