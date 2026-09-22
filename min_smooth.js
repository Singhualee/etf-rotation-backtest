// min_smooth.js — 逐年收益离散度的平滑手段对比 (2026-09-22)
// 手段: ①混合动量(20/25/30日均值) ②降低波动目标 ③风险腿分散到最强两只
// 口径: 长历史窗口(替代518880/511010), 周五调仓, 避险(最强<0转国债), 0.1%成本
var fs = require('fs');
eval(fs.readFileSync('data.js', 'utf8'));

// ---- 数据准备: 用 extended 序列按"快照首日对齐比例"整体缩放 ----
function snap(code) { return ETF_DATA.etfs.filter(x => x.code === code)[0]; }
function scaled(subKey, code) {
  var sub = ETF_DATA.extended[subKey], s = snap(code);
  var si = sub.dates.indexOf(s.dates[0]);
  if (si < 0) si = 0;
  var ratio = s.closes[0] / sub.closes[si];
  return { code: code, dates: sub.dates, closes: sub.closes.map(c => c * ratio) };
}
var gold = scaled('gold', '518850'), bond = scaled('bond', '511260');
var nq = snap('513100'), hs = snap('510300');
var RAW = [nq, gold, bond, hs];

// ---- 公共日期网格(并集+ffill), 从四者齐备日开始 ----
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
console.log('公共网格:', dates[0], '→', dates[N - 1], ' 共', N, '天 (周五调仓)');

// ---- 工具 ----
function momAt(k, t, lb) { return t - lb >= 0 ? M[k][t] / M[k][t - lb] - 1 : null; }
function blendMom(k, t) {
  var ms = [20, 25, 30].map(lb => momAt(k, t, lb));
  return ms.some(m => m == null) ? null : ms.reduce((a, b) => a + b, 0) / 3;
}
function vol20(k, t) { // 截至t的20日年化波动(用t日及之前)
  if (t < 20) return null;
  var rs = []; for (var i = t - 19; i <= t; i++) rs.push(M[k][i] / M[k][i - 1] - 1);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var v = rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
function isFriday(d) { return new Date(d + 'T12:00:00+08:00').getDay() === 5; }

// ---- 回测 ----
function backtest(opt) {
  // opt: {mom:'single'|'blend', lb:25, topN:1, vt:0.18}
  var nav = [1], w = [0, 0, 0, 0]; w[BOND] = 1;
  var switches = 0, prevKey = '';
  for (var t = 1; t < N; t++) {
    var cost = 0;
    if (isFriday(dates[t - 1]) && t >= 45) { // t-1周五收盘决策, t日起生效
      var mo = [];
      for (k = 0; k < K; k++) mo.push(opt.mom === 'blend' ? blendMom(k, t - 1) : momAt(k, t - 1, opt.lb));
      var ranked = [0, 1, 3].slice().sort((a, b) => (mo[b] == null ? -9 : mo[b]) - (mo[a] == null ? -9 : mo[a]));
      var newW = [0, 0, 0, 0];
      var pos = ranked.filter(k => mo[k] > 0);
      if (mo[ranked[0]] == null || mo[ranked[0]] < 0) newW[BOND] = 1; // 避险
      else {
        var pick = pos.slice(0, opt.topN);
        var share = 1 / pick.length;
        var sig = Math.sqrt(pick.reduce((a, k) => a + share * share * vol20(k, t - 1) ** 2, 0));
        var rw = Math.min(1, opt.vt / sig);
        pick.forEach(k => newW[k] = rw * share);
        newW[BOND] = 1 - rw;
      }
      var turn = 0; for (k = 0; k < K; k++) turn += Math.abs(newW[k] - w[k]);
      cost = 0.001 * turn / 2;
      var key = newW.map(x => x.toFixed(3)).join(',');
      if (key !== prevKey) {
        var from = prevKey === '' ? null : w.indexOf(Math.max.apply(null, w));
        var to = newW.indexOf(Math.max.apply(null, newW));
        if (from !== null && from !== to) switches++;
        prevKey = key;
      }
      w = newW;
    }
    var r = 0; for (k = 0; k < K; k++) r += w[k] * (M[k][t] / M[k][t - 1] - 1);
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
function disp(yrs) { // 离散度指标: 标准差/最差年/负年数
  var rs = yrs.map(y => y.ret);
  var mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  var sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) ** 2, 0) / (rs.length - 1));
  return { sd: sd, worst: Math.min.apply(null, rs), negN: rs.filter(r => r < 0).length };
}

