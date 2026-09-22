// min_walkdaily.js — walk-forward 检验"每日检查避险"是否值得替换周五基线 (2026-09-23)
// 候选: A周五基线 / E每日检查 / G每日+vt12 / H混合动量+每日+vt12 / W2周五+vt12(对照)
// 方法: ①逐年样本外卡玛对照(参数先验固定,无样本内选择) ②经典walk-forward(每年用过去选优考核下一年)
var fs = require('fs');
eval(fs.readFileSync('data.js', 'utf8'));

function snap(code) { return ETF_DATA.etfs.filter(x => x.code === code)[0]; }
function scaled(subKey, code) {
  var sub = ETF_DATA.extended[subKey], s = snap(code);
  var si = sub.dates.indexOf(s.dates[0]); if (si < 0) si = 0;
  var ratio = s.closes[0] / sub.closes[si];
  return { code: code, dates: sub.dates, closes: sub.closes.map(c => c * ratio) };
}
var gold = scaled('gold', '518850'), bond = scaled('bond', '511260');
var RAW = [snap('513100'), gold, bond, snap('510300')];
var dateSet = {};
RAW.forEach(e => e.dates.forEach(d => dateSet[d] = true));
var dates = Object.keys(dateSet).sort();
var M = RAW.map(e => {
  var map = {}, out = [], last = null;
  e.dates.forEach((d, i) => map[d] = e.closes[i]);
  dates.forEach(d => { if (map[d] !== undefined) last = map[d]; out.push(last); });
  return out;
});
var K = 4, BOND = 2;
var start = 0;
for (var i = 0; i < dates.length; i++) if (M.every(col => col[i] != null)) { start = i; break; }
dates = dates.slice(start); M = M.map(c => c.slice(start));
var N = dates.length;

