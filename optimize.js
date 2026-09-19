// optimize.js — 策略优化实验: 交易成本影响 + 窗口稳健性 + 绝对动量避险 + walk-forward 样本外检验
var fs = require('fs');
var path = require('path');
var dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var COST = 0.001, BOND = '511260', RF = 0.02;
function run(cfg) {
  return RotationEngine.runBacktest(ETF_DATA.etfs, {
    lookback: cfg.lookback, rebalanceWeekday: cfg.weekday,
    costRate: cfg.cost || 0,
    riskOff: cfg.riskOff ? { floor: 0, bondCode: BOND } : null,
  });
}
function met(bt, o) { return RotationEngine.computeMetrics(bt, Object.assign({ rf: RF }, o || {})); }
var pct = function (x, d) { return x === null ? '—' : (x * 100).toFixed(d === undefined ? 2 : d) + '%'; };

// ============ 表A: 交易成本影响 ============
console.log('=== 表A: 交易成本 0.1%/次 的影响 ===');
var cfgA = [
  { name: '周四/20日', lookback: 20, weekday: 3 },
  { name: '周四/25日', lookback: 25, weekday: 3 },
  { name: '周四/25日/避险', lookback: 25, weekday: 3, riskOff: true },
  { name: '周五/20日(现行)', lookback: 20, weekday: 4 },
];
var tableA = cfgA.map(function (c) {
  var r0 = met(run(Object.assign({}, c, { cost: 0 })));
  var r1 = met(run(Object.assign({}, c, { cost: COST })));
  console.log(c.name + ': 零成本 年化=' + pct(r0.annualized) + ' 卡玛=' + r0.calmar.toFixed(3) +
    '  |  含成本 年化=' + pct(r1.annualized) + ' 卡玛=' + r1.calmar.toFixed(3) +
    ' (切换' + r1.switches + '次, 年化损失=' + pct(r0.annualized - r1.annualized) + ')');
  return { name: c.name, free: r0, cost: r1 };
});

// ============ 表B: 窗口高原检验 (周四, 含成本) ============
console.log('\n=== 表B: 动量窗口 19~28 日稳健性 (周四调仓, 含成本0.1%) ===');
var tableB = [];
for (var lb = 19; lb <= 28; lb++) {
  var row = { lookback: lb, off: met(run({ lookback: lb, weekday: 3, cost: COST })), on: met(run({ lookback: lb, weekday: 3, cost: COST, riskOff: true })) };
  tableB.push(row);
  console.log('lb=' + lb + 'd: 无避险 年化=' + pct(row.off.annualized) + ' 卡玛=' + row.off.calmar.toFixed(3) +
    '  |  有避险 年化=' + pct(row.on.annualized) + ' 卡玛=' + row.on.calmar.toFixed(3));
}

// ============ 表C: walk-forward 样本外检验 ============
console.log('\n=== 表C: Walk-Forward 样本外检验 (每年初用过去数据选配置, 应用于当年) ===');
var GRID = [];
[20, 25].forEach(function (lb) {
  [3, 4].forEach(function (wd) {
    [false, true].forEach(function (ro) {
      GRID.push({ lookback: lb, weekday: wd, riskOff: ro, cost: COST,
        name: ['周一','周二','周三','周四','周五'][wd] + '/' + lb + '日' + (ro ? '/避险' : '') });
    });
  });
});
var FULL = GRID.map(run);

// 联合交易日历
var dset = {};
ETF_DATA.etfs.forEach(function (e) { e.dates.forEach(function (d) { dset[d] = true; }); });
var CAL = Object.keys(dset).sort();

// 决策日: 2022~2026 每年首个交易日
var decisions = [];
[2022, 2023, 2024, 2025, 2026].forEach(function (y) {
  var pre = y + '-01-01';
  for (var i = 0; i < CAL.length; i++) { if (CAL[i] >= pre) { decisions.push(CAL[i]); break; } }
});

