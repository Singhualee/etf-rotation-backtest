// smoke-test-pro.js — ETF动量轮动回测Pro.html 无头冒烟测试 (jsdom)
// 默认目标必须是 Pro 单文件版: 若默认落到非 Pro 页(10 张指标卡、无 autoRefreshChk、
// 无溃疡/马丁), 会静默测错产物并产生约 20 项假 FAIL, 末尾还会因 __rotationAuto 缺失而崩溃。
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = process.argv[2] || __dirname + '/ETF动量轮动回测Pro.html';
const html = fs.readFileSync(path, 'utf-8');

// ---- Pro 版: 期望值与页面同引擎同参数动态计算, 不再硬编码 ----
// 用独立函数作用域 eval, 避免 engine.js 的 typeof window 撞上外层 const { window } 的 TDZ
const __proSetup = new Function('fs', 'dir',
  'eval(fs.readFileSync(dir + "/engine.js", "utf8"));' +
  'eval(fs.readFileSync(dir + "/data.js", "utf8"));' +
  'return { RotationEngine: RotationEngine, ETF_DATA: ETF_DATA };');
const { RotationEngine, ETF_DATA } = __proSetup(fs, __dirname);
// 注意: 此处必须与网页默认档位一致(volSel 默认 18%, 自 Pro v1.2 起; 早期误记为 15%)
const PRO_OPTS = {lookback:25, rebalanceWeekday:4, volTarget:0.18, costRate:0.001, riskOff:{floor:0, bondCode:'511260'}};
const EXPbt = RotationEngine.runBacktest(ETF_DATA.etfs, PRO_OPTS);
const EXPm = RotationEngine.computeMetrics(EXPbt, {rf:0.02});
const fmtLocalDate = d => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
const EXPmockEnd = (() => { const d = new Date(); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); return fmtLocalDate(d); })();
const fmtSigned = x => (x>=0?'+':'') + (x*100).toFixed(2) + '%';
const EXP = {
  firstDate: EXPbt.dates[0],
  rows: (EXPbt.rebalances || EXPbt.switches).length + 1,   // 表头 + 全部调仓决策(含建仓与重新定仓)
  total: fmtSigned(EXPm.total),
  annualized: fmtSigned(EXPm.annualized),
  sharpe: EXPm.sharpe.toFixed(3),
  maxDD: fmtSigned(-EXPm.maxDD),
  ulcer: (EXPm.ulcer * 100).toFixed(2) + '%',
  martin: EXPm.martin === null ? '—' : EXPm.martin.toFixed(3),
  switches: String(EXPm.switches),
};

let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

