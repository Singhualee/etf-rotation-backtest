// weekday_compare.js — 调仓日(周一~周五)对比分析
// 5 种调仓日各跑一遍回测, 净值对齐到共同起点后计算指标, 生成 HTML 对比报告
var fs = require('fs');
var path = require('path');
var dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var NODE = '内置';
var WD_NAMES = ['周一', '周二', '周三', '周四', '周五'];
var RF = 0.02;

// ---- 1. 跑 5 个变体 ----
var variants = [];
for (var w = 0; w < 5; w++) {
  var bt = RotationEngine.runBacktest(ETF_DATA.etfs, { lookback: 20, rebalanceWeekday: w });
  variants.push({ wd: w, name: WD_NAMES[w], bt: bt });
}

// ---- 2. 对齐共同起点 ----
var commonStart = '';
variants.forEach(function (v) { if (v.bt.dates[0] > commonStart) commonStart = v.bt.dates[0]; });
variants.forEach(function (v) {
  var idx = -1;
  for (var i = 0; i < v.bt.dates.length; i++) {
    if (v.bt.dates[i] >= commonStart) { idx = i; break; }
  }
  v.i0 = idx;
  v.metrics = RotationEngine.computeMetrics(v.bt, { rf: RF, i0: idx });
});

var commonEnd = variants[0].bt.dates[variants[0].bt.dates.length - 1];

// ---- 3. 分年度指标 + 排名 ----
var years = [];
var ySet = {};
variants.forEach(function (v) {
  for (var i = v.i0; i < v.bt.dates.length; i++) ySet[v.bt.dates[i].slice(0, 4)] = true;
});
Object.keys(ySet).sort().forEach(function (y) { years.push(y); });

variants.forEach(function (v) {
  v.yearly = years.map(function (y) {
    var i0 = -1, i1 = -1;
    for (var i = v.i0; i < v.bt.dates.length; i++) {
      var d = v.bt.dates[i];
      if (d.slice(0, 4) !== y) { if (i0 >= 0) break; continue; }
      if (i0 < 0) i0 = i;
      i1 = i;
    }
    return { year: y, i0: i0, i1: i1, m: RotationEngine.computeMetrics(v.bt, { rf: RF, i0: i0, i1: i1 }) };
  });
});

// 每年按年化与卡玛排名
var rankByAnnual = {}, rankByCalmar = {};
years.forEach(function (y, yi) {
  var sortedA = variants.slice().sort(function (a, b) { return b.yearly[yi].m.annualized - a.yearly[yi].m.annualized; });
  var sortedC = variants.slice().sort(function (a, b) {
    var ca = a.yearly[yi].m.calmar, cb = b.yearly[yi].m.calmar;
    if (ca === null) return 1; if (cb === null) return -1;
    return cb - ca;
  });
  sortedA.forEach(function (v, r) { rankByAnnual[v.wd + '_' + y] = r + 1; });
  sortedC.forEach(function (v, r) { rankByCalmar[v.wd + '_' + y] = r + 1; });
});

// ---- 4. 汇总输出 ----
var summary = variants.map(function (v) {
  return {
    name: v.name, firstDate: v.bt.dates[0],
    total: v.metrics.total, annualized: v.metrics.annualized,
    sharpe: v.metrics.sharpe, vol: v.metrics.vol,
    maxDD: v.metrics.maxDD, calmar: v.metrics.calmar,
    weeklyWinRate: v.metrics.weeklyWinRate,
    switches: v.metrics.switches, tradingDays: v.metrics.tradingDays,
    holdDays: v.metrics.holdDays,
  };
});
var bestByCalmar = variants.slice().sort(function (a, b) { return b.metrics.calmar - a.metrics.calmar; })[0];
var bestByAnnual = variants.slice().sort(function (a, b) { return b.metrics.annualized - a.metrics.annualized; })[0];

var report = {
  commonStart: commonStart, commonEnd: commonEnd, rf: RF,
  summary: summary, years: years,
  yearly: variants.map(function (v) {
    return { name: v.name, rows: v.yearly.map(function (r) {
      return { year: r.year, annualized: r.m.annualized, maxDD: r.m.maxDD, calmar: r.m.calmar,
        rankA: rankByAnnual[v.wd + '_' + r.year], rankC: rankByCalmar[v.wd + '_' + r.year] };
    }) };
  }),
  navSeries: variants.map(function (v) {
    var arr = [];
    for (var i = v.i0; i < v.bt.dates.length; i++) arr.push(+(v.bt.nav[i] / v.bt.nav[v.i0]).toFixed(6));
    return { name: v.name, dates: v.bt.dates.slice(v.i0), nav: arr };
  }),
  bestByCalmar: bestByCalmar.name, bestByAnnual: bestByAnnual.name,
};

fs.writeFileSync(path.join(dir, 'weekday_result.json'), JSON.stringify(report));
console.log('调仓日对比完成, 共同窗口: ' + commonStart + ' ~ ' + commonEnd);
summary.forEach(function (s) {
  console.log(s.name + ': 总收益=' + (s.total * 100).toFixed(2) + '% 年化=' + (s.annualized * 100).toFixed(2) +
    '% 夏普=' + s.sharpe.toFixed(3) + ' 最大回撤=' + (s.maxDD * 100).toFixed(2) + '% 卡玛=' +
    (s.calmar === null ? 'N/A' : s.calmar.toFixed(3)) + ' 切换=' + s.switches + '次');
});
console.log('按卡玛最优: ' + bestByCalmar.name + '  按年化最优: ' + bestByAnnual.name);

module.paths.push(dir);
require(path.join(dir, 'gen_report.js'))(report, dir);
