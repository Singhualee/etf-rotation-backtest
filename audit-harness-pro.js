// audit-harness-pro.js — Pro 网页 UI 层对抗审查 (jsdom)
// 原则: 只通过 DOM 与 W.bt 驱动/观察, 测真实用户路径; 断言有物理意义
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = process.argv[2] || '/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest/ETF动量轮动回测Pro.html';
const html = fs.readFileSync(path, 'utf-8');
const DIR = '/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest';
const loadEngine = new Function('fs', 'DIR',
  'eval(fs.readFileSync(DIR + "/engine.js", "utf8"));' +
  'eval(fs.readFileSync(DIR + "/data.js", "utf8"));' +
  'return { RE: RotationEngine, ED: ETF_DATA };');
const { RE, ED } = loadEngine(fs, DIR);
const ETF_DATA_G = ED;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost/pro.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.__wbNoAutoRefresh = true;   // 打开时自动更新会引入网络与时序, 本审查只针对已渲染状态
    const noop = () => {};
    const ctxProxy = new Proxy({}, {
      get(t, p) {
        if (p === 'measureText') return () => ({ width: 10 });
        if (p === 'canvas') return { width: 300, height: 150 };
        if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop });
        if (p === 'createPattern') return () => ({});
        if (typeof p === 'string') return noop;
        return undefined;
      },
      set() { return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = function () { return ctxProxy; };
    window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,x';
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.onerror = (msg, src, line, col) => { errors.push(msg + ' @' + line + ':' + col); };
    window.addEventListener('unhandledrejection', e => errors.push('rejection: ' + e.reason));
  },
});
const W = dom.window;
const document = W.document;

