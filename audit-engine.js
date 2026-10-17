// audit_engine.js — 引擎级第一性原理审查（不依赖页面）
// 1) 合成数据单元测试: vol 路径全仓切换成本必须 = 0.1%(单边口径), 而非 0.2%
// 2) 不变量: primaryW/holding/nav/switches 结构与取值
// 3) 独立复算器: 从策略规则从零实现, 与引擎在真实数据上逐项对照
const fs = require('fs');
const DIR = __dirname;   // 不写死绝对路径, 以便在 CI/其他机器上运行
eval(fs.readFileSync(DIR + '/engine.js', 'utf8'));
eval(fs.readFileSync(DIR + '/data.js', 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
const BOND = '511260';

// ============ 1. 合成数据: 全仓切换成本单元测试 ============
console.log('== 1. 合成数据: vol 路径切换成本口径 ==');
(function () {
  // 30 个连续交易日; A 先涨后跌, B 后段强涨 → 第二个调仓日发生 A→B 全仓切换
  // lookback=5; 周五调仓(所有自然日都交易 → 每周五调仓)
  const dates = [];
  let d = new Date('2026-01-05T00:00:00Z'); // 周一
  for (let i = 0; i < 40; i++) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  function ramp(start, perDay) { const c = [start]; for (let i = 1; i < dates.length; i++) c.push(c[i - 1] * (1 + perDay(i))); return c; }
  // A: 前 18 天 +1.5%/日, 之后 -0.5%/日 → 5日动量在 ~第21天后转负/被B超过
  const A = ramp(100, i => (i < 18 ? 0.015 : -0.005));
  // B: 前 18 天 +0.2%/日, 之后 +3%/日 → 后段动量远超 A
  const B = ramp(100, i => (i < 18 ? 0.002 : 0.03));
  // 国债: 极低波动
  const G = ramp(100, () => 0.0001);
  const etfs = [
    { code: 'A', label: '资产A', dates, closes: A },
    { code: BOND, label: '国债', dates, closes: G },
    { code: 'B', label: '资产B', dates, closes: B },
  ];
  const OPT = { lookback: 5, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: BOND }, volTarget: 0.15 };
  const bt = RotationEngine.runBacktest(etfs, OPT);
  check('合成场景发生至少一次切换(含建仓)', bt.switches.length >= 2, bt.switches.length);
  // 找到 A→B 的切换日
  const swIdx = bt.switches.findIndex(s => s.from !== null && s.from === 0 && s.to === 2);
  check('发生 A→B 切换', swIdx >= 0);
  if (swIdx >= 0) {
    const sw = bt.switches[swIdx];
    const i = bt.dates.indexOf(sw.date);
    // 切换日: 收益归属旧权重(旧 w 中 A 的权重), 成本 = 0.001 × Σ|Δw|/2
    // 旧权重: A=wa, G=1-wa (从 primaryW[i-1] 读, 但注意 primaryW[i-1] 即旧权重生效值)
    const wa = bt.primaryW[i - 1];
    const rA = A[i] / A[i - 1] - 1, rG = G[i] / G[i - 1] - 1, rB = B[i] / B[i - 1] - 1;
    // 新权重: B 的 vol20 定仓
    function vol20(arr, ii) { const rs = []; for (let j = ii - 19; j <= ii; j++) rs.push(arr[j] / arr[j - 1] - 1); const m = rs.reduce((a, b) => a + b, 0) / rs.length; return Math.sqrt(rs.reduce((a, b) => a + (b - m) * (b - m), 0) / (rs.length - 1)) * Math.sqrt(252); }
    const wB = Math.min(1, 0.15 / vol20(B, i));
    const dv = Math.abs(wB - 0) + Math.abs((1 - wB) - (1 - wa)) + Math.abs(0 - wa); // Σ|Δw|
    const expected = bt.nav[i - 1] * (1 + wa * rA + (1 - wa) * rG) * (1 - 0.001 * dv / 2);
    check('切换日净值 = 旧权重收益 ×(1-单边成本), 单边口径(Σ|Δw|/2)',
      Math.abs(bt.nav[i] - expected) < 1e-10,
      'engine=' + bt.nav[i] + ' expected=' + expected + ' Σ|Δw|=' + dv.toFixed(4));
    check('全仓等价切换成本恰为0.1%(非0.2%)', Math.abs(dv / 2 - 1) < 1e-9, (dv / 2).toFixed(6));
  }
})();

// ============ 2. 真实数据不变量 ============
console.log('== 2. 真实数据不变量(周五/25日/避险/0.1%成本/vol15%) ==');
const OPT15 = { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: BOND }, volTarget: 0.15 };
const bt15 = RotationEngine.runBacktest(ETF_DATA.etfs, OPT15);
{
  const bondIdx = ETF_DATA.etfs.findIndex(e => e.code === BOND);
  const { nav, primaryW, holding, dates, switches } = bt15;
  check('primaryW 与 nav 等长', primaryW.length === nav.length, primaryW.length + ' vs ' + nav.length);
  check('primaryW 全部 ∈ (0,1]', primaryW.every(w => w > 0 && w <= 1));
  check('持有国债时 primaryW === 1', holding.every((h, i) => h !== bondIdx || primaryW[i] === 1));
  check('nav 全部有限且 nav[0]===1', nav.every(v => isFinite(v) && v > 0) && nav[0] === 1);
  check('非国债持仓日 primaryW<1 至少存在(波动目标真的生效了)', primaryW.some(w => w < 0.999));
  check('switches 日期都在 dates 内且 from/to 合法', switches.every(s => dates.includes(s.date) && (s.from === null || s.from >= 0) && s.to >= 0 && s.to < ETF_DATA.etfs.length));
  // 避险不变量: 每个 switch 若 riskOff 标记, to 必须是 bondIdx
  check('riskOff 切换目标必为国债', switches.filter(s => s.riskOff).every(s => s.to === bondIdx));
  // 波动率路径: 权重只应在调仓日变动(周五或节假日顺延/提前的调仓日)
  // 独立复算器已验证日期一致, 用其 rebDays 集合做判据
  let wChangeOutside = 0;
  const indReb = independentSim(ETF_DATA.etfs, OPT15).rebDays;
  for (let i = 1; i < dates.length; i++) {
    if (!indReb.has(i) && Math.abs(primaryW[i] - primaryW[i - 1]) > 1e-12) wChangeOutside++;
  }
  check('权重仅在调仓日变动(含节假日顺延)', wChangeOutside === 0, wChangeOutside + ' 处非调仓日变动');
}
const m15 = RotationEngine.computeMetrics(bt15, { rf: 0.02 });
console.log('  vol15%: 年化=' + (m15.annualized * 100).toFixed(2) + '% 回撤=' + (m15.maxDD * 100).toFixed(2) + '% 卡玛=' + m15.calmar.toFixed(3));