function truncate(T) {
  return ETF_DATA.etfs.map(function (e) {
    var i = 0; while (i < e.dates.length && e.dates[i] <= T) i++;
    return { code: e.code, label: e.label, dates: e.dates.slice(0, i), closes: e.closes.slice(0, i) };
  });
}
function idxOf(bt, d) { for (var i = 0; i < bt.dates.length; i++) { if (bt.dates[i] >= d) return i; } return -1; }

// 逐年选配置 + 链接样本外净值
var chain = 1, chainNav = [], chainDates = [];
var oosStart = decisions[0];
var chosenPerYear = [];
var segBounds = decisions.concat([CAL[CAL.length - 1]]);
for (var s = 0; s < decisions.length; s++) {
  var T = decisions[s], Tend = segBounds[s + 1];
  // 样本内选择(数据 <= T)
  var cut = truncate(T);
  var bestC = -1, bestCfg = null;
  GRID.forEach(function (cfg, ci) {
    var bt = RotationEngine.runBacktest(cut, {
      lookback: cfg.lookback, rebalanceWeekday: cfg.weekday, costRate: COST,
      riskOff: cfg.riskOff ? { floor: 0, bondCode: BOND } : null });
    var m = met(bt);
    if (m.calmar !== null && m.calmar > bestC) { bestC = m.calmar; bestCfg = ci; }
  });
  chosenPerYear.push({ decideAt: T, year: T.slice(0, 4), cfgIndex: bestCfg, cfgName: GRID[bestCfg].name, isCalmar: bestC });
  console.log('决策日 ' + T + ' → 选出 ' + GRID[bestCfg].name + ' (样本内卡玛=' + bestC.toFixed(3) + ')');
  // 样本外应用
  var bt = FULL[bestCfg];
  var i0 = idxOf(bt, T), i1 = idxOf(bt, Tend);
  if (s === 0) chainDates.push(bt.dates[i0]);
  for (var j = i0 + 1; j <= i1; j++) {
    chain *= bt.nav[j] / bt.nav[j0 = j - 1];
    chainNav.push(chain); chainDates.push(bt.dates[j]);
  }
}
console.log('样本外窗口: ' + oosStart + ' ~ ' + CAL[CAL.length - 1] + ' (' + chainDates.length + ' 个交易日)');

// 链接序列与固定基准的样本外指标
function seriesMetrics(dates, nav) {
  var total = nav[nav.length - 1] / 1 - 1;
  var days = nav.length - 1;
  var ann = Math.pow(nav[nav.length - 1], 252 / days) - 1;
  var peak = nav[0], mdd = 0;
  for (var i = 0; i < nav.length; i++) { if (nav[i] > peak) peak = nav[i]; var dd = 1 - nav[i] / peak; if (dd > mdd) mdd = dd; }
  return { total: total, annualized: ann, maxDD: mdd, calmar: mdd > 0 ? ann / mdd : null, days: days + 1 };
}
var chainM = seriesMetrics(chainDates, chainNav);
console.log('\nWalk-Forward 链接: 总收益=' + pct(chainM.total) + ' 年化=' + pct(chainM.annualized) + ' 回撤=' + pct(-chainM.maxDD) + ' 卡玛=' + chainM.calmar.toFixed(3));

var baselines = [
  { name: '固定 周四/20日(现行+成本)', ci: GRID.map(function (g, i) { return (g.lookback === 20 && g.weekday === 3 && !g.riskOff) ? i : -1; }).filter(function (i) { return i >= 0; })[0] },
  { name: '固定 周四/25日', ci: GRID.map(function (g, i) { return (g.lookback === 25 && g.weekday === 3 && !g.riskOff) ? i : -1; }).filter(function (i) { return i >= 0; })[0] },
  { name: '固定 周四/25日/避险', ci: GRID.map(function (g, i) { return (g.lookback === 25 && g.weekday === 3 && g.riskOff) ? i : -1; }).filter(function (i) { return i >= 0; })[0] },
];
var baseRows = baselines.map(function (b) {
  var bt = FULL[b.ci];
  var i0 = idxOf(bt, oosStart), i1 = bt.dates.length - 1;
  var nav = [], prev = bt.nav[i0];
  for (var i = i0; i <= i1; i++) nav.push(bt.nav[i] / prev);
  var m = seriesMetrics(bt.dates.slice(i0), nav);
  console.log(b.name + ': 总收益=' + pct(m.total) + ' 年化=' + pct(m.annualized) + ' 回撤=' + pct(-m.maxDD) + ' 卡玛=' + m.calmar.toFixed(3));
  return { name: b.name, m: m };
});

