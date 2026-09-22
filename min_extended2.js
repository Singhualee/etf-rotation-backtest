// min_extended2.js — 长历史窗口(2013-09起)下重扫"调仓日×动量窗口"最优组合
// 口径: 避险+波动目标18%+0.1%成本, 与实盘配置一致
var fs = require('fs');
eval(fs.readFileSync('engine.js', 'utf8'));
eval(fs.readFileSync('data.js', 'utf8'));

// 与网站相同的拼接逻辑: 替代序列按原序列首日对齐比例前接
function spliced(code, ext) {
  var e = ETF_DATA.etfs.filter(function (x) { return x.code === code; })[0];
  var sub = ext, ref = null;
  for (var i = sub.dates.length - 1; i >= 0; i--) { if (sub.dates[i] <= e.dates[0]) { ref = sub.closes[i]; break; } }
  var f = e.closes[0] / ref;
  var pd = [], pc = [];
  for (var j = 0; j < sub.dates.length; j++) { if (sub.dates[j] < e.dates[0]) { pd.push(sub.dates[j]); pc.push(sub.closes[j] * f); } }
  return { code: e.code, label: e.label, dates: pd.concat(e.dates), closes: pc.concat(e.closes) };
}
function snap(code) {
  var e = ETF_DATA.etfs.filter(function (x) { return x.code === code; })[0];
  return { code: e.code, label: e.label, dates: e.dates, closes: e.closes };
}
var etfs = [snap('513100'), spliced('511260', ETF_DATA.extended.bond), spliced('518850', ETF_DATA.extended.gold), snap('510300')];

function run(wd, lb) {
  var bt = RotationEngine.runBacktest(etfs, {
    lookback: lb, rebalanceWeekday: wd, costRate: 0.001,
    riskOff: { floor: 0, bondCode: '511260' }, volTarget: 0.18, volLookback: 20,
  });
  var m = RotationEngine.computeMetrics(bt, { rf: 0.02 });
  return { bt: bt, m: m, ann: m.annualized, mdd: m.maxDD, cal: m.annualized / m.maxDD, sharpe: m.sharpe };
}

var WD = ['周一', '周二', '周三', '周四', '周五'];
var LBS = [15, 20, 22, 25, 30, 40];
var all = [];
console.log('== 长历史窗口 ' + '2013-09 ~ 2026-09 · 避险+波动18%+成本0.1% ==');
console.log('\n[表1] 卡玛比率: 行=动量窗口, 列=调仓日');
var header = '窗口  ' + WD.map(function (w) { return '  ' + w + '   '; }).join('');
console.log(header);
LBS.forEach(function (lb) {
  var line = lb + '日  ';
  for (var wd = 0; wd < 5; wd++) {
    var r = run(wd, lb);
    all.push({ wd: wd, lb: lb, ann: r.ann, mdd: r.mdd, cal: r.cal, sharpe: r.sharpe });
    line += r.cal.toFixed(3) + ' ';
  }
  console.log(line);
});
console.log('\n[表2] 年化收益%');
LBS.forEach(function (lb) {
  var line = lb + '日  ';
  for (var wd = 0; wd < 5; wd++) {
    var r = all.filter(function (x) { return x.wd === wd && x.lb === lb; })[0];
    line += (r.ann * 100).toFixed(1) + '  ';
  }
  console.log(line);
});
console.log('\n[表3] 最大回撤%');
LBS.forEach(function (lb) {
  var line = lb + '日  ';
  for (var wd = 0; wd < 5; wd++) {
    var r = all.filter(function (x) { return x.wd === wd && x.lb === lb; })[0];
    line += (r.mdd * 100).toFixed(1) + '  ';
  }
  console.log(line);
});
var top = all.slice().sort(function (a, b) { return b.cal - a.cal; });
console.log('\n卡玛Top5: ' + top.slice(0, 5).map(function (r) { return WD[r.wd] + '/' + r.lb + '日=' + r.cal.toFixed(3); }).join('  '));
var cur = all.filter(function (x) { return x.wd === 4 && x.lb === 25; })[0];
var rank = top.indexOf(cur) + 1;
console.log('当前配置(周五/25日): 卡玛 ' + cur.cal.toFixed(3) + '  年化 ' + (cur.ann * 100).toFixed(2) + '%  回撤 ' + (cur.mdd * 100).toFixed(2) + '%  排名 ' + rank + '/' + all.length);

