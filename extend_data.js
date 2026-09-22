// extend_data.js — 抓取长历史替代标的(518880华安黄金/511010五年国债)全量日线,
// 以 ETF_DATA.extended 追加到 data.js, 供 Pro 网站"长历史(2013起)"模式运行时前接拼接。
// 依赖: fetch_full.js 的翻页逻辑(单页640上限)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const NODE = process.execPath;

function fetchFull(code) {
  const out = execFileSync(NODE, [path.join(__dirname, 'fetch_full.js'), code, 'qfq'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

(async () => {
  const gold = fetchFull('sh518880');
  const bond = fetchFull('sh511010');
  const dataPath = path.join(__dirname, 'data.js');
  const src = fs.readFileSync(dataPath, 'utf8');
  eval(src); // 得到 ETF_DATA, 校验当前 4 标的存在
  for (const c of ['518850', '511260', '513100', '510300']) {
    if (!ETF_DATA.etfs.some(e => e.code === c)) throw new Error('data.js 缺少 ' + c);
  }
  // 校验替代序列覆盖原序列起点(能对齐比例)
  for (const [sub, main, name] of [[gold, '518850', '黄金'], [bond, '511260', '国债']]) {
    const e = ETF_DATA.etfs.filter(x => x.code === main)[0];
    const i0 = sub.dates.indexOf(e.dates[0]);
    if (i0 < 0) throw new Error(name + ' 替代序列缺少对齐日 ' + e.dates[0]);
    if (sub.dates[0] >= e.dates[0]) throw new Error(name + ' 替代序列没有更早历史');
  }
  const ext = {
    note: '长历史替代数据源(腾讯qfq全量): gold=518880华安黄金ETF(2013-07上市)替代518850前置, bond=511010五年国债ETF(2013-03上市)替代511260前置; 网站在"长历史"模式下按原序列首日对齐比例后前接, 拼接点数值连续, 拼接前段收益为替代标的自身收益',
    generatedAt: new Date().toISOString().slice(0, 10),
    gold: { code: gold.code, dates: gold.dates, closes: gold.closes },
    bond: { code: bond.code, dates: bond.dates, closes: bond.closes },
  };
  const line = '\nETF_DATA.extended = ' + JSON.stringify(ext) + ';\n';
  // 幂等: 移除旧的 extended 语句再追加
  const cleaned = src.replace(/\nETF_DATA\.extended = .*?;\n?/s, '\n');
  fs.writeFileSync(dataPath, cleaned.replace(/\n*$/, '\n') + line);
  console.log('extended 已写入 data.js: gold ' + gold.dates.length + '天(' + gold.dates[0] + '起), bond ' + bond.dates.length + '天(' + bond.dates[0] + '起)');
})().catch(e => { console.error('FAIL: ' + e.message); process.exit(1); });
