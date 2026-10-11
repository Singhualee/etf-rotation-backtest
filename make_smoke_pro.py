#!/usr/bin/env python3
"""make_smoke_pro.py — 从 smoke-test.js 生成 smoke-test-pro.js:
把旧策略(周五/20日)的硬编码预期值替换为按 Pro 参数(周五/25日/波动率目标18%/避险/0.1%成本)
用同一引擎动态计算的期望值

⚠️ 慎用: 本脚本是「全量重写」smoke-test-pro.js —— 它会用 smoke-test.js 作为基底重建,
   凡是直接写在 smoke-test-pro.js 里、而 smoke-test.js 没有的用例都会被抹掉
   (例如「打开时自动更新」12 项、「净值图悬停明细只列该条」9 项)。
   运行前先 `git diff --stat smoke-test-pro.js` 确认没有仅存在于 Pro 版的新增用例,
   或先把新增用例补进 smoke-test.js 再生成。
"""
import re

DIR = "/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest"
src = open(f"{DIR}/smoke-test.js", encoding="utf-8").read()

# 0. 默认目标页面改为 Pro 单文件版
#    (否则漏传 argv[2] 时会静默测非 Pro 页, 产生约 20 项假 FAIL)
_old_path = "const path = process.argv[2] || '" + DIR + "/ETF动量轮动回测.html';"
_new_path = "const path = process.argv[2] || '" + DIR + "/ETF动量轮动回测Pro.html';"
assert _old_path in src, "未找到默认页面路径"
src = src.replace(_old_path, _new_path, 1)
src = src.replace(
    "// smoke-test.js — ETF动量轮动回测.html 无头冒烟测试 (jsdom)",
    "// smoke-test-pro.js — ETF动量轮动回测Pro.html 无头冒烟测试 (jsdom)\n"
    "// 默认目标必须是 Pro 单文件版: 若默认落到非 Pro 页, 会静默测错产物并崩溃。",
    1,
)

# 1. 注入动态期望值计算(在读取 html 之后)
inject_after = "const html = fs.readFileSync(path, 'utf-8');"
inject = inject_after + """

// ---- Pro 版: 期望值与页面同引擎同参数动态计算, 不再硬编码 ----
// 用独立函数作用域 eval, 避免 engine.js 的 typeof window 撞上外层 const { window } 的 TDZ
const __proSetup = new Function('fs', 'dir',
  'eval(fs.readFileSync(dir + "/engine.js", "utf8"));' +
  'eval(fs.readFileSync(dir + "/data.js", "utf8"));' +
  'return { RotationEngine: RotationEngine, ETF_DATA: ETF_DATA };');
const { RotationEngine, ETF_DATA } = __proSetup(fs, __dirname);
const PRO_OPTS = {lookback:25, rebalanceWeekday:4, volTarget:0.15, costRate:0.001, riskOff:{floor:0, bondCode:'511260'}};
const EXPbt = RotationEngine.runBacktest(ETF_DATA.etfs, PRO_OPTS);
const EXPm = RotationEngine.computeMetrics(EXPbt, {rf:0.02});
const fmtSigned = x => (x>=0?'+':'') + (x*100).toFixed(2) + '%';
const EXP = {
  firstDate: EXPbt.dates[0],
  rows: (EXPbt.rebalances || EXPbt.switches).length + 1,   // 表头 + 全部调仓决策(含建仓与重新定仓)
  total: fmtSigned(EXPm.total),
  annualized: fmtSigned(EXPm.annualized),
  sharpe: EXPm.sharpe.toFixed(3),
  maxDD: fmtSigned(-EXPm.maxDD),
  switches: String(EXPm.switches),
};"""
assert inject_after in src
src = src.replace(inject_after, inject, 1)

# 2. 副标题起始日
old = "check('副标题含回测区间2020-07-10', document.getElementById('subtitle').textContent.includes('2020-07-10'));"
new = "check('副标题含回测区间'+EXP.firstDate, document.getElementById('subtitle').textContent.includes(EXP.firstDate));"
assert old in src; src = src.replace(old, new, 1)

# 3. 切换记录表行数
old = """  check('切换记录表99行(表头+98事件,含建仓)', document.querySelectorAll('#swTable tr').length === 99,
    document.querySelectorAll('#swTable tr').length);"""
new = """  check('切换记录表' + EXP.rows + '行(表头+' + (EXP.rows-1) + '事件,含建仓)', document.querySelectorAll('#swTable tr').length === EXP.rows,
    document.querySelectorAll('#swTable tr').length);"""
assert old in src; src = src.replace(old, new, 1)

