// min_bad_years.js — 负收益年份改善手段实测 (2026-09-22)
// 思路: 负年成因 = ①whipsaw(2016) ②全市场钝化(2018)
// 药方: ①避险门槛floor(最强动量须>floor才持风险资产,否则国债) ②每日检查避险(而非仅周五)
// 口径: 长历史窗口, 周五调仓(除非daily), 25日动量, 0.1%成本
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
function vol20(k, t) {
  if (t < 20) return null;
  var rs = []; for (var i = t - 19; i <= t; i++) rs.push(M[k][i] / M[k][i - 1] - 1);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var v = rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function isFriday(d) { return new Date(d + 'T12:00:00+08:00').getDay() === 5; }

function backtest(opt) {
  // opt: {lb:25, vt:0.18, floor:0, freq:'weekly'|'daily'}
  var nav = [1], w = [0, 0, 0, 0]; w[BOND] = 1;
  var switches = 0;
  for (var t = 1; t < N; t++) {
    var cost = 0;
    var signalDay = opt.freq === 'daily' || isFriday(dates[t - 1]);
    if (signalDay && t >= 45) {
      var mo = [];
      for (k = 0; k < K; k++) {
        if (opt.blend) { var ms = [20, 25, 30].map(lb => momAt(k, t - 1, lb)); mo.push(ms.some(m => m == null) ? null : ms.reduce((a, b) => a + b, 0) / 3); }
        else mo.push(momAt(k, t - 1, opt.lb));
      }
      var ranked = [0, 1, 3].slice().sort((a, b) => (mo[b] == null ? -9 : mo[b]) - (mo[a] == null ? -9 : mo[a]));
      var newW = [0, 0, 0, 0];
      if (mo[ranked[0]] == null || mo[ranked[0]] < (opt.floor || 0)) newW[BOND] = 1; // 避险(含floor门槛)
      else {
        var sig = vol20(ranked[0], t - 1);
        var rw = Math.min(1, opt.vt / sig);
        newW[ranked[0]] = rw; newW[BOND] = 1 - rw;
      }
      var turn = 0; for (k = 0; k < K; k++) turn += Math.abs(newW[k] - w[k]);
      cost = 0.001 * turn / 2;
      var held = w.indexOf(Math.max.apply(null, w));
      var to = newW.indexOf(Math.max.apply(null, newW));
      if (held !== to) switches++;
      w = newW;
    }
    var r = 0; for (var k = 0; k < K; k++) r += w[k] * (M[k][t] / M[k][t - 1] - 1);
    nav.push(nav[nav.length - 1] * (1 + r) * (1 - cost));
  }
  return { nav: nav, switches: switches };
}
function yearlyRets(nav) {
  var out = [], y0 = dates[0].slice(0, 4), base = nav[0], lastY = y0;
  for (var i = 1; i < nav.length; i++) {
    var y = dates[i].slice(0, 4);
    if (y !== lastY) { out.push({ year: lastY, ret: nav[i - 1] / base - 1 }); base = nav[i - 1]; lastY = y; }
  }
  out.push({ year: lastY, ret: nav[nav.length - 1] / base - 1 });
  return out;
}
function metricsOf(nav) {
  var yrs = (nav.length - 1) / 244;
  var ann = Math.pow(nav[nav.length - 1] / nav[0], 1 / yrs) - 1;
  var peak = nav[0], dd = 0;
  for (var i = 1; i < nav.length; i++) { if (nav[i] > peak) peak = nav[i]; dd = Math.min(dd, nav[i] / peak - 1); }
  return { ann: ann, mdd: -dd, calmar: ann / (-dd) };
}

console.log('== 负年改善手段 (长历史, 25日动量/vt18%/0.1%成本) ==');
console.log('方案                    年化    回撤    卡玛   负年数  最差年   2016    2018   切换');
var VARIANTS = [
  ['A 基线(周五,门槛0)', { freq: 'weekly', floor: 0 }],
  ['B 避险门槛+1%', { freq: 'weekly', floor: 0.01 }],
  ['C 避险门槛+2%', { freq: 'weekly', floor: 0.02 }],
  ['D 避险门槛+3%', { freq: 'weekly', floor: 0.03 }],
  ['E 每日检查避险(门槛0)', { freq: 'daily', floor: 0 }],
  ['F 每日检查+门槛2%', { freq: 'daily', floor: 0.02 }],
  ['G 每日检查+vt12%', { freq: 'daily', floor: 0, vt: 0.12 }],
  ['H 混合动量+每日+vt12%', { freq: 'daily', floor: 0, vt: 0.12, blend: true }],
];
var R = {};
VARIANTS.forEach(function (v) {
  var o = Object.assign({ lb: 25, vt: 0.18 }, v[1]);
  var bt = backtest(o);
  var m = metricsOf(bt.nav), yrs = yearlyRets(bt.nav);
  var neg = yrs.filter(y => y.ret < 0);
  var y16 = yrs.find(y => y.year === '2016'), y18 = yrs.find(y => y.year === '2018');
  R[v[0]] = { bt: bt, yrs: yrs };
  console.log(
    v[0].padEnd(22) +
    (m.ann * 100).toFixed(1).padStart(5) + '%' +
    (m.mdd * 100).toFixed(1).padStart(7) + '%' +
    m.calmar.toFixed(2).padStart(7) +
    String(neg.length).padStart(7) +
    (Math.min.apply(null, yrs.map(y => y.ret)) * 100).toFixed(1).padStart(7) + '%' +
    ((y16 ? y16.ret : 0) * 100).toFixed(1).padStart(7) + '%' +
    ((y18 ? y18.ret : 0) * 100).toFixed(1).padStart(7) + '%' +
    String(bt.switches).padStart(7)
  );
});

// 分年明细: 基线 vs 最优变体
console.log('\n== 分年: A基线 / E每日 / G每日+vt12% / H混合+每日+vt12% ==');
var ya = R['A 基线(周五,门槛0)'].yrs, ye = R['E 每日检查避险(门槛0)'].yrs, yg = R['G 每日检查+vt12%'].yrs, yh = R['H 混合动量+每日+vt12%'].yrs;
ya.forEach(function (y, i) {
  var f = x => (x.ret * 100).toFixed(1).padStart(6) + '%';
  console.log(y.year + ':  A ' + f(y) + '  E ' + f(ye[i]) + '  G ' + f(yg[i]) + '  H ' + f(yh[i]));
});