// --- 子期稳定性: 2013-2019 vs 2020-2026, 对比当前配置与长历史最优 ---
function subMetrics(bt, d0, d1) {
  var i0 = bt.dates.findIndex(function (d) { return d >= d0; });
  var i1 = bt.dates.findIndex(function (d) { return d > d1; });
  if (i1 < 0) i1 = bt.dates.length - 1; else i1 -= 1;
  if (i0 < 0) i0 = 0;
  return RotationEngine.computeMetrics(bt, { rf: 0.02, i0: i0, i1: i1 });
}
console.log('\n== 子期稳定性(卡玛) ==');
[[top[0].wd, top[0].lb, '长历史最优'], [4, 25, '周五/25日'], [2, 20, '周三/20日'], [4, 20, '周五/20日']].forEach(function (cfg) {
  var r = run(cfg[0], cfg[1]);
  var a = subMetrics(r.bt, '2013-09-01', '2019-12-31');
  var b = subMetrics(r.bt, '2020-01-01', '2026-09-30');
  console.log(cfg[2] + '(' + WD[cfg[0]] + '/' + cfg[1] + '日): 2013-2019 卡玛 ' + (a.annualized / a.maxDD).toFixed(3) + ' (年化' + (a.annualized * 100).toFixed(1) + '% 回撤' + (a.maxDD * 100).toFixed(1) + '%)  |  2020-2026 卡玛 ' + (b.annualized / b.maxDD).toFixed(3) + ' (年化' + (b.annualized * 100).toFixed(1) + '% 回撤' + (b.maxDD * 100).toFixed(1) + '%)');
});

// --- Walk-forward: 逐年用过去数据选最优(wd,lb), 考核紧随其后的一年, 对比固定参数 ---
console.log('\n== Walk-forward 逐年滚动 (训练=2013-09起至上年, 考核=当年, 选卡玛最高) ==');
var years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
var bts = {};
all.forEach(function (x) { bts[x.wd + '_' + x.lb] = run(x.wd, x.lb).bt; });
var wf = [], fixed = [], cur = [];
var picks = {};
years.forEach(function (y) {
  var trainEnd = (y - 1) + '-12-31';
  var y0 = y + '-01-01', y1 = y + '-12-31';
  var scored = all.map(function (x) {
    var bt = bts[x.wd + '_' + x.lb];
    var mm = subMetrics(bt, '2013-09-01', trainEnd);
    return { x: x, cal: mm.annualized / mm.maxDD };
  }).sort(function (a, b) { return b.cal - a.cal; });
  var best = scored[0].x;
  picks[y] = WD[best.wd] + '/' + best.lb;
  var evalOf = function (x) {
    var mm = subMetrics(bts[x.wd + '_' + x.lb], y0, y1);
    return mm.annualized / mm.maxDD;
  };
  wf.push(evalOf(best));
  fixed.push(evalOf({ wd: 4, lb: 25 }));
  cur.push(evalOf({ wd: 4, lb: 20 }));
  var bestEval = evalOf({ wd: best.wd, lb: best.lb });
  console.log(y + ': 训练期最优=' + WD[best.wd] + '/' + best.lb + '日(训练卡玛' + scored[0].cal.toFixed(2) + ') → 当年卡玛 ' + bestEval.toFixed(2)
    + ' | 固定周五/25日 ' + fixed[fixed.length - 1].toFixed(2)
    + ' | 固定周五/20日 ' + cur[cur.length - 1].toFixed(2));
});
function geoMean(arr) { return Math.pow(arr.reduce(function (a, b) { return a * Math.max(b, 0.01); }, 1), 1 / arr.length); }
console.log('滚动最优组合逐年选择: ' + years.map(function (y) { return y + ':' + picks[y]; }).join('  '));
console.log('Walk-forward 几何平均卡玛: 滚动选优 ' + geoMean(wf).toFixed(3) + ' | 固定周五/25日 ' + geoMean(fixed).toFixed(3) + ' | 固定周五/20日 ' + geoMean(cur).toFixed(3));
console.log('算术平均卡玛: 滚动选优 ' + (wf.reduce(function (a, b) { return a + b; }, 0) / wf.length).toFixed(3) + ' | 固定周五/25日 ' + (fixed.reduce(function (a, b) { return a + b; }, 0) / fixed.length).toFixed(3) + ' | 固定周五/20日 ' + (cur.reduce(function (a, b) { return a + b; }, 0) / cur.length).toFixed(3));
