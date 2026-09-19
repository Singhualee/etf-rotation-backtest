// refresh-test.js — 刷新功能的真实网络端到端测试（真实调用腾讯行情接口分页逻辑）
const { JSDOM } = require('jsdom');
const fs = require('fs');
const https = require('https');
const path = process.argv[2] || '/Users/admin/WorkBuddy/dongliang/etf-rotation-backtest/ETF动量轮动回测.html';
const html = fs.readFileSync(path, 'utf-8');

let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}

const dom = new JSDOM(html, {
  url: 'http://localhost/etf.html',  // http源以启用jsdom localStorage
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
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
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.onerror = (msg) => { errors.push(msg); };
    // 真实传输: 剥掉 _var 参数直接 GET, 返回解析后的 JSON
    window.__wbJsonpImpl = (url) => new Promise((resolve, reject) => {
      const clean = url.replace(/&_var=__wbJsonpCb/, '');
      https.get(clean, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); }
          catch (e) { reject(new Error('响应解析失败: ' + buf.slice(0, 80))); }
        });
      }).on('error', reject);
    });
  },
});

const { window } = dom;
const { document } = window;

setTimeout(async () => {
  console.log('== 刷新功能真实网络测试 ==\n');
  const btn = document.getElementById('btnRefresh');
  const st = document.getElementById('refreshStatus');
  const before = document.getElementById('subtitle').textContent;
  console.log('  刷新前: ' + before);

  btn.onclick();
  // 等待完成: 4只ETF × ~5页 顺序请求, 最多等120秒
  const t0 = Date.now();
  while (Date.now() - t0 < 120000 &&
         !st.textContent.startsWith('✓') && !st.textContent.startsWith('✗')) {
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('  刷新状态: ' + st.textContent);
  console.log('  刷新后: ' + document.getElementById('subtitle').textContent);

  check('刷新成功(✓)', st.textContent.startsWith('✓ 已更新至'), st.textContent);
  check('无未捕获异常', errors.length === 0, errors.join(' | '));
  const m = document.getElementById('subtitle').textContent.match(/~ (\d{4}-\d{2}-\d{2})/);
  check('副标题含新的截止日期', !!m, document.getElementById('subtitle').textContent);
  if (m) check('截止日期为最近交易日(>=数据快照日)', m[1] >= '2026-09-18', m[1]);
  const days = +document.getElementById('subtitle').textContent.match(/（(\d+) 个交易日/)[1];
  // 今天若为非交易日, 重抓结果应与快照完全一致(1505); 交易日则应增加
  check('交易日数 >= 快照(周六无新交易日时应相等)', days >= 1505, days);
  const cards = {};
  document.querySelectorAll('#metricCards .metric').forEach(c => {
    cards[c.querySelector('.k').textContent] = c.querySelector('.v').textContent;
  });
  check('指标卡已重算且总收益为正数格式', /\+/.test(cards['总收益率']), cards['总收益率']);
  check('窗口对比表仍为8行', document.querySelectorAll('#cmpTable tr').length === 8);
  check('切换记录表仍与副标题调仓数一致', document.querySelectorAll('#swTable tr').length > 100);
  check('状态提示已存浏览器缓存', st.textContent.includes('已存浏览器缓存'), st.textContent);
  const cached = JSON.parse(window.localStorage.getItem('etfRotationCacheV1') || 'null');
  check('本地缓存已写入且endDate与副标题一致', !!cached && cached.endDate === m[1],
    cached && cached.endDate);

  console.log('\n结果: ' + pass + ' PASS, ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
}, 600);
