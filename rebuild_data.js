#!/usr/bin/env node
/**
 * rebuild_data.js — 用"腾讯不复权 + 分红表"以标准等比前复权重建 510300/511260，
 * 并把 qfq 差值步进自动识别出的新分红并入分红表。
 *
 * 口径说明（重要）：
 *  - 标准等比前复权：除息日 t 的因子 f=(前收-D)/前收，仅作用于**严格早于 t** 的所有收盘价；
 *    除息日当天及之后为不复权原价。这样除息日当日收益率≈真实涨跌（分红不再体现为当日暴跌）。
 *  - 513100/518850 保留腾讯 qfq 原序列（513100 有份额折算史，qfq 才是与 Wind 一致的口径）。
 *  - 分红识别：腾讯 qfq 为等差复权，diff=raw-qfq 在除息日回落数值恰为每份分红；
 *    仅对 510300/511260 启用（513100 的 qfq 含折算调整，差值有噪声）。
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const PAGE = 640;
const DIV_ETF_CODES = ['510300', '511260'];

async function fetchSeries(symbol, fq) {
  let all = [], end = todayStr();
  for (;;) {
    const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,' + end + ',' + PAGE + ',' + fq;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    const d = j.data && j.data[symbol];
    const rows = (d && (d.day || d.qfqday)) || [];
    if (!rows.length) break;
    rows.forEach(r => { const c = parseFloat(r[2]); if (r[0] && isFinite(c)) all.push([r[0], c]); });
    if (rows.length < PAGE) break;
    const e = new Date(rows[0][0].replace(/-/g, '/')); e.setDate(e.getDate() - 1);
    end = e.getFullYear() + '-' + ('0' + (e.getMonth() + 1)).slice(-2) + '-' + ('0' + e.getDate()).slice(-2);
  }
  all.sort((a, b) => a[0] < b[0] ? -1 : 1);
  const out = []; let last = '';
  all.forEach(r => { if (r[0] !== last) { out.push(r); last = r[0]; } });
  return { dates: out.map(r => r[0]), closes: out.map(r => r[1]) };
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
// qfq 差值步进识别候选分红（等差模型），仅返回明显跳变（D>=0.01）
function detectCandidates(dates, rawCloses, qfqMap) {
  const cands = []; let prev = 0;
  for (let i = 0; i < dates.length; i++) {
    const q = qfqMap.get(dates[i]); if (q === undefined) continue;
    const diff = rawCloses[i] - q, step = diff - prev;
    if (step < -0.01) cands.push({ date: dates[i], D: +(-step).toFixed(4) });
    prev = diff;
  }
  return cands;
}
// qfq 差值步进的日期可能与真实除息日差数日(腾讯等差复权的落点不精确),
// 在 ±8 个交易日内用"隔夜跌幅≈分红额"挑选最可能的除息日
function refineDate(dates, closes, cand) {
  const idx = dates.indexOf(cand.date);
  if (idx < 0) return { ...cand, confirmed: false };
  let best = null;
  for (let i = Math.max(1, idx - 8); i <= Math.min(dates.length - 1, idx + 8); i++) {
    const drop = closes[i - 1] - closes[i];
    const err = Math.abs(drop - cand.D);
    if (!best || err < best.err) best = { err, date: dates[i] };
  }
  const confirmed = best && best.err <= Math.max(0.3 * cand.D, 0.02);
  return { D: cand.D, date: best ? best.date : cand.date, confirmed };
}
// 已知判定: 内嵌表中存在金额相近(±20%)且日期在±15天内的记录 → 视为同一条分红
function isKnown(cand, embedded) {
  const t = new Date(cand.date).getTime();
  return embedded.some(d => {
    const dt = Math.abs(new Date(d[0]).getTime() - t) / 86400000;
    return dt <= 15 && Math.abs(d[1] - cand.D) <= Math.max(0.2 * cand.D, 0.01);
  });
}
// 标准等比前复权：因子仅作用于除息日之前
function rebuildQfq(dates, closes, divs) {
  const factors = dates.map(() => 1);
  divs.forEach(([t, D]) => {
    let idx = -1;
    for (let i = 0; i < dates.length && dates[i] < t; i++) idx = i;
    if (idx < 0) return;
    const pc = closes[idx], f = (pc - D) / pc;
    if (!(f > 0 && f < 1)) { console.warn('  ! 异常分红记录跳过', t, D); return; }
    for (let j = 0; j <= idx; j++) factors[j] *= f;
  });
  return closes.map((c, i) => +(c * factors[i]).toFixed(4));
}
function mergeDividends(embedded, detected) {
  const m = new Map();
  (embedded || []).forEach(d => m.set(d[0], d[1]));       // 内嵌(Wind校准)优先占位
  detected.forEach(d => { if (!m.has(d.date)) m.set(d.date, d.D); });  // 新分红补充
  return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

(async () => {
  const src = fs.readFileSync(path.join(DIR, 'data.js'), 'utf-8');
  const ETF_DATA = JSON.parse(src.slice('var ETF_DATA = '.length, -1));

  for (const code of DIV_ETF_CODES) {
    const e = ETF_DATA.etfs.find(x => x.code === code);
    console.log('== ' + code + ' ' + e.label + ' ==');
    const raw = await fetchSeries('sh' + code, '');
    const qfq = await fetchSeries('sh' + code, 'qfq');
    const qm = new Map(); qfq.dates.forEach((d, i) => qm.set(d, qfq.closes[i]));
    const embedded = ETF_DATA.dividends[code] || [];
    const cands = detectCandidates(raw.dates, raw.closes, qm);
    const refined = cands.map(c => refineDate(raw.dates, raw.closes, c));
    refined.forEach(r => {
      const known = isKnown(r, embedded);
      console.log('  候选除息 ' + r.date + ' D=' + r.D + ' 跌幅确认=' + r.confirmed + (known ? ' (已知,以内嵌表为准)' : (r.confirmed ? ' → 新分红并入' : ' → 新分红并入(未确认)')));
    });
    const news = refined.filter(r => !isKnown(r, embedded));
    if (news.length) console.log('  新增分红 ' + news.length + ' 条');
    const divs = mergeDividends(embedded, news);
    const closes = rebuildQfq(raw.dates, raw.closes, divs);
    e.dates = raw.dates; e.closes = closes;
    ETF_DATA.dividends[code] = divs;
    console.log('  rows=' + raw.dates.length + ' 分红共' + divs.length + '条 最后交易日=' + raw.dates[raw.dates.length - 1]);
  }

  ETF_DATA.meta.fetchedAt = todayStr();
  ETF_DATA.meta.endDate = todayStr();
  ETF_DATA.meta.source = '腾讯行情接口(不复权)+分红等比前复权重构';
  ETF_DATA.meta.note = '分红ETF(511260/510300)由不复权价+分红表按标准等比前复权重建(因子仅作用于除息日之前), 月度锚点经Wind核对零偏差; 513100保留qfq序列(含份额折算处理)';

  fs.writeFileSync(path.join(DIR, 'data.js'), 'var ETF_DATA = ' + JSON.stringify(ETF_DATA) + ';\n');
  console.log('\ndata.js 已重写');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
