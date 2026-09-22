// min_rpexpand.js — 扩池对风险平价稳定度的实证 (2026-09-23)
// 结构不变: 40%国债 + 60%风险资产(逆波动率加权, 月初再平衡)
// Pool A: 风险资产=纳指/黄金/沪深300 (3只) | Pool B: +豆粕/油气/日经 (6只)
// 同一窗口 2020-01→2026-09, 成本0.1%
var fs = require('fs');
eval(fs.readFileSync('data.js', 'utf8'));

function snap(code) { return ETF_DATA.etfs.filter(x => x.code === code)[0]; }
function scaled(subKey, code) {
  var sub = ETF_DATA.extended[subKey], s = snap(code);
  var si = sub.dates.indexOf(s.dates[0]); if (si < 0) si = 0;
  var ratio = s.closes[0] / sub.closes[si];
  return { code: code, dates: sub.dates, closes: sub.closes.map(c => c * ratio) };
}
function loadFile(f, code, label) {
  var o = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { code: code, label: label, dates: o.dates, closes: o.closes };
}
var gold = scaled('gold', '518850'), bond = scaled('bond', '511260');
var ASSETS = [
  { code: '513100', label: '纳指', dates: snap('513100').dates, closes: snap('513100').closes },
  { code: '518850', label: '黄金', dates: gold.dates, closes: gold.closes },
  { code: '511260', label: '国债', dates: bond.dates, closes: bond.closes },
  { code: '510300', label: '沪深300', dates: snap('510300').dates, closes: snap('510300').closes },
  loadFile('/tmp/ext_159985.json', '159985', '豆粕'),
  loadFile('/tmp/ext_162411.json', '162411', '油气'),
  loadFile('/tmp/ext_513520.json', '513520', '日经'),
];
var L = {}; ASSETS.forEach((a, i) => L[a.code] = i);
var dateSet = {};
ASSETS.forEach(e => e.dates.forEach(d => dateSet[d] = true));
var dates = Object.keys(dateSet).sort();
var M = ASSETS.map(e => {
  var map = {}, out = [], last = null;
  e.dates.forEach((d, i) => map[d] = e.closes[i]);
  dates.forEach(d => { if (map[d] !== undefined) last = map[d]; out.push(last); });
  return out;
});
var start = 0;
for (var i = 0; i < dates.length; i++) if (M.every(col => col[i] != null)) { start = i; break; }
dates = dates.slice(start); M = M.map(c => c.slice(start));
var N = dates.length, K = ASSETS.length, BD = L['511260'];
console.log('公共窗口:', dates[0], '→', dates[N - 1], ' 共', N, '交易日');

function vol20(k, t) {
  if (t < 20) return null;
  var rs = []; for (var i = t - 19; i <= t; i++) rs.push(M[k][i] / M[k][i - 1] - 1);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var v = rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function monthOf(d) { return d.slice(0, 7); }

function rpBacktest(riskCodes, label) {
  var nav = [1], w = {}; riskCodes.concat([BD]).forEach(k => w[k] = 0); w[BD] = 1;
  var lastM = '', wtsLog = [];
  for (var t = 1; t < N; t++) {
    var cost = 0;
    if (monthOf(dates[t - 1]) !== lastM && t >= 60) {
      var newW = {}; riskCodes.concat([BD]).forEach(k => newW[k] = 0);
      var iv = riskCodes.map(k => 1 / vol20(k, t - 1)), s = iv.reduce((a, b) => a + b, 0);
      riskCodes.forEach((k, i) => newW[k] = 0.6 * iv[i] / s);
      newW[BD] = 0.4;
      var turn = 0; riskCodes.concat([BD]).forEach(k => turn += Math.abs(newW[k] - w[k]));
      cost = 0.001 * turn / 2;
      w = newW; lastM = monthOf(dates[t - 1]);
      if (dates[t - 1] > dates[N - 1].slice(0, 4) + '-06') wtsLog.push({ d: dates[t - 1], w: newW });
    }
    var r = 0; for (var k in w) r += w[k] * (M[k][t] / M[k][t - 1] - 1);
    nav.push(nav[nav.length - 1] * (1 + r) * (1 - cost));
  }
  return { nav: nav, wtsLog: wtsLog };
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
function report(name, res) {
  var m = metricsOf(res.nav), yrs = yearlyRets(res.nav);
  var rs = yrs.map(y => y.ret), mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) ** 2, 0) / (rs.length - 1));
  console.log(name.padEnd(22) + (m.ann * 100).toFixed(1).padStart(5) + '%' + (m.mdd * 100).toFixed(1).padStart(7) + '%' +
    m.calmar.toFixed(2).padStart(7) + (sd * 100).toFixed(1).padStart(7) + 'pp' +
    (Math.min.apply(null, rs) * 100).toFixed(1).padStart(8) + '%' + String(rs.filter(r => r < 0).length).padStart(6));
  console.log('  分年: ' + yrs.map(y => y.year.slice(2) + '=' + (y.ret * 100).toFixed(1) + '%').join(' '));
  return { m: m, sd: sd };
}

var RISK_A = [L['513100'], L['518850'], L['510300']];
var RISK_B = [L['513100'], L['518850'], L['510300'], L['159985'], L['162411'], L['513520']];
console.log('\n== 风险平价60/40: 扩池前后 (同窗口) ==');
console.log('策略                    年化    回撤    卡玛   年收益σ   最差年  负年数');
var rA = report('A池(3只风险资产)', rpBacktest(RISK_A));
var rB = report('B池(6只风险资产)', rpBacktest(RISK_B));

// 相关性矩阵(日收益, 全窗口)
console.log('\n== 日收益相关系数矩阵 ==');
var codes = RISK_B.map(k => ASSETS[k].label);
var hdr = '        '; codes.forEach(c => hdr += c.padStart(8)); console.log(hdr);
codes.forEach(function (c1, i1) {
  var k1 = RISK_B[i1], line = c1.padEnd(6) + '  ';
  codes.forEach(function (c2, i2) {
    var k2 = RISK_B[i2], r1 = [], r2 = [];
    for (var t = 1; t < N; t++) { r1.push(M[k1][t] / M[k1][t - 1] - 1); r2.push(M[k2][t] / M[k2][t - 1] - 1); }
    var m1 = r1.reduce((a, b) => a + b, 0) / r1.length, m2 = r2.reduce((a, b) => a + b, 0) / r2.length;
    var cov = 0, v1 = 0, v2 = 0;
    for (var i = 0; i < r1.length; i++) { cov += (r1[i] - m1) * (r2[i] - m2); v1 += (r1[i] - m1) ** 2; v2 += (r2[i] - m2) ** 2; }
    line += (cov / Math.sqrt(v1 * v2)).toFixed(2).padStart(8);
  });
  console.log(line);
});

// 各资产年化波动与收益
console.log('\n== 各风险资产特征 (同窗口) ==');
RISK_B.forEach(function (k) {
  var yrs = (N - 1) / 244;
  var ann = Math.pow(M[k][N - 1] / M[k][0], 1 / yrs) - 1;
  var peak = M[k][0], dd = 0;
  for (var i = 1; i < N; i++) { if (M[k][i] > peak) peak = M[k][i]; dd = Math.min(dd, M[k][i] / peak - 1); }
  console.log(ASSETS[k].label.padEnd(6) + ' 年化 ' + (ann * 100).toFixed(1).padStart(6) + '%   波动 ' + (vol20(k, N - 1) * 100).toFixed(1).padStart(5) + '%   回撤 ' + (dd * 100).toFixed(1) + '%');
});
