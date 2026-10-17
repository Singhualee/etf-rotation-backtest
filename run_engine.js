// run_engine.js — Node 运行 JS 引擎, 输出结果 JSON 供 Python 交叉验证
var fs = require('fs');
var path = require('path');
var dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var bt = RotationEngine.runBacktest(ETF_DATA.etfs, { lookback: 20, compare: ETF_DATA.compare });
var metrics = RotationEngine.computeMetrics(bt, { rf: 0.02 });

var out = {
  firstDate: bt.dates[0],
  lastDate: bt.dates[bt.dates.length - 1],
  nDays: bt.dates.length,
  nav: bt.nav,
  holding: bt.holding,
  compare: bt.compare,
  compareStart: bt.compareStart,
  compareCodes: bt.compareCodes,
  bandEqualNav: bt.bandEqualNav,
  bandRebCount: bt.bandRebCount,
  benchmarks: bt.benchmarks,
  switches: bt.switches.map(function (s) {
    return { date: s.date, from: s.from, to: s.to };
  }),
  metrics: {
    total: metrics.total,
    annualized: metrics.annualized,
    vol: metrics.vol,
    sharpe: metrics.sharpe,
    maxDD: metrics.maxDD,
    currentDD: metrics.currentDD,
    calmar: metrics.calmar,
    ulcer: metrics.ulcer,
    martin: metrics.martin,
    weeklyWinRate: metrics.weeklyWinRate,
    switches: metrics.switches,
  },
};
fs.writeFileSync(path.join(dir, 'engine_result.json'), JSON.stringify(out));
console.log('JS引擎完成: ' + bt.dates.length + ' 天, ' + bt.switches.length + ' 次调仓事件(含建仓)');
console.log('总收益=' + (metrics.total * 100).toFixed(4) + '% 年化=' + (metrics.annualized * 100).toFixed(4) + '% 夏普=' + metrics.sharpe.toFixed(6) + ' 最大回撤=' + (metrics.maxDD * 100).toFixed(4) + '%');
console.log('卡玛=' + (metrics.calmar === null ? '—' : metrics.calmar.toFixed(6)) + ' 溃疡指数=' + (metrics.ulcer * 100).toFixed(4) + '% 马丁比率=' + (metrics.martin === null ? '—' : metrics.martin.toFixed(6)));
