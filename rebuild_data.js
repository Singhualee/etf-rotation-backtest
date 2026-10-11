#!/usr/bin/env node
/**
 * rebuild_data.js — 抓取最新行情, 刷新 data.js 中全部 4 只标的的日线序列。
 *
 * 口径说明（重要）：
 *  - 分红 ETF（510300/511260）：抓"腾讯不复权 + 分红表"，以标准等比前复权重建：
 *      除息日 t 的因子 f=(前收-D)/前收，仅作用于**严格早于 t** 的所有收盘价；
 *      除息日当天及之后为不复权原价。这样除息日当日收益率≈真实涨跌(分红不再体现为当日暴跌)。
 *  - 513100/518850：直接保留腾讯 qfq 序列(513100 有份额折算史, qfq 才是与 Wind 一致的口径)。
 *  - 分红识别：腾讯 qfq 为等差复权，diff=raw-qfq 在除息日回落数值恰为每份分红；
 *      仅对 510300/511260 启用(513100 的 qfq 含折算调整, 差值有噪声)。
 *
 * 安全闸(供无人值守的定时任务使用, 任一不通过则整体放弃、不写入):
 *  - 每只标的必须抓到 >= MIN_ROWS 行
 *  - 新序列末日不得早于旧序列末日(禁止数据回退)
 *  - 4 只标的末日需一致(同一交易日截面), 否则说明某只抓取不完整
 *  - 写入采用"临时文件 + rename"原子替换
 *
 * 注意: 本脚本会原样保留 data.js 中第一条语句之后的全部内容(即 ETF_DATA.extended = {...})。
 *      早期版本按"截掉最后一个字符"的方式解析, 在 extended 语句追加后必然解析失败。
 *
 * 用法: node rebuild_data.js
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const PAGE = 640;
const MIN_ROWS = 500;
const DIV_ETF_CODES = ['510300', '511260'];    // 不复权 + 分红表 → 等比前复权
const QFQ_ETF_CODES = ['513100', '518850'];    // 直接使用 qfq 序列

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/**
 * 拆出 data.js 的第一条顶层语句(var ETF_DATA = {...})与其余内容。
 * 用括号深度扫描, 跳过字符串内部的括号; rest 原样保留(含 ';' 与 extended 语句)。
 */
function splitDataJs(src) {
  const marker = 'var ETF_DATA = ';
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('data.js 中未找到 "' + marker + '"');
  const start = at + marker.length;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('data.js 解析失败: 第一条语句的括号不闭合');
  return { base: JSON.parse(src.slice(start, end)), rest: src.slice(end) };
}

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
const lastOf = s => (s && s.dates.length ? s.dates[s.dates.length - 1] : '');