// ============ 生成 HTML 报告 ============
var rowsA = tableA.map(function (r) {
  return '<tr><td>' + r.name + '</td>' +
    '<td class="up">' + pct(r.free.total) + '</td><td>' + pct(r.free.annualized) + '</td><td>' + r.free.calmar.toFixed(3) + '</td>' +
    '<td class="up">' + pct(r.cost.total) + '</td><td>' + pct(r.cost.annualized) + '</td><td>' + r.cost.calmar.toFixed(3) + '</td>' +
    '<td class="down">' + r.cost.switches + '</td>' +
    '<td>' + pct(r.free.annualized - r.cost.annualized) + '</td></tr>';
}).join('');

var rowsB = tableB.map(function (r) {
  return '<tr><td>' + r.lookback + '日</td>' +
    '<td class="' + (r.off.annualized >= 0 ? 'up' : 'down') + '">' + pct(r.off.annualized) + '</td><td>' + pct(-r.off.maxDD) + '</td><td>' + r.off.calmar.toFixed(3) + '</td>' +
    '<td class="' + (r.on.annualized >= 0 ? 'up' : 'down') + '">' + pct(r.on.annualized) + '</td><td>' + pct(-r.on.maxDD) + '</td><td>' + r.on.calmar.toFixed(3) + '</td></tr>';
}).join('');

var rowsWF = chosenPerYear.map(function (c) {
  return '<tr><td>' + c.year + '</td><td>' + c.decideAt + '</td><td>' + c.cfgName + '</td><td>' + c.isCalmar.toFixed(3) + '</td></tr>';
}).join('');

var cmpRows = [{ name: 'Walk-Forward 动态选配置', m: chainM }].concat(baseRows).map(function (r) {
  return '<tr class="' + (r.m.calmar === Math.max.apply(null, [{ m: chainM }].concat(baseRows).map(function (x) { return x.m.calmar; })) ? 'best' : '') + '">' +
    '<td>' + r.name + '</td><td class="up">' + pct(r.m.total) + '</td><td>' + pct(r.m.annualized) + '</td>' +
    '<td class="down">' + pct(-r.m.maxDD) + '</td><td><b>' + r.m.calmar.toFixed(3) + '</b></td><td>' + r.m.days + '</td></tr>';
}).join('');

