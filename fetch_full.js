// fetch_full.js — 腾讯接口按结束日期翻页抓取全量日K
// 用法: node fetch_full.js sh518880 qfq
const code = process.argv[2] || 'sh518880';
const fq = process.argv[3] || 'qfq';

async function fetchPage(endDate) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,${endDate || ''},640,${fq}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await res.json();
  if (!j.data || !j.data[code]) throw new Error('bad response: ' + JSON.stringify(j).slice(0, 200));
  const d = j.data[code];
  return d[fq + 'day'] || d.day;
}

(async () => {
  const all = [];   // [{date, close}]
  let end = '';
  for (let page = 0; page < 60; page++) {
    const arr = await fetchPage(end);
    if (!arr || !arr.length) break;
    const rows = arr.map(r => ({ date: r[0], close: +r[2] }));
    all.unshift(...rows);
    const first = rows[0].date;
    console.error(`page ${page}: ${rows.length} rows, ${first} -> ${rows[rows.length - 1].date}`);
    if (all.length > 20000) break;
    // 以本页最早日期的前一天作为下一页结束日
    const d = new Date(first + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    const nextEnd = d.toISOString().slice(0, 10);
    if (nextEnd === end) break;
    end = nextEnd;
    if (rows.length < 640) break; // 已到最早
  }
  // 去重排序
  const seen = {};
  const out = all.filter(r => { if (seen[r.date]) return false; seen[r.date] = 1; return true; })
    .sort((a, b) => a.date < b.date ? -1 : 1);
  console.log(JSON.stringify({ code, fq, count: out.length, start: out[0].date, end: out[out.length - 1].date,
    closes: out.map(r => r.close), dates: out.map(r => r.date) }));
})();
