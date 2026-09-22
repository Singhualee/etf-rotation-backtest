// min_strategies.js — 经典策略族横向对比 (2026-09-23)
// 同一数据(长历史2013→2026)、同一成本(0.1%)、同一口径, 对比现行动量策略
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
var RAW = [snap('513100'), gold, bond, snap('510300')]; // 0纳指 1黄金 2国债 3沪深300
var dateSet = {};
RAW.forEach(e => e.dates.forEach(d => dateSet[d] = true));
var dates = Object.keys(dateSet).sort();
var M = RAW.map(e => {
  var map = {}, out = [], last = null;
  e.dates.forEach((d, i) => map[d] = e.closes[i]);
  dates.forEach(d => { if (map[d] !== undefined) last = map[d]; out.push(last); });
  return out;
});
var K = 4, NQ = 0, AU = 1, BD = 2, HS = 3;
var start = 0;
for (var i = 0; i < dates.length; i++) if (M.every(col => col[i] != null)) { start = i; break; }
dates = dates.slice(start); M = M.map(c => c.slice(start));
var N = dates.length;

function vol20(k, t) {
  if (t < 20) return null;
  var rs = []; for (var i = t - 19; i <= t; i++) rs.push(M[k][i] / M[k][i - 1] - 1);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var v = rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function momAt(k, t, lb) { return t - lb >= 0 ? M[k][t] / M[k][t - lb] - 1 : null; }
function blendMom(k, t) { var ms = [20, 25, 30].map(lb => momAt(k, t, lb)); return ms.some(m => m == null) ? null : ms.reduce((a, b) => a + b, 0) / 3; }
function isFriday(d) { return new Date(d + 'T12:00:00+08:00').getDay() === 5; }
function monthOf(d) { return d.slice(0, 7); }
function qMonth(d) { return ['01', '04', '07', '10'].indexOf(d.slice(5, 7)) >= 0; }

// 通用回测器: 每天判断是否调仓日, 用t-1收盘数据算目标权重, t日生效
function backtest(opt) {
  // opt: {schedule:'weekly'|'monthly'|'quarterly'|'daily', target:function(t)->weights[4]}
  var nav = [1], w = [0, 0, 0, 0]; w[BD] = 1;
  var lastPeriod = '', switches = 0;
  for (var t = 1; t < N; t++) {
    var d = dates[t - 1], rebal = false, period = '';
    if (opt.schedule === 'weekly') { rebal = isFriday(d); period = d; }
    else if (opt.schedule === 'monthly') { rebal = monthOf(d) !== lastPeriod; period = monthOf(d); }
    else if (opt.schedule === 'quarterly') { rebal = qMonth(d) && monthOf(d) !== lastPeriod; period = monthOf(d); }
    else if (opt.schedule === 'daily') rebal = true;
    var cost = 0;
    if (rebal && t >= 60) {
      var newW = opt.target(t - 1);
      var turn = 0; for (var k = 0; k < K; k++) turn += Math.abs(newW[k] - w[k]);
      cost = 0.001 * turn / 2;
      var held = w.indexOf(Math.max.apply(null, w)), to = newW.indexOf(Math.max.apply(null, newW));
      if (held !== to && Math.max.apply(null, newW) - Math.max.apply(null, w) > 0.05) switches++;
      w = newW; lastPeriod = period;
    }
    var r = 0; for (k = 0; k < K; k++) r += w[k] * (M[k][t] / M[k][t - 1] - 1);
    nav.push(nav[nav.length - 1] * (1 + r) * (1 - cost));
  }
  return { nav: nav, switches: switches };
}
function invVolW(codes, t) { // 逆波动率加权
  var iv = codes.map(k => 1 / vol20(k, t)), s = iv.reduce((a, b) => a + b, 0);
  var w = [0, 0, 0, 0]; codes.forEach((k, i) => w[k] = iv[i] / s); return w;
}
function metricsOf(nav) {
  var yrs = (nav.length - 1) / 244;
  var ann = Math.pow(nav[nav.length - 1] / nav[0], 1 / yrs) - 1;
  var peak = nav[0], dd = 0;
  for (var i = 1; i < nav.length; i++) { if (nav[i] > peak) peak = nav[i]; dd = Math.min(dd, nav[i] / peak - 1); }
  return { ann: ann, mdd: -dd, calmar: ann / (-dd) };
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

// ---- 策略定义 ----
function momTarget(t) { // 现行动量策略: 周五/混合动量/vt18
  var mo = [];
  for (k = 0; k < K; k++) mo.push(blendMom(k, t));
  var ranked = [0, 1, 3].slice().sort((a, b) => (mo[b] == null ? -9 : mo[b]) - (mo[a] == null ? -9 : mo[a]));
  var w = [0, 0, 0, 0];
  if (mo[ranked[0]] == null || mo[ranked[0]] < 0) { w[BD] = 1; return w; }
  var sig = vol20(ranked[0], t);
  var rw = Math.min(1, 0.18 / sig);
  w[ranked[0]] = rw; w[BD] = 1 - rw;
  return w;
}
var STRATS = [
  ['★ 动量轮动(现行)', { schedule: 'weekly', target: momTarget }],
  ['S1 等权·季调', { schedule: 'quarterly', target: function () { return [0.25, 0.25, 0.25, 0.25]; } }],
  ['S2 逆波动率·月调', { schedule: 'monthly', target: function (t) { return invVolW([NQ, AU, BD, HS], t); } }],
  ['S3 风险平价60/40·月调', { schedule: 'monthly', target: function (t) { var w = invVolW([NQ, AU, HS], t); w[BD] = 0.4; var s = 0.6; for (var k = 0; k < 4; k++) if (k !== BD) w[k] *= s; return w; } }],
  ['S4 趋势均线200·周调', { schedule: 'weekly', target: function (t) {
      var ok = [NQ, AU, HS].filter(k => t >= 200 && M[k][t] > M[k][t - 200]);
      var w = [0, 0, 0, 0];
      if (!ok.length) { w[BD] = 1; return w; }
      ok.forEach(k => w[k] = 1 / ok.length * 0.9); w[BD] = 0.1; return w;
    } }],
  ['S5 股债60/40·月调', { schedule: 'monthly', target: function () { return [0.3, 0, 0.4, 0.3]; } }],
  ['S6 金债各半·月调', { schedule: 'monthly', target: function () { return [0, 0.5, 0.5, 0]; } }],
  ['S7 简化全天候·月调', { schedule: 'monthly', target: function () { return [0.125, 0.25, 0.5, 0.125]; } }],
];
console.log('== 策略族对比 (长历史 2013→2026, 成本0.1%, 同一数据口径) ==');
console.log('策略                      年化    回撤    卡玛   年收益σ  最差年  负年数');
var R = {};
STRATS.forEach(function (s) {
  var bt = backtest(s[1]);
  var m = metricsOf(bt.nav), yrs = yearlyRets(bt.nav);
  var rs = yrs.map(y => y.ret), mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) ** 2, 0) / (rs.length - 1));
  var worst = Math.min.apply(null, rs), negN = rs.filter(r => r < 0).length;
  R[s[0]] = { m: m, yrs: yrs, sd: sd };
  console.log(
    s[0].padEnd(20) +
    (m.ann * 100).toFixed(1).padStart(5) + '%' +
    (m.mdd * 100).toFixed(1).padStart(7) + '%' +
    m.calmar.toFixed(2).padStart(7) +
    (sd * 100).toFixed(1).padStart(8) + 'pp' +
    (worst * 100).toFixed(1).padStart(7) + '%' +
    String(negN).padStart(6)
  );
});

// 分年明细: 现行动量 vs 综合表现最好的两个静态策略
console.log('\n== 分年收益 ==');
var names = ['★ 动量轮动(现行)', 'S3 风险平价60/40·月调', 'S4 趋势均线200·周调', 'S7 简化全天候·月调'];
var hdr = '年份  ';
names.forEach(n => hdr += n.slice(0, 10).padStart(12));
console.log(hdr);
R[names[0]].yrs.forEach(function (y, i) {
  var line = y.year + '  ';
  names.forEach(n => {
    var r = R[n].yrs[i] ? R[n].yrs[i].ret : 0;
    line += ((r * 100).toFixed(1) + '%').padStart(12);
  });
  console.log(line);
});