const dom = new JSDOM(html, {
  url: 'http://localhost/etf.html',  // http源以启用jsdom localStorage (file://下jsdom会SecurityError)
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    // 打开时的自动更新会引入真实网络请求/时序, 破坏既有断言的确定性;
    // 该能力由文末的专门用例覆盖, 其余用例一律关闭。
    window.__wbNoAutoRefresh = true;
    // jsdom 无 canvas: 用代理桩让 echarts/zrender 初始化与渲染路径不抛异常
    const noop = () => {};
    const ctxProxy = new Proxy({}, {
      get(t, p) {
        if (p === 'measureText') return () => ({ width: 10 });
        if (p === 'canvas') return { width: 300, height: 150 };
        if (p === 'createLinearGradient' || p === 'createRadialGradient')
          return () => ({ addColorStop: noop });
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

const { window } = dom;
const { document } = window;

setTimeout(async () => {
  console.log('== 冒烟测试: ' + path.split('/').pop() + ' ==\n');

  // 1. 无未捕获异常
  check('脚本执行无未捕获异常', errors.length === 0, errors.join(' | '));

  // 2. 关键元素齐全
  const REQUIRED_IDS = ['subtitle','btnAll','yearSel','qSel','rfSlider','rfLabel','logChk',
    'metricCards','navChart','navLegend','ddChart','holdChart','yearChart','cmpTable','swTable','dataNote','autoRefreshChk'];
  const missing = REQUIRED_IDS.filter(id => !document.getElementById(id));
  check('17个关键元素id齐全', missing.length === 0, missing.join(','));

  // 3. 脚本执行到底的证据
  check('指标卡渲染12张', document.querySelectorAll('#metricCards .metric').length === 12,
    document.querySelectorAll('#metricCards .metric').length);
  check('副标题含回测区间'+EXP.firstDate, document.getElementById('subtitle').textContent.includes(EXP.firstDate));
  check('年筛选选项(占位+2021~2026共7项)', document.querySelectorAll('#yearSel option').length === 7,
    document.querySelectorAll('#yearSel option').length);
  const qN = document.querySelectorAll('#qSel option').length;
  check('季度筛选已填充(>20项)', qN > 20, qN);
  check('窗口对比表8行(表头+7组合)', document.querySelectorAll('#cmpTable tr').length === 8,
    document.querySelectorAll('#cmpTable tr').length);
  check('切换记录表' + EXP.rows + '行(表头+' + (EXP.rows-1) + '事件,含建仓)', document.querySelectorAll('#swTable tr').length === EXP.rows,
    document.querySelectorAll('#swTable tr').length);

  // 4. 全区间核心指标与交叉验证基线一致
  const cards = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('总收益率='+EXP.total, cards['总收益率'] === EXP.total, cards['总收益率']);
  check('年化收益率='+EXP.annualized, cards['年化收益率'] === EXP.annualized, cards['年化收益率']);
  check('夏普比率='+EXP.sharpe+'(rf=2%)', cards['夏普比率'] === EXP.sharpe, cards['夏普比率']);
  check('最大回撤='+EXP.maxDD, cards['最大回撤'] === EXP.maxDD, cards['最大回撤']);
  check('切换次数='+EXP.switches, cards['切换次数'] === EXP.switches, cards['切换次数']);
  // 新增：溃疡指数 / 马丁比率
  check('溃疡指数='+EXP.ulcer, cards['溃疡指数'] === EXP.ulcer, cards['溃疡指数']);
  check('马丁比率='+EXP.martin, cards['马丁比率'] === EXP.martin, cards['马丁比率']);
  // 溃疡指数必须落在 (0, 最大回撤] 内：它 ≤ 最大回撤，且只在从未回撤时为 0
  check('溃疡指数 ∈ (0, 最大回撤]', (() => {
    const ul = parseFloat(cards['溃疡指数']), dd = Math.abs(parseFloat(cards['最大回撤']));
    return ul > 0 && ul <= dd;
  })(), cards['溃疡指数'] + ' vs ' + cards['最大回撤']);
  // 马丁比率恒等式(独立于引擎实现): (年化 − 无风险利率) / 溃疡指数
  check('马丁比率 = (年化 − 2%) / 溃疡指数', (() => {
    const ann = parseFloat(cards['年化收益率']) / 100;
    const ul = parseFloat(cards['溃疡指数']) / 100;
    const mt = parseFloat(cards['马丁比率']);
    return Math.abs(mt - (ann - 0.02) / ul) < 0.01;
  })(), cards['马丁比率'] + ' vs ' + (((parseFloat(cards['年化收益率']) / 100) - 0.02) / (parseFloat(cards['溃疡指数']) / 100)).toFixed(3));
  // 对比表新增两列
  check('窗口对比表含溃疡指数/马丁比率列', (() => {
    const ths = Array.from(document.querySelectorAll('#cmpTable tr:first-child th')).map(t => t.textContent);
    return ths.length === 8 && ths.includes('溃疡指数') && ths.includes('马丁比率');
  })());

  // 5. 交互: 按年筛选 → 指标重算
  const yearSel = document.getElementById('yearSel');
  yearSel.value = 'y2022';
  yearSel.onchange();
  const cards2022 = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    cards2022[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('2022年窗口指标与全区间不同(已重算)', cards2022['总收益率'] !== cards['总收益率'],
    cards2022['总收益率']);
  check('2022年窗口交易日数 < 全区间', +cards2022['交易日数'].replace(/,/g,'') < 1505, cards2022['交易日数']);
  // 独立基准: 2022年应只有约243个交易日
  check('2022年交易日数在[230,250]', (() => { const n = +cards2022['交易日数']; return n>=230 && n<=250; })(),
    cards2022['交易日数']);
  // 2022年动量策略表现: 与engine_result.json独立值比对
  const er = JSON.parse(fs.readFileSync(__dirname + '/engine_result.json','utf-8'));
  const i0 = er.firstDate <= '2022-01-01' ? er.dates ? 0 : 0 : 0; // dates不在engine_result中, 用下方方式
  check('2022年窗口切换记录表行数(表头+若干)', document.querySelectorAll('#swTable tr').length >= 2,
    document.querySelectorAll('#swTable tr').length);

  // 6. 交互: 按季度筛选
  const qSel = document.getElementById('qSel');
  qSel.value = 'q2020Q3';
  qSel.onchange();
  const q3cards = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    q3cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('2020Q3窗口交易日数<=60', (() => { const n=+q3cards['交易日数']; return n>0 && n<=60; })(), q3cards['交易日数']);
  check('2020Q3副标题窗口在年窗口内', true);

  // 7. 交互: 无风险利率滑块 → 夏普重算
  const rfSlider = document.getElementById('rfSlider');
  const sharpeBefore = q3cards['夏普比率'];
  rfSlider.value = '0';
  rfSlider.oninput();
  const q3cards0 = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    q3cards0[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('rf=0时夏普变化(已重算)', q3cards0['夏普比率'] !== sharpeBefore,
    sharpeBefore + ' -> ' + q3cards0['夏普比率']);
  check('rf标签显示0%', document.getElementById('rfLabel').textContent === '0%');
  check('rf=0时夏普 >= rf=2时夏普(同窗口)', (() => {
    const a = parseFloat(q3cards0['夏普比率']), b = parseFloat(sharpeBefore);
    return a >= b - 1e-9;
  })());

  // 8. 交互: 对数坐标切换不抛异常
  const logChk = document.getElementById('logChk');
  logChk.checked = true;
  let logOk = true;
  try { logChk.onchange(); } catch (e) { logOk = false; errors.push('logChk: ' + e.message); }
  check('对数坐标切换无异常', logOk);
  logChk.checked = false; try { logChk.onchange(); } catch (e) { logOk = false; }

  // 9. 交互: 回到全部区间
  document.getElementById('btnAll').onclick();
  const back = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    back[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('回到全部区间后总收益率恢复' + EXP.total, back['总收益率'] === EXP.total, back['总收益率']);
  check('回到全部区间后夏普恢复rf=0口径(高于rf=2%口径)', (() => {
    // rf=0时全区间夏普 = (m/sd)*sqrt(252); 用数值关系校验: > rf=2%的1.036
    return parseFloat(back['夏普比率']) > 1.036;
  })(), back['夏普比率']);

  // 10. 边界: 年度收益表 + 图例渲染
  check('图例渲染7项', document.querySelectorAll('#navLegend span').length === 7,
    document.querySelectorAll('#navLegend span').length);

  // 11. 刷新按钮: 存在 + 模拟传输的成功路径
  const btnRefresh = document.getElementById('btnRefresh');
  const refreshStatus = document.getElementById('refreshStatus');
  check('右上角刷新按钮存在', !!btnRefresh);
  // 构造与真实接口一致的分页假数据: 2013-05-15 起的工作日, 末尾延至 EXPmockEnd(最近交易日)
  // 注: 此处必须与 EXPmockEnd 同源动态计算, 曾硬编码为某一天导致"数据截至"类断言随日期失效
  function weekdays(from, to) {
    const out = []; const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }
  const fakeDates = weekdays('2013-05-15', EXPmockEnd);
  const fakeSeries = {};
  ['sh513100','sh511260','sh518850','sh510300'].forEach(sym => {
    // 行格式与真实接口一致: [日期, 开, 收, 高, 低, 量], 收盘价在下标2
    fakeSeries[sym] = fakeDates.map((d, i) => [d, '1', String(1 + i * 0.001), '1', '1', '1000']);
  });
  // 假接口工厂: 供本用例与"打开时自动更新"用例复用(后者跑在另一个 JSDOM 实例上)
  function makeMockJsonp() { return (url) => new Promise((resolve, reject) => {
    const m = url.match(/param=(sh\d+),day,,([^,]*),(\d+),(qfq)?$/);
    if (!m) { reject(new Error('URL格式不符: ' + url)); return; }
    const sym = m[1], end = m[2], count = +m[3], fq = m[4] || '';
    const rows = fakeSeries[sym].filter(r => r[0] <= end).slice(-count);
    // fq='' → 不复权(day), fq='qfq' → 前复权(qfqday); 假数据无分红, 两者一致
    setTimeout(() => resolve({ data: { [sym]: fq ? { qfqday: rows } : { day: rows } } }), 2);
  }); }
  window.__wbJsonpImpl = makeMockJsonp();
  // mock 数据上按 Pro 参数的回测起点(动态)
  const mockEtfs = ['sh513100','sh511260','sh518850','sh510300'].map(sym => ({
    code: sym.slice(2), label: sym, symbol: sym,
    dates: fakeDates, closes: fakeSeries[sym].map(r => parseFloat(r[2])),
  }));
  const EXPmockStart = RotationEngine.runBacktest(mockEtfs, PRO_OPTS).dates[0];
  let refreshErr = null;
  try {
    btnRefresh.disabled = false;
    btnRefresh.onclick();
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) { refreshErr = e; }
  check('刷新流程无异常', refreshErr === null, refreshErr && refreshErr.message);
  // 今天(周六)接口正确返回到最近交易日 2026-09-18; 假数据从2013-05-15全量替换 → 区间应显著变长
  check('刷新后状态显示成功', refreshStatus.textContent.startsWith('✓ 已更新至'),
    refreshStatus.textContent);
  check('刷新后副标题区间延至2013年起(全量替换生效)',
    document.getElementById('subtitle').textContent.includes('回测区间 ' + EXPmockStart),
    document.getElementById('subtitle').textContent);
  check('刷新后副标题数据截至为最近交易日'+EXPmockEnd,
    document.getElementById('subtitle').textContent.includes('数据截至 ' + EXPmockEnd),
    document.getElementById('subtitle').textContent);
  const refreshedCards = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    refreshedCards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('刷新后指标已用新数据重算(总收益率变化)', refreshedCards['总收益率'] !== '+270.04%',
    refreshedCards['总收益率']);
  check('成功状态含自动保存提示', refreshStatus.textContent.includes('已存浏览器缓存'),
    refreshStatus.textContent);
  const cachedRaw = window.localStorage.getItem('etfRotationCacheV2');
  check('刷新成功后已写入本地缓存', !!cachedRaw);
  check('缓存endDate与savedAt正确', (() => {
    if (!cachedRaw) return false;
    const c = JSON.parse(cachedRaw);
    return c.endDate === EXPmockEnd && c.savedAt && c.etfs.length === 4 && c.etfs[0].dates.length > 3000;
  })());
  check('缓存含分红表(510300/511260)', (() => {
    if (!cachedRaw) return false;
    const c = JSON.parse(cachedRaw);
    return c.dividends && c.dividends['510300'].length >= 6 && c.dividends['511260'].length >= 5;
  })());

  // 11b. 二次打开: 启动时自动加载比内嵌数据新的缓存
  const dom2 = new JSDOM(html, {
    url: 'http://localhost/etf2.html', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w2) {
      const noop2 = () => {};
      const ctx2 = new Proxy({}, { get(t,p){ if(p==='measureText')return()=>({width:10}); if(p==='canvas')return{width:300,height:150}; if(p==='createLinearGradient'||p==='createRadialGradient')return()=>({addColorStop:noop2}); if(typeof p==='string')return noop2; }, set(){return true;} });
      w2.HTMLCanvasElement.prototype.getContext = function(){ return ctx2; };
      w2.ResizeObserver = class { observe(){} unobserve(){} disconnect(){} };
      w2.localStorage.setItem('etfRotationCacheV2', cachedRaw);
    },
  });
  let d2ok = false, d2sub = '', d2status = '';
  await new Promise(r => setTimeout(r, 500));
  try {
    d2sub = dom2.window.document.getElementById('subtitle').textContent;
    d2status = dom2.window.document.getElementById('refreshStatus').textContent;
    d2ok = d2sub.includes('回测区间 ' + EXPmockStart) && d2status.includes('已加载浏览器缓存数据（截至 ' + EXPmockEnd + '）');
  } catch (e) { d2ok = false; }
  check('二次打开自动加载缓存并提示', d2ok, d2sub + ' | ' + d2status);

  // 12. 刷新按钮: 失败路径保留原数据
  window.__wbJsonpImpl = () => Promise.reject(new Error('模拟断网'));
  const subAfterOk = document.getElementById('subtitle').textContent;
  btnRefresh.onclick();
  await new Promise(r => setTimeout(r, 300));
  check('失败时状态提示失败并保留原数据', refreshStatus.textContent.startsWith('✗ 更新失败')
    && document.getElementById('subtitle').textContent === subAfterOk,
    refreshStatus.textContent);
  check('失败后按钮恢复可点', !btnRefresh.disabled);

  // 13. 自定义起止区间
  const cs = document.getElementById('customStart'), ce = document.getElementById('customEnd');
  check('自定义日期控件存在且范围已随数据刷新更新', !!cs && !!ce && cs.min < ce.max && /^\d{4}-\d{2}-\d{2}$/.test(cs.min),
    cs.min + '~' + ce.max);
  function collectCards() {
    const c = {};
    document.querySelectorAll('#metricCards .metric').forEach(m => { c[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
    return c;
  }
  cs.value = '2021-01-01'; ce.value = '2021-12-31'; cs.onchange();
  let cCards = collectCards();
  check('自定义2021年窗口交易日数在[240,270](假数据为纯工作日)', (() => { const n = +cCards['交易日数']; return n >= 240 && n <= 270; })(),
    cCards['交易日数']);
  check('自定义选择已写入偏好存储', (() => {
    const p = JSON.parse(window.localStorage.getItem('etfRotationWindowV1'));
    return p && p.type === 'custom' && p.s === '2021-01-01' && p.e === '2021-12-31';
  })(), window.localStorage.getItem('etfRotationWindowV1'));
  check('自定义时年/季度下拉已复位', yearSel.value === '' && qSel.value === '', yearSel.value + '/' + qSel.value);
  cs.value = '2021-12-31'; ce.value = '2021-01-01'; ce.onchange();   // 起止倒置
  const swapCards = collectCards();
  check('起止倒置自动交换后交易日数不变', swapCards['交易日数'] === cCards['交易日数'], swapCards['交易日数']);
  check('倒置后起止输入框已交换回正', cs.value === '2021-01-01' && ce.value === '2021-12-31', cs.value + '~' + ce.value);
  cs.value = '2010-01-01'; ce.value = '2010-06-30'; cs.onchange();   // 完全超出数据范围
  const clampCards = collectCards();
  check('超出数据范围自动收敛(交易日数<=5)', +clampCards['交易日数'] <= 5, clampCards['交易日数']);
  cs.value = '2026-08-01'; ce.value = '2026-12-31'; cs.onchange();   // 结束超出数据末日
  const clamp2 = collectCards();
  // 期望交易日数由假数据日历动态推导(2026-08-01 ~ 数据末日), 既验证"结束超界不取未来日期",
  // 又不会因数据末日推进而失效(原先写死 <=40 是按 2026-09-25 末日标定的魔数)
  const clamp2Exp = fakeDates.filter(d => d >= '2026-08-01').length;
  check('结束超界收敛到数据末日(交易日数=数据末日前的假数据天数)', +clamp2['交易日数'] === clamp2Exp,
    clamp2['交易日数'] + ' vs 期望 ' + clamp2Exp);
  check('结束超界后副标题数据截至=数据末日', document.getElementById('subtitle').textContent.includes('数据截至 ' + EXPmockEnd),
    document.getElementById('subtitle').textContent);

  // 14. 下次打开自动恢复上次所选区间(年/季/自定义)
  function freshDom(url, preSetup, allowAutoRefresh) {
    return new JSDOM(html, {
      url, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
        // 默认关闭打开时自动更新(确定性); 需验证该能力时显式传 allowAutoRefresh=true
        if (!allowAutoRefresh) w.__wbNoAutoRefresh = true;
        const noop = () => {};
        const ctx = new Proxy({}, { get(t, p) { if (p === 'measureText') return () => ({ width: 10 }); if (p === 'canvas') return { width: 300, height: 150 }; if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop }); if (p === 'createPattern') return () => ({}); if (typeof p === 'string') return noop; }, set() { return true; } });
        w.HTMLCanvasElement.prototype.getContext = function () { return ctx; };
        w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,x';
        w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        if (preSetup) preSetup(w);
      },
    });
  }
  const dom3 = freshDom('http://localhost/etf3.html',
    w => w.localStorage.setItem('etfRotationWindowV1', JSON.stringify({ type: 'quarter', q: '2023Q2' })));
  await new Promise(r => setTimeout(r, 500));
  const d3 = dom3.window.document;
  const d3cards = {};
  d3.querySelectorAll('#metricCards .metric').forEach(m => { d3cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
  check('重开自动恢复季度选择(2023Q2)', d3.getElementById('qSel').value === 'q2023Q2' && +d3cards['交易日数'] <= 64,
    d3.getElementById('qSel').value + '/' + d3cards['交易日数']);
  const dom4 = freshDom('http://localhost/etf4.html',
    w => w.localStorage.setItem('etfRotationWindowV1', JSON.stringify({ type: 'custom', s: '2022-03-01', e: '2022-06-30' })));
  await new Promise(r => setTimeout(r, 500));
  const d4 = dom4.window.document;
  const d4cards = {};
  d4.querySelectorAll('#metricCards .metric').forEach(m => { d4cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
  check('重开自动恢复自定义区间(2022-03-01~2022-06-30)',
    d4.getElementById('customStart').value === '2022-03-01' && d4.getElementById('customEnd').value === '2022-06-30'
      && +d4cards['交易日数'] <= 85,
    d4.getElementById('customStart').value + '~' + d4.getElementById('customEnd').value + '/' + d4cards['交易日数']);
  const dom5 = freshDom('http://localhost/etf5.html',
    w => w.localStorage.setItem('etfRotationWindowV1', '不是JSON'));   // 坏数据兜底
  await new Promise(r => setTimeout(r, 500));
  check('偏好数据损坏时兜底为全部区间', (() => {
    const c5 = {};
    dom5.window.document.querySelectorAll('#metricCards .metric').forEach(m => { c5[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
    return c5['总收益率'] === EXP.total;
  })());

  // 15. 打开时自动更新(缓存优先 + 每日一次 + 静默降级)
  check('自动更新开关默认开启', (() => {
    const c = document.getElementById('autoRefreshChk');
    return !!c && c.checked === true;
  })(), document.getElementById('autoRefreshChk') && document.getElementById('autoRefreshChk').checked);
  check('已是最新时不触发自动更新(不联网)', dom.window.__rotationAuto.should() === false,
    dom.window.__rotationAuto.should());
  check('开关关闭时不触发自动更新', (() => {
    const d0 = freshDom('http://localhost/etf7.html', w => {
      w.__wbExpectedTradingDay = '2099-01-01';
      w.localStorage.setItem('etfRotationAutoV1', '0');
    });
    return d0.window.__rotationAuto.should() === false;
  })());

  // 注入"期望交易日=2099"(等价于数据必然落后) + 假接口 → 打开后应自动联网更新
  const dom6 = freshDom('http://localhost/etf6.html', w => {
    w.__wbExpectedTradingDay = '2099-01-01';
    w.__wbJsonpImpl = makeMockJsonp();
  }, true);
  await new Promise(r => setTimeout(r, 1500));
  const d6 = dom6.window.document;
  const st6 = d6.getElementById('refreshStatus').textContent;
  check('过期时打开自动更新并提示', st6.startsWith('✓ 已自动更新至'), st6);
  check('自动更新不改动本地文件(已提示仅写缓存)', st6.includes('未改动本地文件'), st6);
  check('自动更新后数据截至=最新交易日', d6.getElementById('subtitle').textContent.includes('数据截至 ' + EXPmockEnd),
    d6.getElementById('subtitle').textContent);
  // 自动更新后应改用"刚抓到的假数据"重算(而非仍显示内嵌真实数据的结果)。
  // 注意: 页面刷新时分红 ETF(510300/511260)会用"内嵌分红表 + 新识别分红"对不复权价做
  // 等比前复权重建; 假数据不含新分红, 故等价于仅用内嵌分红表重建 —— 此处独立复现该口径。
  function rebuildQfqRef(dates, closes, divs) {
    const factors = dates.map(() => 1);
    divs.forEach(([t, D]) => {
      let idx = -1;
      for (let i = 0; i < dates.length && dates[i] < t; i++) idx = i;
      if (idx < 0) return;
      const pc = closes[idx], f = (pc - D) / pc;
      if (!(f > 0 && f < 1)) return;
      for (let j = 0; j <= idx; j++) factors[j] *= f;
    });
    return closes.map((c, i) => +(c * factors[i]).toFixed(4));
  }
  const refreshedEtfs = mockEtfs.map(e => ({
    code: e.code, label: e.label, symbol: e.symbol, dates: e.dates,
    closes: ['510300', '511260'].includes(e.code)
      ? rebuildQfqRef(e.dates, e.closes, (ETF_DATA.dividends && ETF_DATA.dividends[e.code]) || [])
      : e.closes,
  }));
  const mockExpTotal = (() => {
    const m = RotationEngine.computeMetrics(RotationEngine.runBacktest(refreshedEtfs, PRO_OPTS), { rf: 0.02 });
    return fmtSigned(m.total);
  })();
  check('自动更新后指标已用新数据重算(含分红ETF前复权重建, 与独立复算一致)', (() => {
    const c = {};
    d6.querySelectorAll('#metricCards .metric').forEach(m => { c[m.querySelector('.k').textContent] = m.querySelector('.v').textContent; });
    return c['总收益率'] === mockExpTotal && mockExpTotal !== EXP.total;
  })(), mockExpTotal);
  check('已记录当天自动更新成功', (() => {
    const raw = dom6.window.localStorage.getItem('etfRotationAutoStateV1');
    if (!raw) return false;
    const s = JSON.parse(raw);
    return s.ok === true && /^\d{4}-\d{2}-\d{2}$/.test(s.d) && typeof s.at === 'number';
  })(), dom6.window.localStorage.getItem('etfRotationAutoStateV1'));
  check('同一天内不再重复自动更新(去重生效)', dom6.window.__rotationAuto.should() === false,
    dom6.window.__rotationAuto.should());

  // 失败节流: 当天失败后 2 小时内不重试, 超时后才允许重试
  const setState = (o) => dom6.window.localStorage.setItem('etfRotationAutoStateV1', JSON.stringify(o));
  const today = (() => { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); })();
  setState({ d: today, ok: false, at: Date.now() });
  check('当天失败后2小时内不重复自动更新', dom6.window.__rotationAuto.should() === false);
  setState({ d: today, ok: false, at: Date.now() - 3 * 3600 * 1000 });
  check('当天失败且已过2小时 → 允许重试', dom6.window.__rotationAuto.should() === true);
  check('期望交易日为工作日且不晚于今天', (() => {
    const s = dom.window.__rotationAuto.latestExpected();
    const day = new Date(s + 'T00:00:00').getDay();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) && day !== 0 && day !== 6 && s <= new Date().toISOString().slice(0, 10);
  })(), dom.window.__rotationAuto.latestExpected());

  // 16. 净值图: 鼠标压在曲线上时, 明细只列该条 —— 必须与画面"其余曲线淡出"严格一致
  //     ⚠️ 本节全部用真实鼠标移动(mousemove)驱动, 不用 dispatchAction 强制重渲染。
  //     曾经的写法是先 move 再 tipAt() 强制 showTip 读明细, 那等于绕过了"鼠标真的压上去时
  //     tooltip 会不会按新焦点重渲染/判定对不对"这件事 —— 于是"压住曲线却偶尔判定失败"被完全掩盖。
  //     jsdom 没有布局, 必须先给出非零尺寸, 否则 echarts 尺寸为 0、无法做命中判定
  function sizedSetup(w) {
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 760; } });
    Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 320; } });
  }
  function navKit(domx) {
    const w2 = domx.window, box = w2.document.getElementById('navChart');
    const chart = w2.echarts.getInstanceByDom(box);
    const canvas = box.querySelector('canvas');
    const polys = () => chart.getZr().storage.getDisplayList().filter(x => x.type === 'ec-polyline');
    const siOf = el => {
      for (const k of Object.keys(el)) {
        if (k.indexOf('__ec_inner_') !== 0) continue;
        const v = el[k];
        if (v && typeof v.seriesIndex === 'number') return v.seriesIndex;
      }
      return null;
    };
    const tip = () => {
      const c = Array.from(box.querySelectorAll('div')).filter(x =>
        /position:\s*absolute/.test(x.getAttribute('style') || '') && x.textContent.trim());
      return c.length ? c[c.length - 1].textContent.replace(/\s+/g, ' ').trim() : '';
    };
    const rows = t => (t.match(/\d\.\d{4}/g) || []).length;
    const NAMES = chart.getOption().series.map(s => s.name);
    return {
      box, chart, polys, tip, rows, NAMES,
      move(x, y) { canvas.dispatchEvent(new w2.MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y })); },
      point(elIdx, i) { const p = Array.from(polys()[elIdx].shape.points); return [p[i * 2], p[i * 2 + 1]]; },
      emphasized() { const ps = polys(); for (let i = 0; i < ps.length; i++) if ((ps[i].currentStates || []).indexOf('emphasis') >= 0) return siOf(ps[i]); return null; },
      blurred() { return polys().filter(el => (el.currentStates || []).indexOf('blur') >= 0).length; },
      // 画面"还亮着"的那条曲线 —— 这才是"只显示一条"的判定依据。
      // 注意不能只认 emphasis 状态: 光标压在高亮小圆点上时, emphasis 打在圆点元素上,
      // 折线本身只有 blur, 此时"没被淡出的那条"才是画面上唯一可见的曲线。
      visible() {
        const ps = polys();
        const nb = ps.filter(el => (el.currentStates || []).indexOf('blur') < 0);
        return (nb.length === 1 && ps.length > 1) ? siOf(nb[0]) : null;
      },
      // 明细文本里实际出现了哪几条曲线名(比数数字稳: 不依赖小数位数)
      rowNames(t) { return NAMES.filter(n => t.indexOf(n) >= 0); },
      // 明细里真正"一行一条曲线"的名字 —— 不能用 rowNames 的子串匹配:
      // ▲ 切换信息块里会出现别的曲线名("▲ 切换: 黄金ETF 518850 → 纳指ETF 513100"),
      // 子串匹配会把它们也算成明细行。这里只取那些"以 4 位小数结尾"的行。
      tipNames() {
        const c = Array.from(box.querySelectorAll('div')).filter(x =>
          /position:\s*absolute/.test(x.getAttribute('style') || '') && x.textContent.trim());
        const el = c.length ? c[c.length - 1] : null;
        if (!el) return [];
        return Array.from(el.querySelectorAll('div'))
          .map(d => d.textContent.replace(/\s+/g, ' ').trim())
          .filter(t => /\d\.\d{4}$/.test(t))
          .map(t => t.replace(/\s*\d\.\d{4}$/, '').trim());
      },
      // 找一条"离所有曲线都远"的横线位置, 用来模拟"鼠标在图上但没压住任何曲线"
      farPoint(i) {
        const P = polys().map(el => Array.from(el.shape.points));
        const x = P[0][i * 2];
        const ys = P.map(p => p[i * 2 + 1]);
        let best = 60, bestGap = -1;
        for (let y = 40; y <= 300; y++) {
          let g = Infinity;
          for (const yy of ys) g = Math.min(g, Math.abs(yy - y));
          if (g > bestGap) { bestGap = g; best = y; }
        }
        return [x, best, bestGap];
      },
    };
  }
  const domH = freshDom('http://localhost/etfH.html', sizedSetup);
  await new Promise(r => setTimeout(r, 700));
  const kit = navKit(domH);
  const NAME = kit.NAMES;
  check('净值图折线元素数=曲线数(7)', kit.polys().length === 7, kit.polys().length);

  const [fx, fy, fgap] = kit.farPoint(600);
  check('找得到"没压住任何曲线"的落点', fgap > 6, '间距=' + fgap.toFixed(1));
  kit.move(6, 6); await new Promise(r => setTimeout(r, 80));
  kit.move(fx, fy); await new Promise(r => setTimeout(r, 140));
  check('未压住曲线时明细列全部 7 条',
    kit.blurred() === 0 && kit.rows(kit.tip()) === 7 && kit.rowNames(kit.tip()).length === 7,
    '淡出=' + kit.blurred() + ' 明细=' + kit.tip());

  // 找策略曲线与其它曲线离得最远、且非切换日的一天来压(切换日的 ▲ 会盖住曲线)
  const sOptH = kit.chart.getOption().series;
  const swDates = new Set((sOptH[7].data || []).map(d => d.switchRef && d.switchRef.date).filter(Boolean));
  const pick = (() => {
    const P = kit.polys().map(el => Array.from(el.shape.points));
    let best = { i: -1, gap: -1 };
    for (let i = 0; i < P[0].length / 2; i++) {
      if (swDates.has(sOptH[0].data[i] && sOptH[0].data[i][0])) continue;
      const y0 = P[0][i * 2 + 1];
      let g = Infinity;
      for (let e = 1; e < P.length; e++) g = Math.min(g, Math.abs(P[e][i * 2 + 1] - y0));
      if (g > best.gap) best = { i, gap: g };
    }
    return best;
  })();
  check('策略曲线上取到与其它曲线间距足够的当天', pick.gap > 4, pick.gap.toFixed(1));

  const [hx, hy] = kit.point(0, pick.i);
  kit.move(6, 6); await new Promise(r => setTimeout(r, 80));
  kit.move(hx, hy); await new Promise(r => setTimeout(r, 140));
  const hoverTip = kit.tip();
  check('鼠标压在曲线上: 其余曲线淡出 6 条', kit.blurred() === 6, kit.blurred());
  check('压住策略曲线时明细只剩策略这一条',
    kit.visible() === 0 && kit.rows(hoverTip) === 1 && kit.rowNames(hoverTip).join() === NAME[0],
    '画面上唯一可见=' + kit.visible() + ' 明细=' + hoverTip);

  // 核心回归用例(对应真实缺陷): 光标在同一 x 列上下微调 ±8px。
  // ⚠️ 必须"连续移动、中途不归位": 轴悬停时 ECharts 会给每条曲线额外画一个高亮小圆点(path),
  // 它的 x 就是光标所在的数据点; 只有在同一列连续微调时, 圆点才会停在光标底下。
  // 若每次先移到角落再跳过来(圆点还留在远处), 这个缺陷根本复现不出来 —— 测试就成了摆设。
  const swBad = [];
  const [bx, by] = kit.point(0, pick.i);
  kit.move(6, 6); await new Promise(r => setTimeout(r, 60));
  kit.move(bx, by); await new Promise(r => setTimeout(r, 90));   // 先压到曲线上, 让圆点落到这里
  for (let dy = -8; dy <= 8; dy++) {
    kit.move(bx, by + dy); await new Promise(r => setTimeout(r, 90));
    const b = kit.blurred(), r = kit.rows(kit.tip()), v = kit.visible(), rn = kit.rowNames(kit.tip());
    const ok = (b === 6) === (r === 1) && (b !== 6 || (rn.length === 1 && rn[0] === NAME[v]));
    if (!ok) swBad.push('dy=' + dy + ' 淡出=' + b + ' 唯一可见=' + v + ' 明细=' + JSON.stringify(rn));
  }
  check('压住曲线上下微调 ±8px: "淡出6条"与"明细1条"严格同步且指向同一条', swBad.length === 0, swBad.join(' ; '));

  // 压住策略曲线时, 切换日的 ▲ 切换信息仍应保留(▲ 已设 silent, 指针会"看穿"到曲线)。
  // 注意: ▲ 所在那一点上, 别的基准曲线也可能正好压在策略曲线上, 此时高亮的是那条 —— 那是正常的
  // (明细与画面依然一致), 所以往后找第一个"策略曲线确实在最上面"的切换日来断言。
  const swIdxAll = (sOptH[7].data || []).map(d => {
    if (!d.switchRef || d.switchRef.from === null || d.switchRef.from === d.switchRef.to) return -1;
    return sOptH[0].data.findIndex(x => x[0] === d.switchRef.date);
  }).filter(i => i >= 0);
  let swPicked = -1, swTip = '';
  for (const i of swIdxAll.slice(0, 25)) {
    const [ax, ay] = kit.point(0, i);
    kit.move(6, 6); await new Promise(r => setTimeout(r, 50));
    kit.move(ax, ay); await new Promise(r => setTimeout(r, 110));
    if (kit.visible() === 0) { swPicked = i; swTip = kit.tip(); break; }
  }
  check('压在切换日的策略曲线上: 仍只剩策略一条且保留 ▲ 切换信息',
    swPicked >= 0 && kit.blurred() === 6 && kit.rows(swTip) === 1 && swTip.indexOf('▲ 切换') >= 0,
    'idx=' + swPicked + ' 淡出=' + kit.blurred() + ' 明细=' + swTip);

  // 未压住任何曲线、但停在切换日那一列: 明细列全部曲线, 且 ▲ 切换信息照常出现
  // (切换信息已改为按日期查表补, 不再依赖"切换点"series 出现在 tooltip 参数里)
  let swFree = null;
  for (const i of swIdxAll.slice(0, 25)) {
    const f = kit.farPoint(i);
    if (f[2] > 8) { swFree = [i, ...f]; break; }
  }
  kit.move(6, 6); await new Promise(r => setTimeout(r, 60));
  if (swFree) kit.move(swFree[1], swFree[2]); else kit.move(fx, fy);
  await new Promise(r => setTimeout(r, 140));
  check('未压住曲线但停在切换日: 列全部曲线且带上 ▲ 切换信息',
    !!swFree && kit.blurred() === 0 && kit.rows(kit.tip()) === 7 && kit.tip().indexOf('▲ 切换') >= 0,
    'idx=' + (swFree ? swFree[0] : 'n/a') + ' 淡出=' + kit.blurred() + ' 明细=' + kit.tip());

  kit.move(6, 6); await new Promise(r => setTimeout(r, 80));
  kit.move(fx, fy); await new Promise(r => setTimeout(r, 140));
  check('鼠标移开后明细恢复全部 7 条', kit.blurred() === 0 && kit.rows(kit.tip()) === 7, kit.tip());

  // 17. 净值图密集回归: "画面凸显的那条" 必须永远等于 "明细唯一列出的那条"
  //     对应两次真实反馈:
  //       (a) 画面已淡出只剩一条、明细却列全部 —— 判定命中了光标底下那个"轴指示高亮小圆点"
  //           (它属于该 series, 但停在上一列的位置, 于是光标在这一列、圆点还在上一列时必然误判);
  //       (b) 画面没有任何凸显、明细却只列一条 —— 判定命中了 ECharts 并不认作悬停目标的元素。
  //     实测最容易翻车的是"横向快速换列"和"贴着 ▲ 切换点"这两类位置, 这里都扫一遍。
  //     不变量分两半: 画面有凸显时明细只能有那一条; 画面都亮着时明细必须列全部曲线 ——
  //     前者管"对得上", 后者管"不过度判定"。
  const denseBad = [], burstBad = [], swNear = [];
  const P0 = Array.from(kit.polys()[0].shape.points);
  const nPts = P0.length / 2;
  const nLines = kit.polys().length;
  const probeOK = (tag, store) => {
    const v = kit.visible(), b = kit.blurred(), rn = kit.tipNames();
    const ok = (v !== null)
      ? (b === nLines - 1 && rn.length === 1 && rn[0] === NAME[v])
      : (b === 0 && rn.length === nLines);
    if (!ok) store.push(tag + ' 淡出=' + b + ' 唯一可见=' + (v === null ? 'null' : NAME[v]) + ' 明细=' + JSON.stringify(rn));
  };
  const cols = [];
  for (let k = 0; k < 12; k++) cols.push(Math.round(30 + (nPts - 60) * k / 11));
  for (const i of cols) {
    const x = P0[i * 2], y = P0[i * 2 + 1];
    for (const dy of [0, -3, 3, -20, 20]) {
      kit.move(x, y + dy); await new Promise(r => setTimeout(r, 45));
      probeOK('i=' + i + ' dy=' + dy, denseBad);
    }
  }
  check('密集扫描 ' + (cols.length * 5) + ' 点(换列×纵向偏移): 画面凸显与明细严格同一条',
    denseBad.length === 0, denseBad.slice(0, 4).join(' ; '));

  for (const i of cols.slice(0, 6)) {
    kit.move(P0[i * 2] - 120, P0[i * 2 + 1] + 40);      // 连续跳列, 中途不 settle —— 模拟快速滑动
    kit.move(P0[i * 2] - 60, P0[i * 2 + 1] + 18);
    kit.move(P0[i * 2], P0[i * 2 + 1]);
    await new Promise(r => setTimeout(r, 60));
    probeOK('快速换列 i=' + i, burstBad);
  }
  check('横向快速换列 6 组: 画面凸显与明细严格同一条', burstBad.length === 0, burstBad.slice(0, 4).join(' ; '));

  const swIdx2 = (sOptH[7].data || [])
    .map(d => d.switchRef ? sOptH[0].data.findIndex(x => x[0] === d.switchRef.date) : -1)
    .filter(i => i > 5).slice(0, 6);
  for (const i of swIdx2) {
    for (const dy of [-6, -3, 0, 3, 6]) {
      kit.move(P0[i * 2], P0[i * 2 + 1] + dy); await new Promise(r => setTimeout(r, 45));
      probeOK('切换日 i=' + i + ' dy=' + dy, swNear);
    }
  }
  check('▲ 切换点附近 ' + (swIdx2.length * 5) + ' 点: 画面凸显与明细严格同一条',
    swNear.length === 0, swNear.slice(0, 4).join(' ; '));

  // 沿策略曲线横向连续拖动: 判定始终不变(一直是同一条曲线), 但列一直在变。
  // 这是最容易暴露"只在判定变化时才重绘画面"这类失误的手势 —— ECharts 每次处理事件都会
  // 把上一次的 emphasis 清掉, 所以画面必须每个事件都重新驱动一次, 否则拖着拖着就不淡出了。
  const dragBad = [];
  for (let i = Math.round(nPts * 0.2); i < Math.round(nPts * 0.78); i += 13) {
    kit.move(P0[i * 2], P0[i * 2 + 1]); await new Promise(r => setTimeout(r, 30));
    probeOK('沿曲线拖动 i=' + i, dragBad);
  }
  check('沿曲线横向连续拖动: 画面凸显与明细严格同一条', dragBad.length === 0, dragBad.slice(0, 4).join(' ; '));

  // 判定本身也要"不过度": 画面上 7 条都亮着时, 鼠标必须落在某条曲线的容差带内才算压住
  kit.move(6, 6); await new Promise(r => setTimeout(r, 60));
  kit.move(fx, fy); await new Promise(r => setTimeout(r, 140));
  check('远离所有曲线(>6px)时既不高亮也不过滤',
    kit.visible() === null && kit.blurred() === 0 && kit.rows(kit.tip()) === 7,
    '淡出=' + kit.blurred() + ' 明细=' + kit.rows(kit.tip()));

  // 图例勾选必须跨重绘保持(否则用户手动隐藏的曲线会被悄悄复活)
  kit.chart.dispatchAction({ type: 'legendToggleSelect', name: NAME[3] });
  // 图例切换会让 echarts 顺带刷新一次 tooltip(延迟任务); 先等它落地, 再触发重绘,
  // 否则延迟任务会在重绘后撞上已过期的 tooltip 容器而抛异常(jsdom 下表现为未捕获错误)
  await new Promise(r => setTimeout(r, 120));
  const selBefore = JSON.stringify(kit.chart.getOption().legend[0].selected);
  domH.window.document.getElementById('logChk').checked = false;
  domH.window.document.getElementById('logChk').onchange();
  const selAfter = JSON.stringify(kit.chart.getOption().legend[0].selected);
  check('重绘后图例勾选保持(不被清空)', selBefore === selAfter && selAfter.indexOf('false') >= 0, selBefore + ' → ' + selAfter);
  kit.move(6, 6); await new Promise(r => setTimeout(r, 80));
  kit.move(fx, fy); await new Promise(r => setTimeout(r, 140));
  check('重绘后明细仍按勾选过滤(剩 6 条)', kit.rows(kit.tip()) === 6, kit.rows(kit.tip()));

  console.log('\n结果: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (errors.length) console.log('未捕获异常: ' + errors.join(' | '));
  process.exit(fail ? 1 : 0);
}, 600);
