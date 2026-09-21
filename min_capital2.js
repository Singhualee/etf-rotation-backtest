// min_capital2.js — 整手(100股)实盘版回测: 从资金C起步, 按引擎调仓信号用整数手交易
// 对比理想引擎(可分数仓位)的年化/回撤, 量化"多少钱才能跑得起这套策略"
var fs = require('fs'), path = require('path'), dir = __dirname;
eval(fs.readFileSync(path.join(dir, 'engine.js'), 'utf8'));
eval(fs.readFileSync(path.join(dir, 'data.js'), 'utf8'));

var opts = { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: '511260' }, volTarget: 0.15 };
var bt = RotationEngine.runBacktest(ETF_DATA.etfs, opts);
var etfs = ETF_DATA.etfs;
var codes = etfs.map(function (e) { return e.code; });
var labels = {}; etfs.forEach(function (e) { labels[e.code] = e.label; });
var K = codes.length;
var bondCode = '511260';

// 每日各code收盘价(按引擎日期对齐: 用 ffill 思路, 直接查各etf序列最近<=date)
var dateIdx = {}; etfs.forEach(function (e, k) {
  dateIdx[k] = {}; e.dates.forEach(function (d, i) { dateIdx[k][d] = i; });
});
function closeAt(k, date) {
  var e = etfs[k], dts = e.dates;
  var lo = 0, hi = dts.length - 1, ans = -1;
  while (lo <= hi) { var m = (lo + hi) >> 1; if (dts[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? e.closes[ans] : null;
}
// 引擎调仓日权重映射到 code
var rebMap = {};
bt.rebalances.forEach(function (r) {
  var w = r.w; if (!w) return;
  var keys = Object.keys(w);
  var m = {};
  keys.forEach(function (k) {
    var c = /^\d+$/.test(k) ? codes[+k] : k;
    m[c] = (m[c] || 0) + w[k];
  });
  rebMap[r.date] = m;
});

function metricsOf(nav) {
  var n = nav.length, first = nav[0];
  var total = nav[n - 1] / nav[0] - 1;
  var yrs = n / 244;
  var ann = Math.pow(1 + total, 1 / yrs) - 1;
  var peak = nav[0], mdd = 0, i;
  for (i = 0; i < n; i++) { if (nav[i] > peak) peak = nav[i]; var dd = nav[i] / peak - 1; if (dd < mdd) mdd = dd; }
  return { ann: ann, mdd: mdd, total: total, calmar: ann / Math.abs(mdd) };
}

// 整手模拟
function lotBacktest(C0, mode) {
  // mode: 'floor'=每腿向下取整(保守, 现金留余), 初始按首个调仓日建仓
  var cash = C0, lots = []; for (var k = 0; k < K; k++) lots.push(0);
  var stat = { nTrades: 0, minComm: 0 };
  var nav = [], dates = bt.dates, n = dates.length;
  var rebDates = Object.keys(rebMap).sort();
  var rebSet = {}; rebDates.forEach(function (d) { rebSet[d] = 1; });
  var nDegenerate = 0, firstBuyDate = null, cashPeak = C0;
  for (var i = 0; i < n; i++) {
    var d = dates[i];
    if (rebSet[d]) {
      var tw = rebMap[d];
      // 目标市值
      var V = cash; for (k = 0; k < K; k++) V += lots[k] * 100 * closeAt(k, d);
      var turnover = 0, newLots = [];
      var kb = codes.indexOf(bondCode);
      var pb = closeAt(kb, d);
      // 先按目标算每腿手数: floor(目标市值/整手价); 再用剩余现金把国债腿尽量补足(不超过目标+1手)
      for (k = 0; k < K; k++) {
        var p = closeAt(k, d); if (p == null) { newLots.push(lots[k]); continue; }
        var tgt = (tw[codes[k]] || 0) * V;
        var nl = Math.floor(tgt / (p * 100));
        newLots.push(nl);
      }
      // 风险腿先成交, 得到交易后现金
      var cashNow = cash;
      for (k = 0; k < K; k++) {
        if (k === kb) continue;
        var pk = closeAt(k, d); if (pk == null) continue;
        cashNow -= (newLots[k] - lots[k]) * pk * 100;
      }
      // 国债腿: 目标手数, 买入不得超过可用现金(留0.2%成本缓冲), 卖出无限制
      var bDesired = Math.floor((tw[bondCode] || 0) * V / (pb * 100));
      var bBuyCap = lots[kb] + Math.floor((cashNow * 0.998) / (pb * 100));
      newLots[kb] = bDesired >= lots[kb] ? Math.min(bDesired, bBuyCap) : bDesired;
      // 计算换手成本(引擎口径近似: 成交额×0.1%÷2)
      for (k = 0; k < K; k++) {
        var p2 = closeAt(k, d); if (p2 == null) continue;
        turnover += Math.abs(newLots[k] - lots[k]) * p2 * 100;
      }
      var cost = turnover * 0.001 / 2;
      // 结算现金
      var nTrades = 0, minCommCost = 0;
      for (k = 0; k < K; k++) {
        var p3 = closeAt(k, d); if (p3 == null) continue;
        var dv = (newLots[k] - lots[k]) * p3 * 100;
        if (dv !== 0) { nTrades++; minCommCost += Math.max(5, Math.abs(dv) * 0.0001); }
        cash -= dv;
        lots[k] = newLots[k];
      }
      cash -= cost;
      stat.nTrades += nTrades; stat.minComm += minCommCost;
      // 退化检测: 目标国债权重>8%但0手
      var bw = tw[bondCode] || 0, bl = lots[codes.indexOf(bondCode)];
      if (bw > 0.08 && bl === 0) nDegenerate++;
    }
    var V2 = cash; for (k = 0; k < K; k++) { var p4 = closeAt(k, d); if (p4 != null) V2 += lots[k] * 100 * p4; }
    if (cash > cashPeak) cashPeak = cash;
    nav.push(V2);
  }
  var m = metricsOf(nav);
  m.nDegenerate = nDegenerate; m.endCashPct = cash / nav[n - 1]; m.C0 = C0;
  m.nTrades = stat.nTrades; m.minCommYr = (stat.minComm / (n / 244)) / C0; // 最低佣金年化拖累
  return m;
}

// 理想引擎基准
var ideal = (function () {
  // bt.nav 即理想净值
  return metricsOf(bt.nav);
})();

console.log('理想引擎(可分数仓位): 年化=' + (ideal.ann * 100).toFixed(2) + '%  最大回撤=' + (ideal.mdd * 100).toFixed(2) + '%  卡玛=' + ideal.calmar.toFixed(2));
console.log('');
console.log('整手实盘模拟 (0.1%成本, 511260一手≈13474元):');
console.log('资金   年化     回撤    卡玛   年化差  回撤差  国债腿缺失次数  期末闲置现金  成交笔数  最低佣金年化拖累');
[10000, 12000, 14000, 15000, 20000, 30000, 40000, 50000, 60000, 80000, 100000, 150000].forEach(function (C) {
  var m = lotBacktest(C);
  console.log(
    (C / 10000).toFixed(1) + '万  ' +
    (m.ann * 100).toFixed(2) + '%  ' + (m.mdd * 100).toFixed(2) + '%  ' + m.calmar.toFixed(2) + '  ' +
    ((m.ann - ideal.ann) * 100).toFixed(2) + 'pp  ' + ((m.mdd - ideal.mdd) * 100).toFixed(2) + 'pp   ' +
    String(m.nDegenerate).padStart(4) + '          ' + (m.endCashPct * 100).toFixed(1) + '%' +
    '        ' + String(m.nTrades).padStart(4) + '      ' + (m.minCommYr * 100).toFixed(2) + '%'
  );
});