# 4. 五个指标卡硬编码
old = "check('总收益率=+270.04%', cards['总收益率'] === '+270.04%', cards['总收益率']);"
new = "check('总收益率='+EXP.total, cards['总收益率'] === EXP.total, cards['总收益率']);"
assert old in src; src = src.replace(old, new, 1)
old = "check('年化收益率=+24.51%', cards['年化收益率'] === '+24.51%', cards['年化收益率']);"
new = "check('年化收益率='+EXP.annualized, cards['年化收益率'] === EXP.annualized, cards['年化收益率']);"
assert old in src; src = src.replace(old, new, 1)
old = "check('夏普比率=1.036(rf=2%)', cards['夏普比率'] === '1.036', cards['夏普比率']);"
new = "check('夏普比率='+EXP.sharpe+'(rf=2%)', cards['夏普比率'] === EXP.sharpe, cards['夏普比率']);"
assert old in src; src = src.replace(old, new, 1)
old = "check('最大回撤=-18.46%', cards['最大回撤'] === '-18.46%', cards['最大回撤']);"
new = "check('最大回撤='+EXP.maxDD, cards['最大回撤'] === EXP.maxDD, cards['最大回撤']);"
assert old in src; src = src.replace(old, new, 1)
old = "check('切换次数=97', cards['切换次数'] === '97', cards['切换次数']);"
new = "check('切换次数='+EXP.switches, cards['切换次数'] === EXP.switches, cards['切换次数']);"
assert old in src; src = src.replace(old, new, 1)

# 5. 回到全部区间恢复
old = "check('回到全部区间后总收益率恢复+270.04%', back['总收益率'] === '+270.04%', back['总收益率']);"
new = "check('回到全部区间后总收益率恢复' + EXP.total, back['总收益率'] === EXP.total, back['总收益率']);"
assert old in src, "未找到恢复检查"
src = src.replace(old, new, 1)

# 6. mock 数据起点的两处 2013-06-14 → 按 Pro 参数对 mock 数据动态计算
anchor = "  let refreshErr = null;"
inject2 = """  // mock 数据上按 Pro 参数的回测起点(动态)
  const mockEtfs = ['sh513100','sh511260','sh518850','sh510300'].map(sym => ({
    code: sym.slice(2), label: sym, symbol: sym,
    dates: fakeDates, closes: fakeSeries[sym].map(r => parseFloat(r[2])),
  }));
  const EXPmockStart = RotationEngine.runBacktest(mockEtfs, PRO_OPTS).dates[0];
  let refreshErr = null;"""
assert anchor in src
src = src.replace(anchor, inject2, 1)
assert src.count("'回测区间 2013-06-14'") == 2, src.count("'回测区间 2013-06-14'")
src = src.replace("'回测区间 2013-06-14'", "'回测区间 ' + EXPmockStart")

# 7. 损坏兜底的总收益预期
old = "return c5['总收益率'] === '+270.04%';"
new = "return c5['总收益率'] === EXP.total;"
assert old in src; src = src.replace(old, new, 1)

# 8. mock 数据"最近交易日"随真实日期变化 -> 硬编码日期一律改为动态计算
#    幂等: smoke-test.js 若已自带 fmtLocalDate/EXPmockEnd (已在源头修好), 本步自动跳过, 不重复声明 const
if "EXPmockEnd" in src:
    pass
else:
    inject_end = """const fmtLocalDate = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
const EXPmockEnd = (() => { const d = new Date(); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); return fmtLocalDate(d); })();"""
    anchor2 = "const fmtSigned = x => (x>=0?'+':'') + (x*100).toFixed(2) + '%';"
    assert anchor2 in src
    src = src.replace(anchor2, inject_end + "\n" + anchor2, 1)
    pairs = [
      ("check('刷新后副标题数据截至为最近交易日2026-09-18',\n    document.getElementById('subtitle').textContent.includes('数据截至 2026-09-18'),",
       "check('刷新后副标题数据截至为最近交易日'+EXPmockEnd,\n    document.getElementById('subtitle').textContent.includes('数据截至 ' + EXPmockEnd),"),
      ("return c.endDate === '2026-09-18' && c.savedAt && c.etfs.length === 4 && c.etfs[0].dates.length > 3000;",
       "return c.endDate === EXPmockEnd && c.savedAt && c.etfs.length === 4 && c.etfs[0].dates.length > 3000;"),
      ("d2status.includes('已加载浏览器缓存数据（截至 2026-09-18）');",
       "d2status.includes('已加载浏览器缓存数据（截至 ' + EXPmockEnd + '）');"),
    ]
    for old, new in pairs:
        assert old in src, "未找到: " + old[:60]
        src = src.replace(old, new, 1)

open(f"{DIR}/smoke-test-pro.js", "w", encoding="utf-8").write(src)
print("生成完成: smoke-test-pro.js")