var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<title>ETF 动量轮动 · 策略优化实验</title><style>' +
  'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f7f8fa;color:#1f2329;}' +
  '.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 64px;}' +
  'h1{font-size:26px;margin:0 0 4px;} h2{font-size:19px;margin:36px 0 12px;border-left:4px solid #2f6fed;padding-left:10px;}' +
  '.sub{color:#6b7280;font-size:13px;margin-bottom:8px;}' +
  '.conclusion{background:#eef4ff;border:1px solid #c9dcff;border-radius:10px;padding:16px 20px;margin:16px 0;line-height:1.9;font-size:14.5px;}' +
  '.warn{background:#fff7e6;border:1px solid #ffe1a8;border-radius:10px;padding:14px 18px;margin:16px 0;line-height:1.9;font-size:14px;}' +
  'table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;font-size:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);}' +
  'th,td{padding:9px 12px;text-align:right;border-bottom:1px solid #eef0f3;} th:first-child,td:first-child{text-align:left;}' +
  'th{background:#f2f4f7;font-weight:600;white-space:nowrap;}' +
  'tr.best td{background:#fffbe6;}' +
  '.up{color:#d5304f;} .down{color:#0a9d62;}' +
  '.note{color:#6b7280;font-size:12.5px;line-height:1.8;margin-top:10px;}' +
  '</style></head><body><div class="wrap">' +
  '<h1>ETF 动量轮动 · 策略优化实验</h1>' +
  '<div class="sub">在"周四调仓/20日动量"基线上检验三项优化：交易成本 0.1%/次 · 动量窗口稳健性 · 绝对动量避险（最强动量&lt;0 时全仓转国债 ETF 511260）｜数据 2020-07-10 ~ ' + CAL[CAL.length - 1] + '</div>' +

  '<h2>一、交易成本影响（0.1%/次，每次实际切换扣减）</h2>' +
  '<table><thead><tr><th rowspan="2">配置</th><th colspan="3">零成本</th><th colspan="3">含成本 0.1%</th><th rowspan="2">切换次数</th><th rowspan="2">年化损失</th></tr>' +
  '<tr><th>总收益</th><th>年化</th><th>卡玛</th><th>总收益</th><th>年化</th><th>卡玛</th></tr></thead><tbody>' + rowsA + '</tbody></table>' +
  '<div class="note">成本口径：仅在"卖出旧持仓 + 买入新持仓"的切换发生时按切换后净值扣减 0.1%；首日建仓与"决定不切换"不产生交易。</div>' +

  '<h2>二、动量窗口 19~28 日稳健性（周四调仓，含成本）</h2>' +
  '<table><thead><tr><th rowspan="2">窗口</th><th colspan="3">无避险</th><th colspan="3">有避险（动量&lt;0 转国债）</th></tr>' +
  '<tr><th>年化</th><th>最大回撤</th><th>卡玛</th><th>年化</th><th>最大回撤</th><th>卡玛</th></tr></thead><tbody>' + rowsB + '</tbody></table>' +
  '<div class="note">判读方法：若某窗口的指标显著高于相邻窗口（孤峰），大概率是过拟合；若 20~27 日整体处于同一水平（高原），参数选择才稳健。</div>' +

  '<h2>三、Walk-Forward 样本外检验</h2>' +
  '<div class="sub">每年首个交易日，只用此前全部数据从 8 种配置（20/25日 × 周四/周五 × 有/无避险，均含成本）中按卡玛选出一种，应用于当年——模拟"当时不知道未来"的真实决策流程。</div>' +
  '<table><thead><tr><th>决策年度</th><th>决策日</th><th>选出的配置</th><th>样本内卡玛</th></tr></thead><tbody>' + rowsWF + '</tbody></table>' +
  '<h2 style="font-size:16px;margin-top:20px;">样本外表现对比（' + oosStart + ' ~ ' + CAL[CAL.length - 1] + '）</h2>' +
  '<table><thead><tr><th>方案</th><th>总收益</th><th>年化</th><th>最大回撤</th><th>卡玛</th><th>交易日</th></tr></thead><tbody>' + cmpRows + '</tbody></table>' +
  '<div class="warn">⚠️ 阅读要点：① 若 Walk-Forward 链接的卡玛不低于最优固定配置，说明优化结论在样本外仍成立；② 若明显低于，则样本内的"最优参数"含有未来信息成分，应保守采用接近现行策略的配置；③ 样本外窗口仅 ' + chainDates.length + ' 个交易日（约 ' + (chainDates.length / 252).toFixed(1) + ' 年），统计功效有限，任何结论都应视为"证据倾向"而非定论。</div>' +

  '</div></body></html>';

fs.writeFileSync(path.join(dir, 'optimize_results.html'), html);
fs.writeFileSync(path.join(dir, 'optimize_results.json'), JSON.stringify({
  tableA: tableA, tableB: tableB, chosenPerYear: chosenPerYear,
  walkforward: chainM, baselines: baseRows.map(function (b) { return { name: b.name, m: b.m }; }),
  oosStart: oosStart, oosEnd: CAL[CAL.length - 1],
}));
console.log('\n报告已生成: optimize_results.html');