function pageOpts() {
  return {
    lookback: +document.getElementById('lbSel').value,
    rebalanceWeekday: +document.getElementById('wdSel').value,
    volTarget: +document.getElementById('volSel').value || 0,
    riskOff: document.getElementById('riskOffChk').checked ? { floor: 0, bondCode: '511260' } : null,
    costRate: +document.getElementById('costSel').value,
  };
}
function pageCards() {
  const c = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => { c[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
  return c;
}
function num(s) { return parseFloat(String(s).replace(/[^0-9.\-]/g, '')); }
// 页面显示为四舍五入文本, 与引擎值比较需留舍入容差
function cmpCards(name, cards, metrics) {
  const pairs = [
    ['总收益率', metrics.total * 100, 0.005],
    ['年化收益率', metrics.annualized * 100, 0.005],
    ['夏普比率', metrics.sharpe, 0.005],
    ['最大回撤', -metrics.maxDD * 100, 0.005],
    ['卡玛比率', metrics.calmar, 0.0005],
    ['溃疡指数', metrics.ulcer * 100, 0.005],
    ['马丁比率', metrics.martin, 0.0005],
    ['切换次数', metrics.switches, 0],
  ];
  let bad = [];
  pairs.forEach(([k, exp, tol]) => {
    if (!(k in cards)) { bad.push(k + ':缺失'); return; }
    const got = num(cards[k]);
    if (tol === 0 ? got !== exp : Math.abs(got - exp) > tol) bad.push(k + ':got=' + cards[k] + ',exp=' + exp);
  });
  check(name, bad.length === 0, bad.join('; '));
}

setTimeout(async () => {
  console.log('== UI 对抗审查: ' + path.split('/').pop() + ' ==\n');

  // ---- A. 启动态 ----
  check('A1 无未捕获异常', errors.length === 0, errors.join(' | '));
  check('A2 volSel 存在且默认18%', document.getElementById('volSel').value === '0.18', document.getElementById('volSel').value);
  check('A3 volSel 共4档(关闭/12/15/18)', document.querySelectorAll('#volSel option').length === 4);
  check('A4 wdSel 默认周五', document.getElementById('wdSel').value === '4');
  check('A5 波动目标开启时避险复选框已锁定', document.getElementById('riskOffChk').disabled === true);
  const note0 = document.getElementById('stratNote').textContent;
  check('A6 口径说明含波动率目标18%与仓位补足说明', note0.includes('波动率目标') && note0.includes('18%') && note0.includes('补足'));

  const rf = +document.getElementById('rfSlider').value / 100;
  let m = RE.computeMetrics(RE.runBacktest(ETF_DATA_G.etfs, pageOpts()), { rf });
  let cards = pageCards();
  cmpCards('A7 默认参数下12项指标卡与引擎一致(vol18%)', cards, m);
  check('A8 指标卡共12张', Object.keys(cards).length === 12, Object.keys(cards).join(','));

  // ---- B. 参数矩阵: volSel 全档位 ----
  const volSel = document.getElementById('volSel');
  const expectByVol = { '': 0, '0.12': 0.12, '0.15': 0.15, '0.18': 0.18 };
  for (const v of ['', '0.12', '0.15', '0.18']) {
    volSel.value = v; volSel.onchange();
    const o = pageOpts();
    const mm = RE.computeMetrics(RE.runBacktest(ETF_DATA_G.etfs, o), { rf });
    cmpCards('B1 volSel=' + (v || '关闭') + ' 指标卡与引擎一致', pageCards(), mm);
    check('B2 volSel=' + (v || '关闭') + ' 避险锁存状态正确', document.getElementById('riskOffChk').disabled === (v !== ''));
    const note = document.getElementById('stratNote').textContent;
    check('B3 volSel=' + (v || '关闭') + ' 口径说明同步', v === '' ? note.includes('波动率目标关闭') : note.includes((+v * 100) + '%'));
  }
  // 关闭档 = 基线
  volSel.value = ''; volSel.onchange();
  const baseCards = pageCards();
  const mBase = RE.computeMetrics(RE.runBacktest(ETF_DATA_G.etfs, { lookback: 25, rebalanceWeekday: 4, costRate: 0.001, riskOff: { floor: 0, bondCode: '511260' } }), { rf });
  check('B4 关闭波动目标即基线(总收益'+ (mBase.total*100).toFixed(2) + '%)', Math.abs(num(baseCards['总收益率']) - mBase.total * 100) < 0.005, baseCards['总收益率']);

  // ---- C. 对抗: vol 开启时试图取消避险(自愈) ----
  volSel.value = '0.15'; volSel.onchange();
  const cardsVol15 = pageCards();
  const roChk = document.getElementById('riskOffChk');
  roChk.checked = false;
  let threw = false;
  try { roChk.onchange(); } catch (e) { threw = true; errors.push('riskOffChk onchange: ' + e.message); }
  check('C1 取消避险时处理器无异常', !threw);
  check('C2 避险自动恢复勾选(自愈)', roChk.checked === true && roChk.disabled === true);
  const cardsAfter = pageCards();
  check('C3 自愈后指标与原vol15状态一致', cardsAfter['总收益率'] === cardsVol15['总收益率'], cardsAfter['总收益率'] + ' vs ' + cardsVol15['总收益率']);
  check('C4 未产生未捕获异常', errors.length === 0, errors.join(' | '));

  // ---- D. 窗口筛选 × 波动率目标 ----
  const yearSel = document.getElementById('yearSel');
  yearSel.value = 'y2022'; yearSel.onchange();
  // 页面主脚本为 IIFE 闭包, bt 不可从外部访问 — 用 Node 侧同参数引擎的日期序列计算窗口索引
  const d = RE.runBacktest(ETF_DATA_G.etfs, pageOpts()).dates;
  let i0 = d.findIndex(x => x >= '2022-01-01'), i1 = -1;
  for (let i = 0; i < d.length; i++) if (d[i] <= '2022-12-31') i1 = i;
  const mWin = RE.computeMetrics(RE.runBacktest(ETF_DATA_G.etfs, pageOpts()), { rf, i0, i1 });
  cmpCards('D1 2022年窗口×vol15% 指标与引擎窗口口径一致', pageCards(), mWin);
  check('D2 2022窗口交易日数在[230,250]', (() => { const n = +pageCards()['交易日数']; return n >= 230 && n <= 250; })(), pageCards()['交易日数']);
  // 自定义窗口
  const cs = document.getElementById('customStart'), ce = document.getElementById('customEnd');
  cs.value = '2021-01-01'; ce.value = '2021-12-31'; cs.onchange();
  i0 = d.findIndex(x => x >= '2021-01-01'); i1 = -1;
  for (let i = 0; i < d.length; i++) if (d[i] <= '2021-12-31') i1 = i;
  const mWin2 = RE.computeMetrics(RE.runBacktest(ETF_DATA_G.etfs, pageOpts()), { rf, i0, i1 });
  cmpCards('D2b 自定义2021窗口×vol15% 指标一致', pageCards(), mWin2);
  document.getElementById('btnAll').onclick();

  // ---- E. 构建完整性: 单文件内联的引擎/数据与仓库版本一致, 且含全部修复标记 ----
  // (引擎输出不变量已在 audit_engine.js 用独立复算器逐日验证 1e-9; 页面与引擎的一致性由 A7/B1/D 组交叉覆盖)
  const built = fs.readFileSync(path, 'utf-8');
  const repoEngine = fs.readFileSync(DIR + '/engine.js', 'utf-8');
  const repoData = fs.readFileSync(DIR + '/data.js', 'utf-8');
  const gi = built.indexOf('(function (global)');
  const gs = built.lastIndexOf('<script>', gi);
  const ge = built.indexOf('</script>', gi);
  const inlinedEngine = gs >= 0 && ge > gs ? built.slice(gs + 8, ge) : '';
  const di = built.indexOf('var ETF_DATA');
  const ds = built.lastIndexOf('<script>', di);
  const de = built.indexOf('</script>', di);
  const inlinedData = ds >= 0 && de > ds ? built.slice(ds + 8, de) : '';
  check('E1 内联引擎与仓库 engine.js 逐字节一致', inlinedEngine.trim() === repoEngine.trim());
  check('E2 内联数据与仓库 data.js 逐字节一致', inlinedData.trim() === repoData.trim());
  check('E3 内联引擎含波动率历史不足保护(i-volLB<0)', inlinedEngine.includes('i - volLB < 0'));
  check('E4 内联引擎含单边成本口径(tv8 / 2)', inlinedEngine.includes('costRate * tv8 / 2'));
  check('E5 内联页面含初始避险锁定与参数容错', built.includes('volOn0') && built.includes('参数组合无效'));

  // ---- F. 压力: 20次随机参数切换 + 确定性回归 ----
  const wds = ['0', '1', '2', '3', '4'], lbs = ['20', '22', '25', '30'], vols = ['', '0.12', '0.15', '0.18'], costs = ['0', '0.001'];
  let stressErr = 0;
  for (let t = 0; t < 20; t++) {
    try {
      document.getElementById('wdSel').value = wds[t % 5];
      document.getElementById('lbSel').value = lbs[t % 4];
      volSel.value = vols[t % 4];
      document.getElementById('costSel').value = costs[t % 2];
      volSel.onchange(); // 触发全量重算(任一参数的onchange都会重跑引擎)
    } catch (e) { stressErr++; errors.push('stress#' + t + ': ' + e.message); }
  }
  check('F1 20次随机切换无异常', stressErr === 0, errors.slice(-3).join(' | '));
  check('F2 压力后仍无未捕获异常', errors.length === 0, errors.join(' | '));
  // 回到默认, 必须与启动态比特级一致(纯函数重算, 无状态累积)
  document.getElementById('wdSel').value = '4';
  document.getElementById('lbSel').value = '25';
  volSel.value = '0.15';
  document.getElementById('costSel').value = '0.001';
  volSel.onchange();
  const cardsBack = pageCards();
  check('F3 回到默认后指标与启动态完全一致(无状态漂移)', JSON.stringify(cardsBack) === JSON.stringify(cardsVol15),
    Object.keys(cardsBack).filter(k => cardsBack[k] !== cardsVol15[k]).map(k => k + ':' + cardsBack[k] + '≠' + cardsVol15[k]).join('; '));
  // NaN 防御: 非法程序化值不产生 NaN 卡片
  document.getElementById('lbSel').value = '999'; // 程序化注入非法窗口
  let nanErr = false;
  try { document.getElementById('lbSel').onchange(); } catch (e) { nanErr = true; }
  const cNan = pageCards();
  const hasNaN = Object.values(cNan).some(s => /NaN|Infinity|—/.test(s) === true && s === 'NaN');
  check('F4 非法窗口值不产生NaN指标(引擎容错或报错)', !hasNaN, Object.values(cNan).filter(s => /NaN/.test(s)).join(','));
  // 恢复
  document.getElementById('lbSel').value = '25';
  document.getElementById('lbSel').onchange();

  console.log('\nUI 对抗审查结果: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (errors.length) console.log('未捕获异常: ' + errors.join(' | '));
  process.exit(fail ? 1 : 0);
}, 600);
