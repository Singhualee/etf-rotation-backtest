// min_capital3.js — 国债腿缺失量化: 缺失部分现金按不同收益率计息(活期/逆回购), 对比理想引擎
var fs = require('fs'), path = require('path'), dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var opts = { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: '511260' }, volTarget: 0.15 };
var bt = RotationEngine.runBacktest(ETF_DATA.etfs, opts);
var etfs = ETF_DATA.etfs, codes = etfs.map(function (e) { return e.code; });
var K = codes.length, bondCode = '511260', kb = codes.indexOf(bondCode);

function closeAt(k, date) {
  var e = etfs[k], dts = e.dates, lo = 0, hi = dts.length - 1, ans = -1;
  while (lo <= hi) { var m = (lo + hi) >> 1; if (dts[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? e.closes[ans] : null;
}
var rebMap = {};
bt.rebalances.forEach(function (r) {
  if (!r.w) return;
  var m = {};
  Object.keys(r.w).forEach(function (k) {
    var c = /^\d+$/.test(k) ? codes[+k] : k;
    m[c] = (m[c] || 0) + r.w[k];
  });
  rebMap[r.date] = m;
});

function metricsOf(nav) {
  var n = nav.length, total = nav[n - 1] / nav[0] - 1, yrs = n / 244;
  var ann = Math.pow(1 + total, 1 / yrs) - 1, peak = nav[0], mdd = 0, i;
  for (i = 0; i < n; i++) { if (nav[i] > peak) peak = nav[i]; var dd = nav[i] / peak - 1; if (dd < mdd) mdd = dd; }
  return { ann: ann, mdd: mdd };
}
var ideal = metricsOf(bt.nav);

function lotBacktest(C0, cashY) {
  var cash = C0, lots = []; for (var k = 0; k < K; k++) lots.push(0);
  var dates = bt.dates, n = dates.length, rebSet = {};
  Object.keys(rebMap).forEach(function (d) { rebSet[d] = 1; });
  var twCur = null, missSum = 0, nMissDays = 0;
  for (var i = 0; i < n; i++) {
    var d = dates[i];
    if (rebSet[d]) {
      var tw = rebMap[d], V = cash;
      for (k = 0; k < K; k++) V += lots[k] * 100 * closeAt(k, d);
      var newLots = [], turnover = 0;
      for (k = 0; k < K; k++) {
        var p = closeAt(k, d); if (p == null) { newLots.push(lots[k]); continue; }
        newLots.push(Math.floor((tw[codes[k]] || 0) * V / (p * 100)));
      }
      var pb = closeAt(kb, d), cashNow = cash;
      for (k = 0; k < K; k++) { if (k === kb) continue; var pk = closeAt(k, d); if (pk == null) continue; cashNow -= (newLots[k] - lots[k]) * pk * 100; }
      var bDesired = Math.floor((tw[bondCode] || 0) * V / (pb * 100));
      var bCap = lots[kb] + Math.floor((cashNow * 0.998) / (pb * 100));
      newLots[kb] = bDesired >= lots[kb] ? Math.min(bDesired, bCap) : bDesired;
      for (k = 0; k < K; k++) { var p2 = closeAt(k, d); if (p2 == null) continue; turnover += Math.abs(newLots[k] - lots[k]) * p2 * 100; }
      var cost = turnover * 0.001 / 2;
      for (k = 0; k < K; k++) { var p3 = closeAt(k, d); if (p3 == null) continue; cash -= (newLots[k] - lots[k]) * p3 * 100; lots[k] = newLots[k]; }
      cash -= cost;
      twCur = tw;
    }
    // 每日: 现金计息 + 统计缺失国债权重
    cash *= (1 + cashY / 244);
    var V2 = cash;
    for (k = 0; k < K; k++) { var p4 = closeAt(k, d); if (p4 != null) V2 += lots[k] * 100 * p4; }
    if (twCur) {
      var bwT = twCur[bondCode] || 0;
      var bwA = V2 > 0 ? (lots[kb] * closeAt(kb, d) * 100) / V2 : 0;
      var miss = bwT - bwA;
      if (miss > 0.001) { missSum += miss; nMissDays++; }
    }
  }
  var m = metricsOf([]);
  var navRe = null; // 重跑一遍拿净值(简化: 直接用V2序列, 此处重算)
  // 重新收集净值: 为简洁, 上面未存nav, 用循环再算代价高; 改为在此返回近似—改为存储
  return null;
}
// 上面的 metricsOf([]) 不对 — 重写: 在循环里存nav
function lotBacktest2(C0, cashY) {
  var cash = C0, lots = []; for (var k = 0; k < K; k++) lots.push(0);
  var dates = bt.dates, n = dates.length, rebSet = {}, nav = [];
  Object.keys(rebMap).forEach(function (d) { rebSet[d] = 1; });
  var twCur = null, missSum = 0, nMissDays = 0;
  for (var i = 0; i < n; i++) {
    var d = dates[i];
    if (rebSet[d]) {
      var tw = rebMap[d], V = cash;
      for (k = 0; k < K; k++) V += lots[k] * 100 * closeAt(k, d);
      var newLots = [], turnover = 0;
      for (k = 0; k < K; k++) {
        var p = closeAt(k, d); if (p == null) { newLots.push(lots[k]); continue; }
        newLots.push(Math.floor((tw[codes[k]] || 0) * V / (p * 100)));
      }
      var pb = closeAt(kb, d), cashNow = cash;
      for (k = 0; k < K; k++) { if (k === kb) continue; var pk = closeAt(k, d); if (pk == null) continue; cashNow -= (newLots[k] - lots[k]) * pk * 100; }
      var bDesired = Math.floor((tw[bondCode] || 0) * V / (pb * 100));
      var bCap = lots[kb] + Math.floor((cashNow * 0.998) / (pb * 100));
      newLots[kb] = bDesired >= lots[kb] ? Math.min(bDesired, bCap) : bDesired;
      for (k = 0; k < K; k++) { var p2 = closeAt(k, d); if (p2 == null) continue; turnover += Math.abs(newLots[k] - lots[k]) * p2 * 100; }
      var cost = turnover * 0.001 / 2;
      for (k = 0; k < K; k++) { var p3 = closeAt(k, d); if (p3 == null) continue; cash -= (newLots[k] - lots[k]) * p3 * 100; lots[k] = newLots[k]; }
      cash -= cost;
      twCur = tw;
    }
    cash *= (1 + cashY / 244);
    var V2 = cash;
    for (k = 0; k < K; k++) { var p4 = closeAt(k, d); if (p4 != null) V2 += lots[k] * 100 * p4; }
    nav.push(V2);
    if (twCur) {
      var bwT = twCur[bondCode] || 0;
      var bwA = V2 > 0 ? (lots[kb] * closeAt(kb, d) * 100) / V2 : 0;
      var miss = bwT - bwA;
      if (miss > 0.001) { missSum += miss; nMissDays++; }
    }
  }
  var m = metricsOf(nav);
  m.avgMiss = missSum / n;
  m.missDayPct = nMissDays / n;
  m.ann = m.ann; m.mdd = m.mdd;
  return m;
}

console.log('理想引擎: 年化=' + (ideal.ann * 100).toFixed(2) + '%  回撤=' + (ideal.mdd * 100).toFixed(2) + '%  (511260同期年化 3.96%)');
console.log('');
var tiers = [12000, 14000, 20000, 30000, 50000, 100000];
var yields = [['活期~0.25%', 0.0025], ['逆回购/货基~1.5%', 0.015]];
tiers.forEach(function (C) {
  var b0 = lotBacktest2(C, 0);
  console.log('资金 ' + (C / 10000).toFixed(1) + '万: 0息现金 年化=' + (b0.ann * 100).toFixed(2) + '%  平均缺失国债权重=' + (b0.avgMiss * 100).toFixed(1) + '%  有缺失的交易日占比=' + (b0.missDayPct * 100).toFixed(0) + '%');
  yields.forEach(function (y) {
    var b = lotBacktest2(C, y[1]);
    var loss = ideal.ann - b.ann;
    console.log('   现金按' + y[0] + '计息 → 年化=' + (b.ann * 100).toFixed(2) + '%  与理想差=' + (loss * 100).toFixed(2) + 'pp');
  });
  console.log('');
});
