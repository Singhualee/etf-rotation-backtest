// gen_report.js — 生成调仓日对比 HTML 报告 (weekday_comparison.html)
module.exports = function (report, dir) {
  var fs = require('fs');
  var path = require('path');
  var pct = function (x, d) { return x === null ? '—' : (x * 100).toFixed(d === undefined ? 2 : d) + '%'; };
  var bestC = report.bestByCalmar, bestA = report.bestByAnnual;

  // 汇总表(按卡玛降序)
  var sorted = report.summary.slice().sort(function (a, b) { return b.calmar - a.calmar; });
  var rowsHtml = sorted.map(function (s) {
    var isBest = (s.calmar === sorted[0].calmar);
    return '<tr class="' + (isBest ? 'best' : '') + '">' +
      '<td>' + s.name + '</td>' +
      '<td class="' + (s.total >= 0 ? 'up' : 'down') + '">' + pct(s.total) + '</td>' +
      '<td class="' + (s.annualized >= 0 ? 'up' : 'down') + '">' + pct(s.annualized) + '</td>' +
      '<td>' + s.sharpe.toFixed(3) + '</td>' +
      '<td class="down">' + pct(-s.maxDD) + '</td>' +
      '<td><b>' + s.calmar.toFixed(3) + '</b></td>' +
      '<td>' + pct(s.weeklyWinRate, 1) + '</td>' +
      '<td>' + s.switches + '</td>' +
      '<td>' + s.tradingDays + '</td></tr>';
  }).join('\n');

  // 分年度年化收益表
  var yearHead = report.years.map(function (y) { return '<th>' + y + '</th>'; }).join('');
  var yearRows = report.yearly.map(function (v) {
    var tds = v.rows.map(function (r) {
      var isBestYear = (r.rankA === 1);
      return '<td class="' + (r.annualized >= 0 ? 'up' : 'down') + (isBestYear ? ' bestcell' : '') + '">' +
        pct(r.annualized) + (isBestYear ? ' ★' : '') + '</td>';
    }).join('');
    return '<tr><td>' + v.name + '</td>' + tds + '<td><b>' + (v.rows.filter(function (r) { return r.rankA === 1; }).length) + '</b></td></tr>';
  }).join('\n');

  // 分年度卡玛表
  var calmarRows = report.yearly.map(function (v) {
    var tds = v.rows.map(function (r) {
      var isBestYear = (r.rankC === 1);
      return '<td class="' + (isBestYear ? ' bestcell' : '') + '">' +
        (r.calmar === null ? '—' : r.calmar.toFixed(2)) + (isBestYear ? ' ★' : '') + '</td>';
    }).join('');
    return '<tr><td>' + v.name + '</td>' + tds + '<td><b>' + (v.rows.filter(function (r) { return r.rankC === 1; }).length) + '</b></td></tr>';
  }).join('\n');

  var html = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>ETF 动量轮动 · 调仓日对比分析</title>\n' +
    '<script src="echarts.min.js"><\/script>\n' +
    '<style>\n' +
    'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f7f8fa;color:#1f2329;}\n' +
    '.wrap{max-width:1080px;margin:0 auto;padding:32px 24px 64px;}\n' +
    'h1{font-size:26px;margin:0 0 4px;} h2{font-size:19px;margin:36px 0 12px;border-left:4px solid #2f6fed;padding-left:10px;}\n' +
    '.sub{color:#6b7280;font-size:13px;margin-bottom:8px;}\n' +
    '.conclusion{background:#eef4ff;border:1px solid #c9dcff;border-radius:10px;padding:16px 20px;margin:16px 0 4px;line-height:1.9;font-size:14.5px;}\n' +
    'table{border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;font-size:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);}\n' +
    'th,td{padding:9px 12px;text-align:right;border-bottom:1px solid #eef0f3;} th:first-child,td:first-child{text-align:left;}\n' +
    'th{background:#f2f4f7;font-weight:600;white-space:nowrap;}\n' +
    'tr.best td{background:#fffbe6;} .bestcell{background:#fffbe6;font-weight:600;}\n' +
    '.up{color:#d5304f;} .down{color:#0a9d62;}\n' +
    '.chart{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px;margin-top:12px;}\n' +
    '.note{color:#6b7280;font-size:12.5px;line-height:1.8;margin-top:10px;}\n' +
    '</style>\n</head>\n<body>\n<div class="wrap">\n' +
    '<h1>ETF 动量轮动 · 调仓日对比分析</h1>' +
    '<div class="sub">策略：每周调仓一次，比较 20 个交易日动量，全仓持有最强 ETF（无手续费/滑点，信号与成交同用当日收盘价）｜' +
    '对比窗口（五条净值已对齐至共同起点）：<b>' + report.commonStart + ' ~ ' + report.commonEnd + '</b>｜无风险利率 ' + (report.rf * 100).toFixed(0) + '%</div>' +

    '<h2>一、总体对比（按卡玛比率降序）</h2>' +
    '<table><thead><tr><th>调仓日</th><th>总收益</th><th>年化收益</th><th>夏普</th><th>最大回撤</th><th>卡玛比率</th><th>周度胜率</th><th>切换次数</th><th>交易日</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>' +
    '<div class="conclusion">📌 <b>按卡玛比率最优：<b style="color:#d5304f">' + bestC + '</b>　按年化收益最优：<b style="color:#d5304f">' + bestA + '</b></b></div>' +

    '<h2>二、分年度年化收益（★ = 当年最优调仓日）</h2>' +
    '<table><thead><tr><th>调仓日</th>' + yearHead + '<th>当年第一次数</th></tr></thead><tbody>' + yearRows + '</tbody></table>' +

    '<h2>三、分年度卡玛比率（★ = 当年最优调仓日）</h2>' +
    '<table><thead><tr><th>调仓日</th>' + yearHead + '<th>当年第一次数</th></tr></thead><tbody>' + calmarRows + '</tbody></table>' +
    '<div class="note">⚠️ 稳健性提示：五个调仓日来自同一份数据的样本内比较，"最优日"可能只是恰好契合某段行情。上表用于检查结论是否跨年度稳定——若某调仓日仅在个别年份领先，需警惕过拟合，不宜直接据此切换实盘规则。</div>' +

    '<h2>四、对齐后净值曲线（起点 = 1）</h2>' +
    '<div class="chart"><div id="navChart" style="height:420px;"></div></div>' +

    '<h2>五、年化收益与卡玛对比</h2>' +
    '<div class="chart"><div id="barChart" style="height:360px;"></div></div>' +

    '<h2>六、口径说明</h2>' +
    '<div class="note">' +
    '· 调仓日规则：每周取指定的星期 X；X 当日休市则顺延至当周下一个交易日，若当周 X 之后已无交易日则提前至当周最后一个交易日（每周恰好调仓一次）。<br>' +
    '· 信号与成交：调仓日收盘价计算 20 个交易日动量（各 ETF 用自身交易日序列）并以同价成交，无前视偏差；最大动量不严格大于当前持仓时保持原仓。<br>' +
    '· 公平对齐：五种调仓日的首次建仓日相差 1~4 个交易日，全部指标均在共同窗口 <b>' + report.commonStart + ' ~ ' + report.commonEnd + '</b> 内以对齐净值重算。<br>' +
    '· 卡玛比率 = 年化收益 ÷ 最大回撤；夏普 = (日均收益 − 日无风险利率) ÷ 日波动率标准差 × √252。<br>' +
    '· 数据：四只 ETF（513100 纳指 / 511260 十年国债 / 518850 黄金 / 510300 沪深300）前复权日线快照，与主回测网站同源。</div>' +

    '</div>\n<script>\n' +
    'var R = ' + JSON.stringify(report) + ';\n' +
    'var chart = echarts.init(document.getElementById("navChart"));\n' +
    'var series = R.navSeries.map(function(s, i) {\n' +
    '  var colors = ["#2f6fed","#d5304f","#e6a23c","#0a9d62","#9254de"];\n' +
    '  return { name: s.name, type: "line", data: s.nav, showSymbol: false, lineStyle: { width: 1.6, color: colors[i] }, itemStyle: { color: colors[i] } };\n' +
    '});\n' +
    'chart.setOption({ tooltip: { trigger: "axis" }, legend: { top: 4 },\n' +
    '  grid: { left: 60, right: 24, top: 40, bottom: 40 },\n' +
    '  xAxis: { type: "category", data: R.navSeries[0].dates },\n' +
    '  yAxis: { type: "value", scale: true }, series: series });\n' +
    'var bar = echarts.init(document.getElementById("barChart"));\n' +
    'var names = R.summary.map(function(s){return s.name;});\n' +
    'bar.setOption({ tooltip: {}, legend: { top: 4 },\n' +
    '  grid: { left: 60, right: 24, top: 40, bottom: 40 },\n' +
    '  xAxis: { type: "category", data: names },\n' +
    '  yAxis: [ { type: "value", name: "年化 %", axisLabel:{formatter:"{value}%"} }, { type: "value", name: "卡玛" } ],\n' +
    '  series: [\n' +
    '    { name: "年化收益", type: "bar", data: R.summary.map(function(s){return +(s.annualized*100).toFixed(2);}), itemStyle:{color:"#2f6fed"} },\n' +
    '    { name: "卡玛比率", type: "bar", yAxisIndex: 1, data: R.summary.map(function(s){return +s.calmar.toFixed(3);}), itemStyle:{color:"#e6a23c"} }\n' +
    '  ] });\n' +
    'window.addEventListener("resize", function(){ chart.resize(); bar.resize(); });\n' +
    '<\/script>\n</body>\n</html>\n';

  fs.writeFileSync(path.join(dir, 'weekday_comparison.html'), html);
  console.log('报告已生成: weekday_comparison.html');
};
