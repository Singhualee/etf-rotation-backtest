// signal.js — ETF 动量轮动 实盘信号计算（每周四定时运行）
// 策略: 25交易日动量最强者全仓持有; 若最强动量 < 0, 全仓转国债ETF 511260避险
// 数据: 腾讯 web.ifzq.gtimg.cn 前复权日线(历史) + qt.gtimg.cn 实时价(当日近似)
// 状态: etf_rotation_state.json 记录策略目标持仓, 变化时输出切换建议
// FORCE=1 环境变量可跳过"当日必须为交易日"检查(测试用)
'use strict';
var fs = require('fs');
var path = require('path');

var ETFS = [
  { symbol: 'sh513100', code: '513100', name: '纳指ETF' },
  { symbol: 'sh511260', code: '511260', name: '十年国债ETF' },
  { symbol: 'sh518850', code: '518850', name: '黄金ETF' },
  { symbol: 'sh510300', code: '510300', name: '沪深300ETF' },
];
var LOOKBACK = 25, BOND = '511260';
var DIR = __dirname;
var STATE_FILE = path.join(DIR, 'etf_rotation_state.json');
var FORCE = process.env.FORCE === '1';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function getText(url, gbk) {
  for (var a = 0; a < 3; a++) {
    try {
      var res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var buf = Buffer.from(await res.arrayBuffer());
      return gbk ? new TextDecoder('gbk').decode(buf) : buf.toString('utf8');
    } catch (e) {
      if (a === 2) throw e;
      await sleep(1500 * (a + 1));
    }
  }
}

// 实时行情(GBK编码, ~分隔)
async function fetchQuotes() {
  var symbols = ETFS.map(function (e) { return e.symbol; }).join(',');
  var txt = await getText('https://qt.gtimg.cn/q=' + symbols, true);
  var out = {};
  ETFS.forEach(function (e) {
    var m = txt.match(new RegExp('v_' + e.symbol + '="([^"]*)"'));
    if (!m) throw new Error('实时行情缺少 ' + e.symbol);
    var f = m[1].split('~');
    out[e.code] = {
      name: f[1],
      price: parseFloat(f[3]),
      time: f[30], // yyyymmddHHMMSS
    };
    if (!(out[e.code].price > 0)) throw new Error(e.code + ' 实时价异常: ' + f[3]);
  });
  return out;
}

// 前复权日线(60根, 用于动量分母)
async function fetchKline(symbol) {
  var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,60,qfq';
  var payload = JSON.parse(await getText(url));
  var body = payload.data && payload.data[symbol];
  var rows = body && (body.qfqday || body.day);
  if (!rows || rows.length < LOOKBACK + 2) throw new Error(symbol + ' 日线数据不足');
  return rows.map(function (r) { return { date: r[0], close: parseFloat(r[2]) }; });
}

function beijingToday() {
  // 本机为 GMT+8, 直接取本地日期
  var d = new Date();
  var p = function (x) { return (x < 10 ? '0' : '') + x; };
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

(async function main() {
  var quotes = await fetchQuotes();
  var quoteDate = quotes[ETFS[0].code].time.slice(0, 8); // 行情日期 yyyymmdd
  var today = beijingToday();

  if (quoteDate !== today && !FORCE) {
    console.log('⏸ 今日休市或行情未更新(最新行情日期 ' + quoteDate + '), 本周无需调仓判断, 跳过。');
    return;
  }
  var dateTag = quoteDate === today ? '今日盘中' : '最近交易日 ' + quoteDate;

  // 各ETF动量: 日线(仅取行情日之前) + 实时价作为"今日价"
  var rows = [];
  for (var i = 0; i < ETFS.length; i++) {
    var e = ETFS[i];
    var ks = await fetchKline(e.symbol);
    var hist = ks.filter(function (k) { return k.date < quoteDate.slice(0, 4) + '-' + quoteDate.slice(4, 6) + '-' + quoteDate.slice(6, 8); });
    var series = hist.map(function (k) { return k.close; });
    series.push(quotes[e.code].price);
    if (series.length < LOOKBACK + 1) throw new Error(e.code + ' 动量数据不足26个交易日');
    var mom = series[series.length - 1] / series[series.length - 1 - LOOKBACK] - 1;
    rows.push({ code: e.code, name: e.name, price: quotes[e.code].price, momentum: mom });
  }

  var best = rows.reduce(function (a, b) { return b.momentum > a.momentum ? b : a; });
  var target = best.momentum < 0 ? BOND : best.code;
  var riskOff = target === BOND && best.code !== BOND;

  // 读取/更新状态
  var state = { target: null, updatedAt: null, history: [] };
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* 首次运行 */ }
  var prevTarget = state.target;
  var changed = prevTarget !== null && prevTarget !== target;

  var lines = [];
  lines.push('📡 ETF 动量轮动信号（' + dateTag + ' ' + quotes[ETFS[0].code].time.slice(8, 10) + ':' + quotes[ETFS[0].code].time.slice(10, 12) + '）');
  lines.push('────────────────────────');
  rows.forEach(function (r) {
    var tag = (r.code === target) ? ' ← 目标持仓' : '';
    var ro = (r.code === BOND && riskOff) ? '（避险触发）' : '';
    lines.push('  ' + r.name + ' ' + r.code + '  现价 ' + r.price.toFixed(3) + '  ' + LOOKBACK + '日动量 ' + (r.momentum * 100).toFixed(2) + '%' + ro + tag);
  });
  lines.push('────────────────────────');
  if (prevTarget === null) {
    lines.push('📌 首次运行, 建立基准目标持仓: ' + target + '（无需交易, 仅供参考）');
  } else if (changed) {
    var prevName = (ETFS.find(function (e) { return e.code === prevTarget; }) || {}).name || prevTarget;
    var newName = (ETFS.find(function (e) { return e.code === target; }) || {}).name || target;
    lines.push('🔄 【切换建议】' + prevName + ' ' + prevTarget + ' → ' + newName + ' ' + target);
    lines.push('   操作: 卖出全部 ' + prevName + ', 买入 ' + newName + '（收盘前完成, 收盘价成交口径）');
  } else {
    lines.push('✅ 目标持仓不变: ' + target + '，无需操作');
  }
  if (quoteDate !== today) lines.push('⚠️ 注意: 测试模式运行, 行情日期 ' + quoteDate + ' 非今日。');
  lines.push('ℹ️ 本信号为盘中近似(以最新价代替收盘价), 尾盘动量排序可能变化; 不构成投资建议。');

  console.log(lines.join('\n'));

  state.target = target;
  state.updatedAt = new Date().toISOString();
  state.history.push({
    date: quoteDate, target: target, changed: changed,
    riskOff: riskOff,
    momenta: rows.reduce(function (o, r) { o[r.code] = +r.momentum.toFixed(6); return o; }, {}),
  });
  if (state.history.length > 200) state.history = state.history.slice(-200);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
})().catch(function (e) {
  console.error('❌ 信号计算失败: ' + e.message);
  process.exit(1);
});
