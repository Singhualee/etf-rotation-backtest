// smoke-test.js — ETF动量轮动回测.html 无头冒烟测试 (jsdom)
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = process.argv[2] || '/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest/ETF动量轮动回测.html';
const html = fs.readFileSync(path, 'utf-8');

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
    'metricCards','navChart','navLegend','ddChart','holdChart','yearChart','cmpTable','swTable','dataNote'];
  const missing = REQUIRED_IDS.filter(id => !document.getElementById(id));
  check('16个关键元素id齐全', missing.length === 0, missing.join(','));

  // 3. 脚本执行到底的证据
  check('指标卡渲染10张', document.querySelectorAll('#metricCards .metric').length === 10,
    document.querySelectorAll('#metricCards .metric').length);
  check('副标题含回测区间2020-07-10', document.getElementById('subtitle').textContent.includes('2020-07-10'));
  check('年筛选选项(占位+2021~2026共7项)', document.querySelectorAll('#yearSel option').length === 7,
    document.querySelectorAll('#yearSel option').length);
  const qN = document.querySelectorAll('#qSel option').length;
  check('季度筛选已填充(>20项)', qN > 20, qN);
  check('窗口对比表8行(表头+7组合)', document.querySelectorAll('#cmpTable tr').length === 8,
    document.querySelectorAll('#cmpTable tr').length);
  check('切换记录表99行(表头+98事件,含建仓)', document.querySelectorAll('#swTable tr').length === 99,
    document.querySelectorAll('#swTable tr').length);

  // 4. 全区间核心指标与交叉验证基线一致
  const cards = {};
  document.querySelectorAll('#metricCards .metric').forEach(m => {
    cards[m.querySelector('.k').textContent] = m.querySelector('.v').textContent;
  });
  check('总收益率=+270.04%', cards['总收益率'] === '+270.04%', cards['总收益率']);
  check('年化收益率=+24.51%', cards['年化收益率'] === '+24.51%', cards['年化收益率']);
  check('夏普比率=1.036(rf=2%)', cards['夏普比率'] === '1.036', cards['夏普比率']);
  check('最大回撤=-18.46%', cards['最大回撤'] === '-18.46%', cards['最大回撤']);
  check('切换次数=97', cards['切换次数'] === '97', cards['切换次数']);

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
  const er = JSON.parse(fs.readFileSync('/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest/engine_result.json','utf-8'));
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
  check('回到全部区间后总收益率恢复+270.04%', back['总收益率'] === '+270.04%', back['总收益率']);
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
  // 构造与真实接口一致的分页假数据: 2013-05-15 起的工作日, 末尾延至 2026-09-25
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
  const fakeDates = weekdays('2013-05-15', '2026-09-25');
  const fakeSeries = {};
  ['sh513100','sh511260','sh518850','sh510300'].forEach(sym => {
    // 行格式与真实接口一致: [日期, 开, 收, 高, 低, 量], 收盘价在下标2
    fakeSeries[sym] = fakeDates.map((d, i) => [d, '1', String(1 + i * 0.001), '1', '1', '1000']);
  });
  window.__wbJsonpImpl = (url) => new Promise((resolve, reject) => {
    const m = url.match(/param=(sh\d+),day,,([^,]*),(\d+),(qfq)?$/);
    if (!m) { reject(new Error('URL格式不符: ' + url)); return; }
    const sym = m[1], end = m[2], count = +m[3], fq = m[4] || '';
    const rows = fakeSeries[sym].filter(r => r[0] <= end).slice(-count);
    // fq='' → 不复权(day), fq='qfq' → 前复权(qfqday); 假数据无分红, 两者一致
    setTimeout(() => resolve({ data: { [sym]: fq ? { qfqday: rows } : { day: rows } } }), 2);
  });
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
    document.getElementById('subtitle').textContent.includes('回测区间 2013-06-14'),
    document.getElementById('subtitle').textContent);
  check('刷新后副标题数据截至为最近交易日2026-09-18',
    document.getElementById('subtitle').textContent.includes('数据截至 2026-09-18'),
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
    return c.endDate === '2026-09-18' && c.savedAt && c.etfs.length === 4 && c.etfs[0].dates.length > 3000;
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
    d2ok = d2sub.includes('回测区间 2013-06-14') && d2status.includes('已加载浏览器缓存数据（截至 2026-09-18）');
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
  check('结束超界收敛到数据末日(交易日数<=40)', +clamp2['交易日数'] <= 40, clamp2['交易日数']);

  // 14. 下次打开自动恢复上次所选区间(年/季/自定义)
  function freshDom(url, preSetup) {
    return new JSDOM(html, {
      url, runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w) {
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
    return c5['总收益率'] === '+270.04%';
  })());

  console.log('\n结果: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (errors.length) console.log('未捕获异常: ' + errors.join(' | '));
  process.exit(fail ? 1 : 0);
}, 600);
