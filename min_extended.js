// min_extended.js — 用同类长历史ETF(518880黄金/511010五年国债)替代, 把回测窗口从2020-07扩展到2013-08
var fs = require('fs');
eval(fs.readFileSync('engine.js', 'utf8'));
eval(fs.readFileSync('data.js', 'utf8'));

function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
var g880 = load('/tmp/ext_518880.json');
var b010 = load('/tmp/ext_511010.json');

// 与快照同结构
function asEtf(o, label) {
  return { code: String(o.code).replace(/^sh/, ''), label: label, dates: o.dates, closes: o.closes };
}
// 快照内原标的(截至9/18)
function snap(code, label) {
  var e = ETF_DATA.etfs.filter(x => x.code === code)[0];
  return { code: e.code, label: label, dates: e.dates, closes: e.closes };
}

var OPT = { lookback: 25, rebalanceWeekday: 4, costRate: 0.001,
  riskOff: { floor: 0, bondCode: '' }, volTarget: 0.18, volLookback: 20 };

function report(name, etfs, bond) {
  var opt = Object.assign({}, OPT);
  opt.riskOff = { floor: 0, bondCode: bond };
  var bt = RotationEngine.runBacktest(etfs, opt);
  var m = RotationEngine.computeMetrics(bt, { rf: 0.02 });
  console.log('\n== ' + name + ' ==');
  console.log('窗口:', bt.dates[0], '→', bt.dates[bt.dates.length - 1], ' 交易日:', bt.dates.length,
    ' 调仓:', bt.rebalances.length, ' 切换:', bt.switches.filter(s => s.from != null && s.from !== s.to).length);
  console.log('年化=' + (m.annualized * 100).toFixed(2) + '%  最大回撤=' + (m.maxDD * 100).toFixed(2) + '%  夏普=' + m.sharpe.toFixed(3) + '  卡玛=' + (m.annualized / m.maxDD).toFixed(3));
  // 持仓分布
  var cnt = {};
  bt.holding.forEach(function (h) { if (h < 0) return; var c = etfs[h].code; cnt[c] = (cnt[c] || 0) + 1; });
  var holdDays = bt.holding.length;
  console.log('持仓分布: ' + etfs.map(function (e) { return e.label + ' ' + ((cnt[e.code] || 0) / holdDays * 100).toFixed(0) + '%'; }).join('  '));
  // 分年收益
  var years = {};
  for (var i = 1; i < bt.dates.length; i++) {
    var y = bt.dates[i].slice(0, 4);
    if (!years[y]) years[y] = { first: bt.nav[i - 1], last: bt.nav[i] };
    years[y].last = bt.nav[i];
    if (bt.dates[i].slice(0, 4) !== bt.dates[i - 1].slice(0, 4)) years[y].first = bt.nav[i - 1];
  }
  var ys = Object.keys(years).sort();
  var line = [];
  ys.forEach(function (y, idx) {
    var base = idx === 0 ? bt.nav[bt.dates[0].slice(0, 4) === y ? 0 : 0] : years[ys[idx - 1]].last;
    var r = years[y].last / base - 1;
    line.push(y + ':' + (r * 100).toFixed(1) + '%');
  });
  console.log('分年: ' + line.join('  '));
  return { bt: bt, m: m };
}

// --- 基线: 当前4标的(518850/511260), 窗口2020-07~2026-09 ---
var base = report('基线·当前标的(518850黄金/511260十年国债) 波动18%',
  [snap('513100', '纳指'), snap('511260', '十年国债'), snap('518850', '黄金'), snap('510300', '沪深300')], '511260');

// --- 扩展: 替代标的, 起点自动前移到2013-08 ---
var ext = report('扩展·替代标的(518880黄金/511010五年国债) 波动18%',
  [snap('513100', '纳指'), asEtf(b010, '五年国债'), asEtf(g880, '黄金'), snap('510300', '沪深300')], '511010');

// --- 重叠期一致性: 扩展版截取基线窗口(2020-07-10之后)再算指标 ---
var d0 = base.bt.dates[0];
var i0 = ext.bt.dates.findIndex(function (d) { return d >= d0; });
var navT = ext.bt.nav.slice(i0).map(function (v) { return v / ext.bt.nav[i0]; });
function annOf(nav) { var yrs = (nav.length - 1) / 244; return Math.pow(nav[nav.length - 1] / nav[0], 1 / yrs) - 1; }
function mddOf(nav) { var peak = nav[0], dd = 0; for (var i = 1; i < nav.length; i++) { if (nav[i] > peak) peak = nav[i]; dd = Math.min(dd, nav[i] / peak - 1); } return dd; }
console.log('\n== 重叠期(2020-07→2026-09)对照 ==');
console.log('基线(518850/511260): 年化 ' + (base.m.annualized * 100).toFixed(2) + '%  回撤 ' + (base.m.maxDD * 100).toFixed(2) + '%');
console.log('扩展(518880/511010)同窗口: 年化 ' + (annOf(navT) * 100).toFixed(2) + '%  回撤 ' + (mddOf(navT) * 100).toFixed(2) + '%');

// --- 扩展版关波动目标对照 ---
var opt2 = Object.assign({}, OPT); opt2.riskOff = { floor: 0, bondCode: '511010' }; opt2.volTarget = 0;
var bt2 = RotationEngine.runBacktest([snap('513100', '纳指'), asEtf(b010, '五年国债'), asEtf(g880, '黄金'), snap('510300', '沪深300')], opt2);
var m2 = RotationEngine.computeMetrics(bt2, { rf: 0.02 });
console.log('\n扩展版·关波动目标(纯轮动+避险): 年化 ' + (m2.annualized * 100).toFixed(2) + '%  回撤 ' + (m2.maxDD * 100).toFixed(2) + '%  窗口 ' + bt2.dates[0] + '→' + bt2.dates[bt2.dates.length - 1]);
