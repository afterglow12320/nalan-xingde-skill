#!/usr/bin/env node
// Machine-complete index of Nalan's ci: one row per poem, keyed by 词牌＋首句, showing
// which volume it sits in, which per-poem page to quote from, and how the two sources collate.
// Usage: node works_index.mjs [--out=references/works-index.md]

import { writeFileSync } from 'node:fs';
import { han, readRaw, volumeUnits, indexPoems, COLLECTION } from './ci_parse.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

// Poem body of a per-poem page: everything except the fetched-header block.
function pageChars(file) {
  return han(
    (readRaw(file) || '')
      .split('\n')
      .filter((l) => !/^\s*(<!--|#|>|$)/.test(l))
      .join('')
  ).join('');
}

function diff(a, b) {
  if (a.length !== b.length) return `字数${a.length}/${b.length}`;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n ? `异文${n}字` : '全文同';
}

const volumes = volumeUnits();
const pages = indexPoems();
const pageList = [...pages.values()];
const collectionText = (readRaw(COLLECTION) || '').replace(/\s+/g, '');
const matched = new Set();
const rows = [];

// 首句 equality fails on single-character variants (祇／只, 涼／凉), so allow a short
// common opening or two mismatched positions within otherwise equal-length lines.
function sameFirst(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  if (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))) return true;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d <= 2;
}

for (const u of volumes) {
  const chars = han(u.text).join('');
  const exact = pages.get(chars);
  const byKey = pageList.find((x) => !matched.has(x.file) && x.tune === u.tune && sameFirst(x.first, u.first));
  const page = exact && !matched.has(exact.file) ? exact : byKey;
  if (page) matched.add(page.file);
  rows.push({
    tune: u.tune,
    first: u.first,
    note: u.note,
    volume: u.volume,
    page: page ? page.file : '',
    coll: page ? diff(chars, pageChars(page.file)) : '仅四卷',
    inColl: u.first && collectionText.includes(u.first) ? '✓' : '—',
  });
}
for (const pg of pageList) {
  if (matched.has(pg.file)) continue;
  const chars = pageChars(pg.file);
  rows.push({
    tune: pg.tune,
    first: pg.first || chars.slice(0, 7),
    note: '',
    volume: '',
    page: pg.file,
    coll: '仅单页',
    inColl: pg.first && collectionText.includes(pg.first) ? '✓' : '—',
  });
}

const freq = new Map();
for (const r of rows) freq.set(r.tune, (freq.get(r.tune) || 0) + 1);
rows.sort(
  (a, b) =>
    freq.get(b.tune) - freq.get(a.tune) ||
    (b.volume || '').localeCompare(a.volume || '') ||
    (a.first || '').localeCompare(b.first || '')
);

const n = (f) => rows.filter(f).length;
const tally = {
  条: rows.length,
  调: freq.size,
  同: n((r) => r.coll === '全文同'),
  异: n((r) => /异文|字数/.test(r.coll)),
  仅四卷: n((r) => r.coll === '仅四卷'),
  仅单页: n((r) => r.coll === '仅单页'),
};

const out = [];
const p = (s) => out.push(s);
p('# 纳兰词作品索引');
p('');
p('> 自动生成：`node scripts/works_index.mjs --out=references/works-index.md`，请勿手改。');
p(`> 口径：匹配键＝词牌＋首句（去标点）。《通志堂集》词四卷 ${volumes.length} 首、《飲水詞》单首页 ${pages.size} 首，合并 ${tally.条} 条 / ${tally.调} 调。`);
p(`> 并校：全文逐字同 ${tally.同} 条；字级有异 ${tally.异} 条（异文取舍或校对页讹字，如「故人心／故心人」「雨霖鈴／雨零鈴」）；仅见词四卷 ${tally.仅四卷} 条；仅见单首页 ${tally.仅单页} 条。`);
p('> 「字数a/b」两条不等长者，多因词四卷一则标题收数首或分片写法不同，须回读原页再定，不得径取一体。');
p('> 用法：评点或仿作前先在此定位同调之作；**逐字征引取「单页」列的文件**，「校」列示「异文／字数不合」者须与词四卷并列存疑，不可擅定一字。');
p('> 「全集」列仅表示该首句在《納蘭詞全集》一页内出现（子串核对），不作版本源流判断；用字小异（祇／只一类）会误标「—」，未见「✓」时以 grep 原页为准。');
p('');
p('| 词牌 | 首句 | 题注 | 卷 | 单页 | 校 | 全集 |');
p('| --- | --- | --- | --- | --- | --- | :-: |');
for (const r of rows) p(`| ${r.tune} | ${r.first} | ${r.note} | ${r.volume} | ${r.page ? `raw/${r.page}` : ''} | ${r.coll} | ${r.inColl} |`);

const text = out.join('\n') + '\n';
if (argv.out && argv.out !== true) {
  writeFileSync(String(argv.out), text, 'utf8');
  console.log(`written: ${argv.out} (${tally.条} rows, ${tally.调} tunes; 同${tally.同}/异${tally.异}/仅四卷${tally.仅四卷}/仅单页${tally.仅单页})`);
} else {
  console.log(text.length > 9000 ? text.slice(0, 9000) + '\n…（截断；用 --out 落盘）' : text);
}