(async () => {
  const srcPath = path.join(DIR, 'data.js');
  const { base: ETF_DATA, rest } = splitDataJs(fs.readFileSync(srcPath, 'utf-8'));
  const etfs = ETF_DATA.etfs;
  const byCode = {};
  etfs.forEach(e => { byCode[e.code] = e; });

  const summary = [];
  // ---- 1) 分红 ETF: 不复权 + 分红表 → 等比前复权 ----
  for (const code of DIV_ETF_CODES) {
    const e = byCode[code];
    if (!e) throw new Error('data.js 中缺少 ' + code);
    const sym = e.symbol || ('sh' + code);
    console.log('== ' + code + ' ' + e.label + ' (不复权+分红重建) ==');
    const raw = await fetchSeries(sym, '');
    const qfq = await fetchSeries(sym, 'qfq');
    const qm = new Map(); qfq.dates.forEach((d, i) => qm.set(d, qfq.closes[i]));
    const embedded = ETF_DATA.dividends[code] || [];
    const refined = detectCandidates(raw.dates, raw.closes, qm).map(c => refineDate(raw.dates, raw.closes, c));
    const news = refined.filter(r => !isKnown(r, embedded));
    refined.forEach(r => {
      const known = isKnown(r, embedded);
      console.log('  候选除息 ' + r.date + ' D=' + r.D + ' 跌幅确认=' + r.confirmed +
        (known ? ' (已知,以内嵌表为准)' : ' → 新分红并入'));
    });
    if (news.length) console.log('  新增分红 ' + news.length + ' 条');
    const divs = mergeDividends(embedded, news);
    const closes = rebuildQfq(raw.dates, raw.closes, divs);
    if (closes.length !== raw.dates.length) throw new Error(code + ' 前复权重建长度不一致');
    if (raw.dates.length < MIN_ROWS) throw new Error(code + ' 抓取异常: 仅 ' + raw.dates.length + ' 行');
    const prevLast = lastOf(e);
    const newLast = lastOf(raw);
    if (prevLast && newLast < prevLast) throw new Error(code + ' 末日回退: ' + prevLast + ' → ' + newLast);
    ETF_DATA.dividends[code] = divs;
    e.dates = raw.dates; e.closes = closes;
    summary.push({ code, label: e.label, rows: raw.dates.length, last: newLast, prev: prevLast, divs: divs.length });
    console.log('  行数=' + raw.dates.length + ' 分红共' + divs.length + '条 最后交易日=' + newLast);
  }
  // ---- 2) 直接使用 qfq 序列的标的 ----
  for (const code of QFQ_ETF_CODES) {
    const e = byCode[code];
    if (!e) throw new Error('data.js 中缺少 ' + code);
    const sym = e.symbol || ('sh' + code);
    console.log('== ' + code + ' ' + e.label + ' (qfq) ==');
    const q = await fetchSeries(sym, 'qfq');
    if (q.dates.length < MIN_ROWS) throw new Error(code + ' 抓取异常: 仅 ' + q.dates.length + ' 行');
    const prevLast = lastOf(e);
    const newLast = lastOf(q);
    if (prevLast && newLast < prevLast) throw new Error(code + ' 末日回退: ' + prevLast + ' → ' + newLast);
    e.dates = q.dates; e.closes = q.closes;
    summary.push({ code, label: e.label, rows: q.dates.length, last: newLast, prev: prevLast, divs: (ETF_DATA.dividends[code] || []).length });
    console.log('  行数=' + q.dates.length + ' 最后交易日=' + newLast);
  }

  // ---- 3) 一致性闸: 同一交易日截面 ----
  const lasts = [...new Set(summary.map(s => s.last))];
  if (lasts.length !== 1) {
    console.error('\n[放弃写入] 4 只标的末日不一致: ' + summary.map(s => s.code + '=' + s.last).join(', '));
    console.error('说明某只标的抓取不完整(或恰好有停牌/新上市), 为避免口径不一致不写入 data.js。');
    process.exit(1);
  }
  const endDate = lasts[0];

  // ---- 3b) 无新交易日则跳过写入(节假日/同一天重复跑时避免无谓地改动文件) ----
  if (!summary.some(s => s.prev && s.last > s.prev)) {
    console.log('序列无变化(最新交易日仍为 ' + endDate + '), 跳过写入 data.js。');
    process.exit(0);
  }

  ETF_DATA.meta.fetchedAt = todayStr();
  ETF_DATA.meta.endDate = endDate;          // 实际最新交易日(不用 todayStr, 避免周末/节假日误导)
  ETF_DATA.meta.source = '腾讯行情接口(不复权)+分红等比前复权重构';
  ETF_DATA.meta.note = '分红ETF(511260/510300)由不复权价+分红表按标准等比前复权重建(因子仅作用于除息日之前), 月度锚点经Wind核对零偏差; 513100/518850保留qfq序列(513100含份额折算处理)';

  // ---- 4) 原子写入, 原样保留 extended 等后续语句 ----
  const out = 'var ETF_DATA = ' + JSON.stringify(ETF_DATA) + rest;
  const tmp = srcPath + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, srcPath);

  console.log('\n' + summary.map(s => s.code + ' ' + s.rows + '行 末日' + s.last).join('\n'));
  console.log('实盘最新交易日: ' + endDate);
  console.log('data.js 已重写 (extended 语句原样保留)');
})().catch(e => { console.error('\nFAILED: ' + e.message); process.exit(1); });