function momAt(k, t, lb) { return t - lb >= 0 ? M[k][t] / M[k][t - lb] - 1 : null; }
function blendMom(k, t) { var ms = [20, 25, 30].map(lb => momAt(k, t, lb)); return ms.some(m => m == null) ? null : ms.reduce((a, b) => a + b, 0) / 3; }
function vol20(k, t) {
  if (t < 20) return null;
  var rs = []; for (var i = t - 19; i <= t; i++) rs.push(M[k][i] / M[k][i - 1] - 1);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var v = rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function isFriday(d) { return new Date(d + 'T12:00:00+08:00').getDay() === 5; }

function backtest(opt) {
  var nav = [1], w = [0, 0, 0, 0]; w[BOND] = 1;
  for (var t = 1; t < N; t++) {
    var cost = 0;
    var signalDay = opt.freq === 'daily' || isFriday(dates[t - 1]);
    if (signalDay && t >= 45) {
      var mo = [];
      for (k = 0; k < K; k++) mo.push(opt.blend ? blendMom(k, t - 1) : momAt(k, t - 1, opt.lb));
      var ranked = [0, 1, 3].slice().sort((a, b) => (mo[b] == null ? -9 : mo[b]) - (mo[a] == null ? -9 : mo[a]));
      var newW = [0, 0, 0, 0];
      if (mo[ranked[0]] == null || mo[ranked[0]] < 0) newW[BOND] = 1;
      else {
        var sig = vol20(ranked[0], t - 1);
        var rw = Math.min(1, opt.vt / sig);
        newW[ranked[0]] = rw; newW[BOND] = 1 - rw;
      }
      var turn = 0; for (k = 0; k < K; k++) turn += Math.abs(newW[k] - w[k]);
      cost = 0.001 * turn / 2;
      w = newW;
    }
    var r = 0; for (var k = 0; k < K; k++) r += w[k] * (M[k][t] / M[k][t - 1] - 1);
    nav.push(nav[nav.length - 1] * (1 + r) * (1 - cost));
  }
  return nav;
}

var CONFIGS = [
  ['A周五·vt18', { freq: 'weekly', vt: 0.18 }],
  ['E每日·vt18', { freq: 'daily', vt: 0.18 }],
  ['G每日·vt12', { freq: 'daily', vt: 0.12 }],
  ['H混合·每日·vt12', { freq: 'daily', vt: 0.12, blend: true }],
  ['W2周五·vt12', { freq: 'weekly', vt: 0.12 }],
];
var NAVS = {}, YEARS = {};
CONFIGS.forEach(function (c) { NAVS[c[0]] = backtest(Object.assign({ lb: 25 }, c[1])); });

// 逐年段指标
function yearSegs(nav) {
  var segs = {}, y0 = dates[0].slice(0, 4), cur = { y: y0, i0: 0 };
  for (var i = 1; i < nav.length; i++) {
    var y = dates[i].slice(0, 4);
    if (y !== cur.y) { segs[cur.y] = { i0: cur.i0, i1: i - 1 }; cur = { y: y, i0: i }; }
  }
  segs[cur.y] = { i0: cur.i0, i1: nav.length - 1 };
  return segs;
}
function segMetrics(nav, i0, i1) {
  var seg = nav.slice(i0, i1 + 1);
  var yrs = (seg.length - 1) / 244;
  var ann = Math.pow(seg[seg.length - 1] / seg[0], 1 / Math.max(yrs, 1 / 244)) - 1;
  var peak = seg[0], dd = 0;
  for (var i = 1; i < seg.length; i++) { if (seg[i] > peak) peak = seg[i]; dd = Math.min(dd, seg[i] / peak - 1); }
  return { ret: seg[seg.length - 1] / seg[0] - 1, mdd: -dd, calmar: dd < 0 ? ann / (-dd) : 99 };
}
CONFIGS.forEach(function (c) { YEARS[c[0]] = yearSegs(NAVS[c[0]]); });
var ALLY = Object.keys(YEARS[CONFIGS[0][0]]).sort();

// ---- 输出1: 逐年卡玛对照 ----
console.log('== 逐年样本外卡玛 (参数先验固定, 无样本内选择) ==');
var head = '年份  ';
CONFIGS.forEach(c => head += c[0].padStart(14));
console.log(head);
var wins = {}; CONFIGS.forEach(c => wins[c[0]] = 0);
var TESTY = ALLY.filter(y => y >= '2014'); // 2013为建仓年不计
TESTY.forEach(function (y) {
  var line = y + '  ';
  var best = null, bestV = -99;
  CONFIGS.forEach(function (c) {
    var s = YEARS[c[0]][y];
    var cm = segMetrics(NAVS[c[0]], s.i0, s.i1).calmar;
    line += (cm >= 99 ? '  无回撤' : cm.toFixed(2).padStart(10)) + '   ';
    if (cm > bestV) { bestV = cm; best = c[0]; }
  });
  wins[best]++;
  console.log(line);
});
console.log('逐年卡玛第一的次数: ' + CONFIGS.map(c => c[0] + '=' + wins[c[0]]).join('  '));

// ---- 输出2: 经典walk-forward ----
console.log('\n== Walk-forward (每年用过去年份卡玛选配置, 考核下一年) ==');
var WF_YEARS = [];
for (var y = 2016; y <= 2025; y++) WF_YEARS.push(String(y));
var wfSel = {}, wfNext = {};
WF_YEARS.forEach(function (y) {
  var past = ALLY.filter(yy => yy < y && yy >= '2014');
  var best = null, bestV = -99;
  CONFIGS.forEach(function (c) {
    var s = 0, n = 0;
    past.forEach(function (yy) { var sg = YEARS[c[0]][yy]; s += segMetrics(NAVS[c[0]], sg.i0, sg.i1).calmar; n++; });
    var avg = s / n;
    if (avg > bestV) { bestV = avg; best = c[0]; }
  });
  wfSel[y] = best;
  var sg = YEARS[best][y];
  wfNext[y] = segMetrics(NAVS[best], sg.i0, sg.i1);
});
WF_YEARS.forEach(function (y) {
  console.log(y + ': 选中 ' + wfSel[y].padEnd(14) + ' 次年卡玛 ' + wfNext[y].calmar.toFixed(2).padStart(6) + '  收益 ' + (wfNext[y].ret * 100).toFixed(1) + '%');
});
var wfr = WF_YEARS.map(y => wfNext[y].calmar);
console.log('Walk-forward 算术平均卡玛: ' + (wfr.reduce((a, b) => a + b, 0) / wfr.length).toFixed(3) + '  最差年 ' + Math.min.apply(null, wfr).toFixed(2));

// 固定策略同口径对照(2016-2025)
console.log('\n== 固定策略对照 (2016-2025逐年卡玛统计) ==');
CONFIGS.forEach(function (c) {
  var rs = WF_YEARS.map(function (y) { var sg = YEARS[c[0]][y]; return segMetrics(NAVS[c[0]], sg.i0, sg.i1).calmar; });
  var avg = rs.reduce((a, b) => a + b, 0) / rs.length;
  console.log(c[0].padEnd(14) + ' 算术平均卡玛 ' + avg.toFixed(3).padStart(6) + '  最差年 ' + Math.min.apply(null, rs).toFixed(2).padStart(6) + '  逐年: ' + rs.map(v => v.toFixed(1)).join('/'));
});

// ---- 输出3: 子期稳定性 ----
console.log('\n== 子期稳定性 (全窗口指标) ==');
CONFIGS.forEach(function (c) {
  var m1 = segMetrics(NAVS[c[0]], 0, YEARS[c[0]]['2019'].i1);
  var s20 = YEARS[c[0]]['2020'];
  var m2 = segMetrics(NAVS[c[0]], s20.i0, NAVS[c[0]].length - 1);
  console.log(c[0].padEnd(14) + ' 2013-2019: 年化 ' + (m1.ret >= 0 ? '+' : '') + (Math.pow(1 + m1.ret, 1 / 6.4) * 100 - 100).toFixed(1) + '%/年 回撤-' + (m1.mdd * 100).toFixed(1) + '% 卡玛' + m1.calmar.toFixed(2)
    + '  |  2020-2026: 年化 ' + (Math.pow(1 + m2.ret, 1 / 6.7) * 100 - 100).toFixed(1) + '%/年 回撤-' + (m2.mdd * 100).toFixed(1) + '% 卡玛' + m2.calmar.toFixed(2));
});