// ============ 3. 独立复算器(从规则从零实现) ============
console.log('== 3. 独立复算器 vs 引擎(真实数据) ==');
function independentSim(etfs, opts) {
  const LB = opts.lookback, WD = opts.rebalanceWeekday, COST = opts.costRate, TV = opts.volTarget, FLOOR = opts.riskOff.floor;
  const K = etfs.length;
  const bondK = etfs.findIndex(e => e.code === opts.riskOff.bondCode);
  // 日历
  const set = new Set(); etfs.forEach(e => e.dates.forEach(d => set.add(d)));
  const cal = [...set].sort();
  // ffill + ownIdx
  const ff = [], own = [];
  etfs.forEach(e => {
    const f = [], o = []; let pi = -1;
    cal.forEach(d => { while (pi + 1 < e.dates.length && e.dates[pi + 1] <= d) pi++; o.push(pi); f.push(pi >= 0 ? e.closes[pi] : null); });
    ff.push(f); own.push(o);
  });
  const startIdx = cal.findIndex((_, i) => own.every(o => o[i] >= LB));
  const wdOf = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const monOf = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
  // 调仓日
  const reb = new Set(); let wk = null, days = [];
  const flush = () => { if (wk === null) return; let p = days.find(i => wdOf(cal[i]) >= WD); if (p === undefined) p = days[days.length - 1]; reb.add(p); };
  for (let i = startIdx; i < cal.length; i++) { const w = monOf(cal[i]); if (w !== wk) { flush(); wk = w; days = []; } days.push(i); }
  flush();
  const firstReb = cal.findIndex((d, i) => i >= startIdx && reb.has(i));
  const mom = (i, k) => own[k][i] < LB ? null : etfs[k].closes[own[k][i]] / etfs[k].closes[own[k][i] - LB] - 1;
  const vol20 = (i, k) => { const rs = []; for (let j = i - 19; j <= i; j++) { if (ff[k][j - 1] === null || ff[k][j] === null) return null; rs.push(ff[k][j] / ff[k][j - 1] - 1); } const m = rs.reduce((a, b) => a + b, 0) / rs.length; return Math.sqrt(rs.reduce((a, b) => a + (b - m) * (b - m), 0) / (rs.length - 1)) * Math.sqrt(252); };
  let held = null, w = null, nav = 1;
  const out = { dates: [], nav: [], primaryW: [], rebDays: new Set() };
  for (let i = firstReb; i < cal.length; i++) {
    if (reb.has(i)) {
      out.rebDays.add(i - firstReb); // 转为回测数组索引(与引擎 dates 对齐)
      const ms = etfs.map((_, k) => mom(i, k));
      let best = -Infinity, bk = -1; ms.forEach((m, k) => { if (m !== null && m > best) { best = m; bk = k; } });
      let ch = bk, ro = false;
      if (best < FLOOR) { ch = bondK; ro = ch !== bk; }
      if (held === null) held = ch;
      else if (ch !== held && ms[ch] > ms[held]) held = ch;
      const tw = new Array(K).fill(0);
      if (held === bondK) tw[held] = 1;
      else { const v = vol20(i, held); tw[held] = (v === null || v <= 0) ? 1 : Math.min(1, TV / v); tw[bondK] = 1 - tw[held]; }
      // 时序: 当日收益归旧仓位, 收盘交易扣成本, 新权重次日起生效
      if (w !== null && COST > 0) { let dv = 0; for (let k = 0; k < K; k++) dv += Math.abs(tw[k] - w[k]); nav *= (1 - COST * dv / 2); }
      let r = 0; for (let k = 0; k < K; k++) if (w !== null && w[k] > 0) r += w[k] * (ff[k][i] / ff[k][i - 1] - 1);
      nav *= (1 + r);
      w = tw;
    } else if (w !== null && held !== null) {
      let r = 0; for (let k = 0; k < K; k++) if (w[k] > 0) r += w[k] * (ff[k][i] / ff[k][i - 1] - 1);
      nav *= (1 + r);
    }
    out.dates.push(cal[i]); out.nav.push(nav);
    out.primaryW.push(held === null || held === bondK || !w ? 1 : w[held]);
  }
  return out;
}
{
  const ind = independentSim(ETF_DATA.etfs, OPT15);
  check('独立复算日期序列与引擎完全一致', JSON.stringify(ind.dates) === JSON.stringify(bt15.dates));
  let maxNavDiff = 0, maxWDiff = 0;
  for (let i = 0; i < bt15.nav.length; i++) {
    maxNavDiff = Math.max(maxNavDiff, Math.abs(ind.nav[i] - bt15.nav[i]));
    maxWDiff = Math.max(maxWDiff, Math.abs(ind.primaryW[i] - bt15.primaryW[i]));
  }
  check('独立复算净值逐日一致(容差1e-9)', maxNavDiff < 1e-9, 'maxDiff=' + maxNavDiff.toExponential(2));
  check('独立复算权重逐日一致(容差1e-9)', maxWDiff < 1e-9, 'maxDiff=' + maxWDiff.toExponential(2));
  // 对照其余档位
  [0.12, 0.18].forEach(tv => {
    const o = Object.assign({}, OPT15, { volTarget: tv });
    const btX = RotationEngine.runBacktest(ETF_DATA.etfs, o);
    const indX = independentSim(ETF_DATA.etfs, o);
    let md = 0; for (let i = 0; i < btX.nav.length; i++) md = Math.max(md, Math.abs(indX.nav[i] - btX.nav[i]));
    check('独立复算 vol' + (tv * 100) + '% 净值一致', md < 1e-9, 'maxDiff=' + md.toExponential(2));
  });
  // 无波动率目标基线不受本次修改影响
  const btBase = RotationEngine.runBacktest(ETF_DATA.etfs, { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: BOND } });
  const mB = RotationEngine.computeMetrics(btBase, { rf: 0.02 });
  // 该基线随 data.js 最新交易日延伸会有微小漂移; 更新数据时同步刷新, 并复核漂移是否只来自新增交易日
  check('基线(无vol)仍为 27.15%/16.21%', Math.abs(mB.annualized - 0.2715) < 0.0005 && Math.abs(mB.maxDD - 0.1621) < 0.0005,
    (mB.annualized * 100).toFixed(2) + '/' + (mB.maxDD * 100).toFixed(2));

  // 对比基准走独立通道: 带上它时策略净值/基准/日期必须逐字节不变
  const btC = RotationEngine.runBacktest(ETF_DATA.etfs, { lookback: 25, rebalanceWeekday: 4, costRate: 0.001,
    riskOff: { floor: 0, bondCode: BOND }, compare: ETF_DATA.compare });
  check('compare 不改变策略净值/基准/日期',
    JSON.stringify(btC.nav) === JSON.stringify(btBase.nav) &&
    JSON.stringify(btC.benchmarks) === JSON.stringify(btBase.benchmarks) &&
    JSON.stringify(btC.dates) === JSON.stringify(btBase.dates));
  check('compare 从自身起点归一(首值=1)',
    btC.compare.length === 1 && btC.compare[0][btC.compareStart[0]] === 1);
}

console.log('\n引擎级审查结果: ' + pass + ' PASS, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
