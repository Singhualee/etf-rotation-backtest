// engine.js — ETF 动量轮动回测引擎（纯函数，无 DOM 依赖，浏览器与 Node 通用）
// 策略: 每周五(休市则顺延当周最后交易日)收盘, 比较四只ETF过去20个交易日涨幅, 全仓切换到涨幅最大者
// 假设: 信号与成交同用当日收盘价(无前视偏差), 无手续费/滑点, 前复权价格
(function (global) {
  'use strict';

  function mondayOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    var day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }

  // 0=周一 ... 4=周五 (ISO weekday - 1)
  function weekdayOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    return (d.getUTCDay() + 6) % 7;
  }

  function runBacktest(etfs, options) {
    options = options || {};
    var lookback = options.lookback || 20;
    var K = etfs.length;

    // 1. 联合交易日历（各ETF交易日的并集, 已排序）
    var dateSet = {};
    etfs.forEach(function (e) {
      for (var i = 0; i < e.dates.length; i++) dateSet[e.dates[i]] = true;
    });
    var calendar = Object.keys(dateSet).sort();
    var n = calendar.length;

    // 2. 前向填充: ffill[k][i] = 第k只ETF在calendar[i]的最近可得收盘价
    //    ownIdx[k][i] = 第k只ETF自身序列中 <= calendar[i] 的最大索引
    var ffill = [], ownIdx = [];
    for (var k = 0; k < K; k++) {
      var arrP = [], arrI = [], pi = -1, ds = etfs[k].dates, cs = etfs[k].closes;
      for (var i = 0; i < n; i++) {
        var d = calendar[i];
        while (pi + 1 < ds.length && ds[pi + 1] <= d) pi++;
        arrI.push(pi);
        arrP.push(pi >= 0 ? cs[pi] : null);
      }
      ffill.push(arrP);
      ownIdx.push(arrI);
    }

    // 3. 动量: 第k只ETF在calendar[i]的过去lookback个自身交易日涨幅
    function momentumAt(i, k) {
      var idx = ownIdx[k][i];
      if (idx < lookback) return null;
      var cs = etfs[k].closes;
      return cs[idx] / cs[idx - lookback] - 1;
    }

    // 4. 回测起点: 首个四只ETF均拥有lookback+1个自身交易日数据的日历日
    var startIdx = -1;
    for (var i2 = 0; i2 < n; i2++) {
      var ok = true;
      for (var k2 = 0; k2 < K; k2++) {
        if (ownIdx[k2][i2] < lookback) { ok = false; break; }
      }
      if (ok) { startIdx = i2; break; }
    }
    if (startIdx < 0) throw new Error('数据不足以计算动量');

    // 5. 调仓日: 每个自然周(周一起)调仓一次, 且只在 >= 起点的日期上
    //    rebalanceWeekday: 0=周一 ... 4=周五(默认)
    //    规则: 取当周首个 weekday >= X 的交易日(休市顺延);
    //          若当周 X 之后已无交易日, 提前至当周最后一个交易日(保证每周恰好调仓一次)
    //    注: X=4(周五) 时等价于旧规则"当周最后一个交易日", 与已验证基线完全一致
    var wd = options.rebalanceWeekday === undefined ? 4 : options.rebalanceWeekday;
    if (wd < 0 || wd > 4) throw new Error('rebalanceWeekday 必须在 0(周一)~4(周五) 之间');
    var rebSet = {};
    var curWk = null, wkDays = [];
    function flushWeek() {
      if (curWk === null) return;
      var pick = -1;
      for (var j = 0; j < wkDays.length; j++) {
        if (weekdayOf(calendar[wkDays[j]]) >= wd) { pick = wkDays[j]; break; }
      }
      if (pick < 0) pick = wkDays[wkDays.length - 1];
      rebSet[pick] = true;
    }
    for (var i3 = 0; i3 < n; i3++) {
      if (calendar[i3] < calendar[startIdx]) continue;
      var wk = mondayOf(calendar[i3]);
      if (wk !== curWk) { flushWeek(); curWk = wk; wkDays = []; }
      wkDays.push(i3);
    }
    flushWeek();

    // 6. 找到首个调仓日(回测从该日开始, 净值起点=1)
    var firstRebIdx = -1;
    for (var i4 = startIdx; i4 < n; i4++) {
      if (rebSet[i4]) { firstRebIdx = i4; break; }
    }
    if (firstRebIdx < 0) throw new Error('未找到调仓日');

    // 6.5 可选: 交易成本(每次实际切换持仓扣减净值) 与 绝对动量避险
    var costRate = options.costRate || 0;
    var riskOff = options.riskOff || null;
    var bondK = -1;
    if (riskOff) {
      for (var kb = 0; kb < K; kb++) {
        if (etfs[kb].code === riskOff.bondCode) { bondK = kb; break; }
      }
      if (bondK < 0) throw new Error('riskOff.bondCode 不在标的列表中: ' + riskOff.bondCode);
    }
    // 6.6 可选: 波动率目标(部分仓位)。风险腿仓位 = min(1, volTarget/实现波动率), 余额持避险债券
    //     实现波动率 = 过去 volLookback 个日历交易日日收益标准差 × sqrt(252) 年化
    var volTarget = options.volTarget || 0;
    var volLB = options.volLookback || 20;
    if (volTarget > 0 && bondK < 0) throw new Error('volTarget 需要 riskOff.bondCode 指定避险债券ETF');
    function realizedVol(i, k) {
      var rs = [], m = 0, j;
      if (i - volLB < 0) return null; // 历史不足 volLB 个日历交易日(需访问 j-1 >= 0)
      for (j = i - volLB + 1; j <= i; j++) {
        if (ffill[k][j - 1] == null || ffill[k][j] == null) return null; // == null 同时挡住 null 与越界 undefined
        rs.push(ffill[k][j] / ffill[k][j - 1] - 1);
      }
      if (rs.length < volLB) return null;
      for (j = 0; j < rs.length; j++) m += rs[j];
      m /= rs.length;
      var v = 0;
      for (j = 0; j < rs.length; j++) v += (rs[j] - m) * (rs[j] - m);
      return Math.sqrt(v / (rs.length - 1)) * Math.sqrt(252);
    }

    // 7. 逐日模拟
    var dates = [], nav = [], holding = [], switches = [], rebalances = [];
    var held = null, prevNav = 1;
    var useVol = volTarget > 0;
    var primaryW = []; // 波动率目标开启时: 每日风险腿权重(0~1); 关闭时恒为1
    var w = null, pendingCost = 0;
    for (var i5 = firstRebIdx; i5 < n; i5++) {
      var d5 = calendar[i5];
      if (useVol) {
        // ---- 波动率目标路径: 部分仓位, 权重在调仓日收盘重算, 次日起生效 ----
        var wNew = null;
        if (rebSet[i5]) {
          var best7 = -Infinity, bestK7 = -1, momenta7 = {};
          for (var k5 = 0; k5 < K; k5++) {
            var m7 = momentumAt(i5, k5);
            momenta7[etfs[k5].code] = m7;
            if (m7 !== null && m7 > best7) { best7 = m7; bestK7 = k5; }
          }
          if (bestK7 >= 0) {
            var heldBefore7 = held;
            var chosen7 = bestK7;
            var isRiskOff7 = false;
            if (riskOff && best7 < riskOff.floor) { chosen7 = bondK; isRiskOff7 = chosen7 !== bestK7; }
            var chosenM7 = momenta7[etfs[chosen7].code];
            if (held === null) {
              switches.push({ date: d5, from: null, to: chosen7, momenta: momenta7, riskOff: isRiskOff7 });
              held = chosen7;
            } else if (chosen7 !== held && chosenM7 > momenta7[etfs[held].code]) {
              switches.push({ date: d5, from: held, to: chosen7, momenta: momenta7, riskOff: isRiskOff7 });
              held = chosen7;
            }
            // 重算权重(无论是否切换标的, 每个调仓日都按最新波动率定仓)
            var tw = [];
            for (var k8 = 0; k8 < K; k8++) tw.push(0);
            if (held !== null) {
              if (held === bondK) {
                tw[held] = 1;
              } else {
                var vol8 = realizedVol(i5, held);
                if (vol8 === null || vol8 <= 0) { tw[held] = 1; }
                else { tw[held] = Math.min(1, volTarget / vol8); tw[bondK] = 1 - tw[held]; }
              }
            }
            // 各标的当日20日年化波动率(供展示, 与定仓用的 realizedVol 同源)
            var vols7 = [];
            for (var kv7 = 0; kv7 < K; kv7++) vols7.push(realizedVol(i5, kv7));
            rebalances.push({ date: d5, from: heldBefore7, to: held, riskOff: isRiskOff7 && heldBefore7 !== held, momenta: momenta7, vols: vols7, w: tw });
            var tv8 = 0, hadW = w !== null;
            for (var k9 = 0; k9 < K; k9++) tv8 += Math.abs(tw[k9] - (hadW ? w[k9] : 0));
            // 换手按单边计: Σ|Δw|/2. 全仓切换 Σ|Δw|=2 → 与基础路径每次切换扣 costRate 完全一致
            pendingCost = hadW ? costRate * tv8 / 2 : 0; // 建仓不计成本
            wNew = tw;
          }
        }
        var v7;
        if (held === null) {
          v7 = 1;
        } else {
          var r7 = 0;
          for (var k10 = 0; k10 < K; k10++) {
            if (w !== null && w[k10] > 0) r7 += w[k10] * (ffill[k10][i5] / ffill[k10][i5 - 1] - 1);
          }
          v7 = prevNav * (1 + r7) * (1 - pendingCost);
        }
        if (wNew !== null) w = wNew;
        pendingCost = 0;
        dates.push(d5); nav.push(v7);
        holding.push(held === null ? -1 : held);
        primaryW.push(held === null || held === bondK || !w ? 1 : w[held]);
        prevNav = v7;
        continue;
      }
      if (held === null) {
        var v = 1; // 首日建仓, 净值=1 (建仓不计成本)
      } else {
        v = prevNav * ffill[held][i5] / ffill[held][i5 - 1];
      }
      if (rebSet[i5]) {
        var best = -Infinity, bestK = -1, momenta = {};
        for (var k5 = 0; k5 < K; k5++) {
          var m = momentumAt(i5, k5);
          momenta[etfs[k5].code] = m;
          if (m !== null && m > best) { best = m; bestK = k5; }
        }
        if (bestK >= 0) {
          // 绝对动量避险: 最强动量跌破阈值时, 改持避险债券ETF
          var heldBefore = held;
          var chosen = bestK;
          var isRiskOff = false;
          if (riskOff && best < riskOff.floor) { chosen = bondK; isRiskOff = chosen !== bestK; }
          var chosenM = momenta[etfs[chosen].code];
          if (held === null) {
            switches.push({ date: d5, from: null, to: chosen, momenta: momenta, riskOff: isRiskOff });
            held = chosen;
          } else if (chosen !== held && chosenM > momenta[etfs[held].code]) {
            switches.push({ date: d5, from: held, to: chosen, momenta: momenta, riskOff: isRiskOff });
            held = chosen;
            if (costRate > 0) v *= (1 - costRate); // 切换持仓: 扣减交易成本
          }
          // 并列(动量不严格大于当前持仓)时保持原持仓, 不产生交易与成本
          var vols = [];
          for (var kv = 0; kv < K; kv++) vols.push(realizedVol(i5, kv));
          rebalances.push({ date: d5, from: heldBefore, to: held, riskOff: isRiskOff && heldBefore !== held, momenta: momenta, vols: vols, w: null });
        }
      }
      dates.push(d5);
      nav.push(v);
      holding.push(held === null ? -1 : held);
      prevNav = v;
    }

    // 8. 基准: 各ETF买入持有 + 等权持有(5%带宽再平衡)
    var benchmarks = [];
    for (var k6 = 0; k6 < K; k6++) {
      var b = [];
      for (var i6 = firstRebIdx; i6 < n; i6++) b.push(ffill[k6][i6] / ffill[k6][firstRebIdx]);
      benchmarks.push(b);
    }
    // 等权持有(5%带宽再平衡): 期初资金四等分买入各ETF后持有,
    // 任一ETF权重偏离目标25%超过5个百分点(即权重<20%或>30%)时, 当日收盘再平衡回等权
    var bandEqualNav = [], bandUnits = [], bandRebCount = 0;
    for (var k9 = 0; k9 < K; k9++) bandUnits.push(0.25 / ffill[k9][firstRebIdx]);
    for (var i9 = firstRebIdx; i9 < n; i9++) {
      var v9 = 0;
      for (var k10 = 0; k10 < K; k10++) v9 += bandUnits[k10] * ffill[k10][i9];
      var needReb = false;
      for (var k11 = 0; k11 < K; k11++) {
        var w = bandUnits[k11] * ffill[k11][i9] / v9;
        if (Math.abs(w - 1 / K) > 0.05) { needReb = true; break; }
      }
      if (needReb) {
        for (var k12 = 0; k12 < K; k12++) bandUnits[k12] = v9 / (K * ffill[k12][i9]);
        bandRebCount++;
      }
      bandEqualNav.push(v9);
    }

    // 8.1 可选纯对比基准: 只在既有 calendar 上做前向填充, 不参与选股/调仓/成本/等权,
    //     也不进入 calendar 与 startIdx —— 晚上市时曲线自行晚开始, 不拖后策略回测起点
    var cmpIn = options.compare;
    if (cmpIn && !Array.isArray(cmpIn)) cmpIn = [cmpIn];
    var compare = [], compareStart = [], compareCodes = [], compareLabels = [];
    (cmpIn || []).forEach(function (c) {
      if (!c || !c.dates || !c.closes || !c.dates.length) return;
      var px = [], pi = -1;
      for (var ic = 0; ic < n; ic++) {
        while (pi + 1 < c.dates.length && c.dates[pi + 1] <= calendar[ic]) pi++;
        px.push(pi >= 0 ? c.closes[pi] : null);
      }
      var ci = -1;
      for (var ic2 = firstRebIdx; ic2 < n; ic2++) {
        if (px[ic2] != null) { ci = ic2; break; }
      }
      if (ci < 0) return;
      var line = [];
      for (var ic3 = firstRebIdx; ic3 < n; ic3++) {
        line.push(ic3 < ci ? null : px[ic3] / px[ci]);
      }
      compare.push(line);
      compareStart.push(ci - firstRebIdx);
      compareCodes.push(c.code || '');
      compareLabels.push(c.label || c.code || '对比基准');
    });

    return {
      dates: dates, nav: nav, holding: holding, switches: switches, rebalances: rebalances,
      primaryW: volTarget > 0 ? primaryW : null,
      benchmarks: benchmarks, bandEqualNav: bandEqualNav,
      compare: compare, compareStart: compareStart,
      compareCodes: compareCodes, compareLabels: compareLabels,
      bandRebCount: bandRebCount,
      rebCount: Object.keys(rebSet).length,
      codes: etfs.map(function (e) { return e.code; }),
      labels: etfs.map(function (e) { return e.label; }),
    };
  }

  // 指标计算: window = {i0, i1} 为 dates 数组的闭区间索引
  function computeMetrics(bt, opts) {
    opts = opts || {};
    var rf = (opts.rf === undefined ? 0.02 : opts.rf);
    var i0 = opts.i0 || 0;
    var i1 = (opts.i1 === undefined ? bt.nav.length - 1 : opts.i1);
    var nav = bt.nav, dates = bt.dates;
    var days = i1 - i0; // 收益天数

    var total = nav[i1] / nav[i0] - 1;
    var annualized = days > 0 ? Math.pow(nav[i1] / nav[i0], 252 / days) - 1 : 0;

    // 日收益
    var rs = [];
    for (var i = i0 + 1; i <= i1; i++) rs.push(nav[i] / nav[i - 1] - 1);
    var m = rs.length ? rs.reduce(function (a, b) { return a + b; }, 0) / rs.length : 0;
    var varSum = 0;
    for (var j = 0; j < rs.length; j++) varSum += (rs[j] - m) * (rs[j] - m);
    var sd = rs.length > 1 ? Math.sqrt(varSum / (rs.length - 1)) : 0;
    var vol = sd * Math.sqrt(252);
    var sharpe = sd > 0 ? (m - rf / 252) / sd * Math.sqrt(252) : 0;

    // 回撤 + 溃疡指数(Ulcer Index): 日频水下深度的均方根, 同时惩罚"跌得深"与"泡得久"
    var peak = nav[i0], maxDD = 0, peakAll = nav[i0], ddSum2 = 0, ddCount = 0;
    for (var i2 = i0; i2 <= i1; i2++) {
      if (nav[i2] > peak) peak = nav[i2];
      if (peak > 0) {
        var dd = 1 - nav[i2] / peak;
        if (dd > maxDD) maxDD = dd;
        ddSum2 += dd * dd; ddCount++;
      }
      if (nav[i2] > peakAll) peakAll = nav[i2];
    }
    var currentDD = peakAll > 0 ? 1 - nav[i1] / peakAll : 0;
    var ulcer = ddCount > 0 ? Math.sqrt(ddSum2 / ddCount) : 0;

    // 周度收益(窗口内按ISO周聚合, 首周相对窗口起点)
    var weekEnd = {}, seen = {};
    for (var i3 = i0; i3 <= i1; i3++) {
      var wk = mondayOf(dates[i3]);
      weekEnd[wk] = i3;
    }
    var weekIdxs = Object.keys(weekEnd).sort().map(function (w) { return weekEnd[w]; });
    var wins = 0, weeks = 0, prevRef = nav[i0];
    for (var w2 = 0; w2 < weekIdxs.length; w2++) {
      var li = weekIdxs[w2];
      if (li > i0) {
        weeks++;
        if (nav[li] / prevRef - 1 > 0) wins++;
        prevRef = nav[li];
      } else {
        prevRef = nav[li];
      }
    }

    // 窗口内切换次数与持仓天数
    var d0 = dates[i0], d1 = dates[i1], sw = 0;
    var switchesIn = [];
    for (var s = 0; s < bt.switches.length; s++) {
      var sw2 = bt.switches[s];
      if (sw2.date > d0 && sw2.date <= d1 && sw2.from !== null) { sw++; switchesIn.push(sw2); }
    }
    var holdDays = {};
    for (var i4 = i0; i4 <= i1; i4++) {
      var h = bt.holding[i4];
      if (h >= 0) holdDays[h] = (holdDays[h] || 0) + 1;
    }

    return {
      total: total, annualized: annualized, vol: vol, sharpe: sharpe,
      maxDD: maxDD, currentDD: currentDD,
      calmar: maxDD > 0 ? annualized / maxDD : null,
      ulcer: ulcer,
      martin: ulcer > 0 ? (annualized - rf) / ulcer : null,
      weeklyWinRate: weeks > 0 ? wins / weeks : 0, weeks: weeks,
      switches: sw, switchesIn: switchesIn, holdDays: holdDays,
      tradingDays: days + 1,
    };
  }

  // 年度收益(全区间, 不受窗口筛选影响)
  function yearlyReturns(bt) {
    var years = {};
    for (var i = 0; i < bt.dates.length; i++) {
      var y = bt.dates[i].slice(0, 4);
      if (!years[y] || bt.dates[i] > years[y].last) {
        if (!years[y]) years[y] = { first: bt.dates[i], last: bt.dates[i], fi: i, li: i };
        years[y].last = bt.dates[i]; years[y].li = i;
      }
    }
    var out = [];
    Object.keys(years).sort().forEach(function (y) {
      var info = years[y];
      var row = { year: y, strategy: bt.nav[info.li] / bt.nav[info.fi] - 1 };
      for (var k = 0; k < bt.benchmarks.length; k++) {
        row['b' + k] = bt.benchmarks[k][info.li] / bt.benchmarks[k][info.fi] - 1;
      }
      row.bandEqual = bt.bandEqualNav[info.li] / bt.bandEqualNav[info.fi] - 1;
      // 对比基准: 起始年从它自己的首个可得日起算; 当年尚无数据则为 null(图上不画柱)
      if (bt.compare) {
        for (var ci = 0; ci < bt.compare.length; ci++) {
          var cArr = bt.compare[ci], cBase = Math.max(info.fi, bt.compareStart[ci]);
          row['c' + ci] = (cBase <= info.li && cArr[cBase] != null && cArr[info.li] != null)
            ? cArr[info.li] / cArr[cBase] - 1 : null;
        }
      }
      out.push(row);
    });
    return out;
  }

  global.RotationEngine = {
    runBacktest: runBacktest,
    computeMetrics: computeMetrics,
    yearlyReturns: yearlyReturns,
    mondayOf: mondayOf,
    weekdayOf: weekdayOf,
  };
})(typeof window !== 'undefined' ? window : globalThis);
