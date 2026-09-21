// min_capital.js — 测算整手(100股)约束下, 波动目标15%策略所需最低资金
// 逻辑: 取引擎全部调仓日的目标权重, 对候选资金 C 模拟"整手买入":
//   风险腿手数 = floor(w_r*C / (价*100)), 国债手数 = floor(剩余资金 / (价*100))
//   统计实际权重与目标权重的偏差、闲置现金比例, 找出可行资金门槛
var fs = require('fs'), path = require('path'), dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var opts = { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: '511260' }, volTarget: 0.15 };
var bt = RotationEngine.runBacktest(ETF_DATA.etfs, opts);
var codes = ETF_DATA.etfs.map(function (e) { return e.code; });
var labels = {}; ETF_DATA.etfs.forEach(function (e) { labels[e.code] = e.label; });

// 每个 code: 日期->收盘价 (用各自序列, 找 <= rebalance date 的最近收盘)
function closeAt(code, date) {
  var e = ETF_DATA.etfs.filter(function (x) { return x.code === code; })[0];
  var p = e.closes || e.close || e.prices;
  var dts = e.dates;
  var lo = 0, hi = dts.length - 1, ans = -1;
  while (lo <= hi) { var m = (lo + hi) >> 1; if (dts[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? p[ans] : null;
}
// 探测价格字段名
(function () {
  var e = ETF_DATA.etfs[0];
  console.log('字段:', Object.keys(e).join(','));
})();

var rebs = bt.rebalances;
console.log('调仓次数(含重新定仓):', rebs.length, ' 区间:', rebs[0].date, '~', rebs[rebs.length - 1].date);

// 现价与整手成本概览
var last = ETF_DATA.meta.endDate;
console.log('\n各标的最新收盘价与整手成本:');
codes.forEach(function (c) {
  var p = closeAt(c, last);
  console.log(' ', c, labels[c], '价=' + p.toFixed(3), '整手≈' + Math.round(p * 100) + '元');
});

// 权重分布
var wrs = rebs.map(function (r) {
  var w = r.w; if (!w) return { d: r.date, wr: 1 };
  // w 的 key 可能是索引或 code
  var keys = Object.keys(w);
  var isIdx = keys.every(function (k) { return codes[+k] !== undefined && /^\d+$/.test(k); });
  var wr = 0;
  keys.forEach(function (k) {
    var c = isIdx ? codes[+k] : k;
    if (c !== '511260') wr += w[k];
  });
  return { d: r.date, wr: wr, riskCodes: keys.map(function (k) { return isIdx ? codes[+k] : k; }).filter(function (c) { return c !== '511260'; }) };
});
wrs.sort(function (a, b) { return a.wr - b.wr; });
console.log('\n风险腿目标权重分布: min=' + (wrs[0].wr * 100).toFixed(1) + '% p5=' + (wrs[Math.floor(wrs.length * 0.05)].wr * 100).toFixed(1) + '% 中位=' + (wrs[Math.floor(wrs.length / 2)].wr * 100).toFixed(1) + '% p95=' + (wrs[Math.floor(wrs.length * 0.95)].wr * 100).toFixed(1) + '% max=' + (wrs[wrs.length - 1].wr * 100).toFixed(1) + '%');
var nRiskOff = wrs.filter(function (x) { return x.wr === 0; }).length;
console.log('全额避险(100%国债)次数:', nRiskOff);

// 整手模拟
function simulate(C) {
  var errs = [], leftover = [], nNoBond = 0, nNoRisk = 0, worst = null;
  rebs.forEach(function (r, i) {
    var info = wrs[i];
    var d = r.date;
    var riskCodes = info.riskCodes || [];
    var wmap = r.w || {};
    var keys = Object.keys(wmap);
    var isIdx = keys.length && /^\d+$/.test(keys[0]);
    // 风险腿各标的金额
    var riskBudget = 0, plan = [];
    keys.forEach(function (k) {
      var c = isIdx ? codes[+k] : k;
      if (c === '511260') return;
      var p = closeAt(c, d); if (p == null) return;
      var amt = wmap[k] * C; riskBudget += amt;
      plan.push({ code: c, p: p, amt: amt });
    });
    var bondW = 1 - (riskBudget / C);
    var spent = 0;
    plan.forEach(function (t) {
      var lots = Math.floor(t.amt / (t.p * 100));
      t.lots = lots; t.spend = lots * t.p * 100; spent += t.spend;
    });
    var riskActual = spent / C;
    // 国债
    var bp = closeAt('511260', d);
    var bamt = (C - spent) * (riskBudget > 0 ? (bondW / Math.max(1e-9, 1 - riskBudget / C) || 1) : 1);
    // 简化: 剩余全部按目标国债权重*剩余买, 取整手
    var blots = Math.floor((C - spent) * (bondW / Math.max(1e-9, 1 - riskActual)) / (bp * 100));
    if (riskBudget > 0 && blots < 1 && bondW > 0.05) nNoBond++;
    var bspend = blots * bp * 100;
    var cash = C - spent - bspend;
    var totalInv = spent + bspend;
    // 误差: 实际风险权重(以投入资金为基数) vs 目标
    var err = riskBudget > 0 ? Math.abs(riskActual / (totalInv / C) - riskBudget / C) : (bondW > 0.05 ? 0 : 0);
    // 更直观: 国债应占比 vs 实际占比 之差, 以及闲置现金
    var bondTarget = 1 - riskBudget / C;
    var bondActual = totalInv > 0 ? bspend / totalInv : 0;
    var err2 = Math.abs(bondTarget - bondActual);
    errs.push(err2); leftover.push(cash / C);
    if (!worst || err2 > worst.err) worst = { date: d, err: err2, C: C, wr: riskBudget / C };
    if (riskBudget > 0 && plan.every(function (t) { return t.lots === 0; })) nNoRisk++;
  });
  errs.sort(function (a, b) { return a - b; });
  function pct(q) { return errs[Math.min(errs.length - 1, Math.floor(errs.length * q))]; }
  return {
    C: C, n: errs.length,
    p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: errs[errs.length - 1],
    nOver1pp: errs.filter(function (e) { return e > 0.01; }).length,
    nOver2pp: errs.filter(function (e) { return e > 0.02; }).length,
    nOver5pp: errs.filter(function (e) { return e > 0.05; }).length,
    maxLeftover: Math.max.apply(null, leftover),
    nNoBond: nNoBond, nNoRisk: nNoRisk, worst: worst,
  };
}

console.log('\n资金档位扫描 (权重偏差=|实际国债占比-目标国债占比|, 整手取整导致):');
console.log('资金    p50    p90    max   >1pp >2pp >5pp  闲置现金max  买不起国债腿次数');
[10000, 12000, 15000, 18000, 20000, 25000, 30000, 35000, 40000, 50000, 60000, 80000, 100000].forEach(function (C) {
  var s = simulate(C);
  console.log(
    (C / 10000).toFixed(1) + '万  ' +
    (s.p50 * 100).toFixed(2) + '%  ' + (s.p90 * 100).toFixed(2) + '%  ' + (s.max * 100).toFixed(2) + '%  ' +
    String(s.nOver1pp).padStart(4) + String(s.nOver2pp).padStart(5) + String(s.nOver5pp).padStart(5) +
    '  ' + (s.maxLeftover * 100).toFixed(1) + '%' + '        ' + s.nNoBond
  );
});
