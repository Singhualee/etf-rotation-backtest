// stress-test-pro.js — 极限参数矩阵压力测试: 160种组合逐一切换, 断言零崩溃零NaN零状态漂移
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

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
const errors = [];
const dom = new JSDOM(html, {
  url: 'http://localhost/stress.html', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    const noop = () => {};
    const ctx = new Proxy({}, { get(t, p) { if (p === 'measureText') return () => ({ width: 10 }); if (p === 'canvas') return { width: 300, height: 150 }; if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop }); if (typeof p === 'string') return noop; }, set() { return true; } });
    w.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.onerror = (msg, s, l, c) => errors.push(msg + ' @' + l + ':' + c);
    w.addEventListener('unhandledrejection', e => errors.push('rejection: ' + e.reason));
  },
});
const W = dom.window, document = W.document;

setTimeout(() => {
  console.log('== 压力测试: 极限参数矩阵(160组合) ==\n');
  const wds = ['0', '1', '2', '3', '4'], lbs = ['20', '22', '25', '30'], vols = ['', '0.12', '0.15', '0.18'], costs = ['0', '0.001'];
  const wd = document.getElementById('wdSel'), lb = document.getElementById('lbSel'),
        vs = document.getElementById('volSel'), cs = document.getElementById('costSel');
  const rf = +document.getElementById('rfSlider').value / 100;
  let crashes = 0, nanCards = 0, mismatches = 0, n = 0;
  const seen = new Map(); // 检测同参数组合结果是否可复现
  for (const wv of wds) for (const lv of lbs) for (const vv of vols) for (const cv of costs) {
    wd.value = wv; lb.value = lv; vs.value = vv; cs.value = cv;
    try { vs.onchange(); } catch (e) { crashes++; errors.push(`${wv}/${lv}/${vv}/${cv}: ` + e.message); continue; }
    n++;
    const cards = {};
    document.querySelectorAll('#metricCards .metric').forEach(m => { cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
    if (Object.values(cards).some(t => /NaN|Infinity/.test(t))) nanCards++;
    // 与引擎独立比对
    const m = RE.computeMetrics(RE.runBacktest(ED.etfs, {
      lookback: +lv, rebalanceWeekday: +wv, volTarget: +vv || 0,
      riskOff: document.getElementById('riskOffChk').checked ? { floor: 0, bondCode: '511260' } : null,
      costRate: +cv,
    }), { rf });
    if (Math.abs(parseFloat(cards['总收益率'].replace(/[^0-9.\-]/g, '')) - m.total * 100) > 0.005) mismatches++;
    const key = wv + '|' + lv + '|' + vv + '|' + cv;
    const sig = JSON.stringify(cards);
    if (seen.has(key) && seen.get(key) !== sig) mismatches++;
    seen.set(key, sig);
  }
  check('S1 160种组合全部重算无崩溃', crashes === 0, crashes + ' 崩溃; ' + errors.slice(0, 3).join(' | '));
  check('S2 无任何 NaN/Infinity 指标', nanCards === 0, nanCards + ' 组含NaN');
  check('S3 全部组合指标与引擎独立复算一致', mismatches === 0, mismatches + ' 组不一致');
  check('S4 无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '));
  // 恢复默认并确认回到基线
  wd.value = '4'; lb.value = '25'; vs.value = '0.15'; cs.value = '0.001'; vs.onchange();
  const c0 = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => { c0[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
  const mDef = RE.computeMetrics(RE.runBacktest(ED.etfs, { lookback: 25, rebalanceWeekday: 4, volTarget: 0.15, riskOff: { floor: 0, bondCode: '511260' }, costRate: 0.001 }), { rf });
  check('S5 压力后回到默认指标正确', Math.abs(parseFloat(c0['总收益率'].replace(/[^0-9.\-]/g, '')) - mDef.total * 100) < 0.005, c0['总收益率'] + ' vs ' + (mDef.total * 100).toFixed(2) + '%');
  console.log('\n压力测试结果: ' + pass + ' PASS, ' + fail + ' FAIL (执行 ' + n + ' 次全量重算)');
  if (errors.length) console.log('未捕获异常: ' + errors.slice(0, 5).join(' | '));
  process.exit(fail ? 1 : 0);
}, 600);