// ---- 对拍验证: 自建基线 vs 引擎 ----
eval(fs.readFileSync('engine.js', 'utf8'));
var engEtf = RAW.map((e, i) => ({ code: e.code, label: ['纳指', '黄金', '十年国债', '沪深300'][i], dates: e.dates, closes: e.closes }));
var btE = RotationEngine.runBacktest(engEtf, { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: '511260' }, volTarget: 0.18, volLookback: 20 });
var mE = RotationEngine.computeMetrics(btE, { rf: 0.02 });
console.log('\n[对拍] 引擎基线(25日/vt18%): 年化 ' + (mE.annualized * 100).toFixed(2) + '%  回撤 ' + (mE.maxDD * 100).toFixed(2) + '%');
var btM = backtest({ mom: 'single', lb: 25, topN: 1, vt: 0.18 });
var mM = metricsOf(btM.nav);
console.log('[对拍] 自建基线(25日/vt18%): 年化 ' + (mM.ann * 100).toFixed(2) + '%  回撤 ' + (mM.mdd * 100).toFixed(2) + '%  (口径应接近)');

// ---- 方案对比 ----
console.log('\n== 平滑方案对比 (长历史 2013→2026, 周五/避险/0.1%成本) ==');
console.log('方案                       年化    回撤    卡玛   年收益σ  最差年  负年数  切换');
var VARIANTS = [
  ['A 基线 25日动量/vt18%', { mom: 'single', lb: 25, topN: 1, vt: 0.18 }],
  ['B 混合动量20+25+30/vt18%', { mom: 'blend', topN: 1, vt: 0.18 }],
  ['C 基线 + vt12%', { mom: 'single', lb: 25, topN: 1, vt: 0.12 }],
  ['D 混合动量 + vt12%', { mom: 'blend', topN: 1, vt: 0.12 }],
  ['E 混合动量/前二各半/vt18%', { mom: 'blend', topN: 2, vt: 0.18 }],
  ['F 混合动量/前二各半/vt12%', { mom: 'blend', topN: 2, vt: 0.12 }],
];
var results = {};
VARIANTS.forEach(function (v) {
  var bt = backtest(v[1]);
  var m = metricsOf(bt.nav), yrs = yearlyRets(bt.nav), ds = disp(yrs);
  results[v[0]] = { bt: bt, m: m, yrs: yrs, ds: ds };
  console.log(
    v[0].padEnd(26) +
    (m.ann * 100).toFixed(1).padStart(5) + '%' +
    (m.mdd * 100).toFixed(1).padStart(7) + '%' +
    m.calmar.toFixed(2).padStart(7) +
    (ds.sd * 100).toFixed(1).padStart(7) + 'pp' +
    (ds.worst * 100).toFixed(1).padStart(7) + '%' +
    String(ds.negN).padStart(6) +
    String(bt.switches).padStart(6)
  );
});

// ---- 分年明细: 基线A vs 混合动量B vs 混合动量+vt12 D ----
console.log('\n== 分年收益: A基线 / B混合动量 / D混合+vt12% ==');
var ya = results['A 基线 25日动量/vt18%'].yrs,
  yb = results['B 混合动量20+25+30/vt18%'].yrs,
  yd = results['D 混合动量 + vt12%'].yrs;
ya.forEach(function (y, i) {
  var f = x => (x.ret * 100).toFixed(1).padStart(6) + '%';
  console.log(y.year + ':  A ' + f(y) + '  B ' + f(yb[i]) + '  D ' + f(yd[i]));
});
