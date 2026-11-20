#!/usr/bin/env node
// Style fingerprint over Nalan's ci corpus: tune usage, diction, imagery, line shape.
// Imitation and attribution work should cite these numbers instead of a vague feel.
//
// The two collected sources segment poems differently, so each gets its own policy:
//   通志堂集 卷六至卷九  - one poem per heading (### 調名, #### 又): mode "heading"
//   納蘭詞全集           - several poems per heading, blank-line separated, and a
//                          双调's two 片 may also sit blank-line apart: mode "chunks"
// Usage: node style_stats.mjs [--top=30] [--tune=浣溪沙] [--src=volumes|collection] [--out=path]

import { readdirSync, writeFileSync } from 'node:fs';
import { RAW, VOLUME_FILES, COLLECTION, clean, han, readRaw, parseUnits, indexPoems } from './ci_parse.mjs';

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const TOP = Number(argv.top) || 30;
const SRC = argv.src === true || argv.src === undefined ? 'volumes' : String(argv.src);


const IMAGERY = {
  天象: ['月', '霜', '雪', '風', '雨', '露', '雲', '星', '煙', '晴', '暝'],
  时序: ['秋', '春', '曉', '暮', '夜', '黃昏', '清明', '重陽', '寒食', '臘', '除夕'],
  居处: ['窗', '屏', '簾', '闌干', '階', '庭', '樓', '閣', '枕', '衾', '燈', '床', '幮'],
  器物: ['琴', '箏', '簫', '釵', '鏡', '香', '爐', '燭', '扇', '觴', '酒', '茶', '箋', '墨', '篝'],
  动植物: ['花', '梅', '柳', '荷', '菊', '雁', '鶯', '燕', '蝶', '梧桐', '芭蕉', '苔', '楊', '萍'],
  行旅: ['驛', '關', '戍', '塞', '程', '鞍', '馬', '渡', '津', '旗', '刁斗', '觱篥', '沙', '河'],
  情态: ['夢', '愁', '淚', '恨', '相思', '消瘦', '憔悴', '斷腸', '淒涼', '惆悵', '无聊', '驚', '怕'],
  佛老: ['禪', '鐘', '磬', '經', '空', '幻', '來生', '前身', '楞伽', '梵', '貝葉'],
};

function signature(text) {
  return text
    .split(' ')
    .filter(Boolean)
    .map((l) => han(l).length)
    .join(',');
}

// Primary source: 词四卷, which carries one poem per heading. The collected edition is
// offered as an alternate but groups several poems under one heading, so its counts differ.
const chosen =
  SRC === 'collection'
    ? { label: '《納蘭詞全集》（按标题分节，一节可含数首，故首数偏低）', files: [COLLECTION] }
    : { label: '《通志堂集》卷六至卷九（词四卷，一首一题）', files: VOLUME_FILES };

let units = [];
for (const f of chosen.files) {
  const t = readRaw(f);
  if (t) units.push(...parseUnits(t, 3));
}

// Independent corroboration: 《飲水詞》 stores every poem as its own page, so those texts
// need no segmentation at all. Matching keys prove the primary segmentation is sound.
const corroborate = SRC === 'collection' ? new Map() : indexPoems();

if (!units.length) {
  const have = readdirSync(RAW).filter((f) => f.endsWith('.md')).slice(0, 6).join(', ');
  console.log(`ERROR: raw/ 中无可解析的词作文本（现有 ${have} …）。先运行 node scripts/fetch_corpus.mjs`);
  process.exit(1);
}
const poems = units.map((u) => u.text);
const allHan = poems.flatMap(han);

function count(items, n) {
  const m = new Map();
  for (const it of items) m.set(it, (m.get(it) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const out = [];
const p = (s) => out.push(s);

p('# 纳兰词风格指纹');
p('');
p(`> 主源：${chosen.label}。`);
p(`> 规模：${units.length} 首 / ${allHan.length} 字 / ${new Set(units.map((u) => u.tune)).size} 个词牌。`);
p('> 改源：`--src=collection`；重建语料：`node scripts/fetch_corpus.mjs`。');
if (corroborate.size) {
  const mine = new Set(units.map((u) => han(u.text).join('')));
  const hit = [...corroborate.keys()].filter((k) => mine.has(k)).length;
  p(`> 并校：《飲水詞》单首页 ${corroborate.size} 首，其中 ${hit} 首与词四卷正文逐字全同；余者按词牌＋首句配对的异文统计见 references/works-index.md（\`node scripts/works_index.mjs\`）。`);
  p('> 结论：本表的分布类数字可信；**逐字征引须以《飲水詞》单首页为主、词四卷为校**，两源不合时存疑并列，不擅定一字。');
}
p('');

p('## 词牌使用频次');
for (const [t, c] of count(units.map((u) => u.tune), TOP)) p(`- ${t}: ${c}`);
p('');

p(`## 高频字（前 ${TOP}）`);
p('- ' + count(allHan, TOP).map(([c, n]) => `${c}${n}`).join('  '));
p('');

p(`## 高频二字组（前 ${TOP}）`);
const bigrams = [];
for (const t of poems) {
  const h = han(t.replace(/ /g, ''));
  for (let i = 0; i < h.length - 1; i++) bigrams.push(h[i] + h[i + 1]);
}
p('- ' + count(bigrams, TOP).map(([w, n]) => `${w}:${n}`).join('  '));
p('');

p('## 意象类目命中');
for (const [cat, words] of Object.entries(IMAGERY)) {
  const hits = words
    .map((w) => [w, poems.reduce((a, t) => a + (t.split(w).length - 1), 0)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = hits.reduce((a, [, n]) => a + n, 0);
  p(`- ${cat}（${total}）: ` + hits.slice(0, 12).map(([w, n]) => `${w}${n}`).join(' '));
}
p('');

p('## 小令与长调');
const small = poems.filter((t) => han(t).length <= 58).length;
p(`- 小令（≤58字）: ${small}；长调（>58字）: ${poems.length - small}（比 ${Math.round((small / poems.length) * 100)}:${100 - Math.round((small / poems.length) * 100)}）`);
p('');

p('## 句式形态（句数／均句长）');
const shapes = new Map();
for (const t of poems) {
  const ls = t.split(' ').filter(Boolean);
  const k = `${ls.length}句／均${Math.round(han(t).length / ls.length)}字`;
  shapes.set(k, (shapes.get(k) || 0) + 1);
}
for (const [k, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) p(`- ${k}: ${n}`);
p('');

if (argv.tune && argv.tune !== true) {
  const want = clean(String(argv.tune));
  const mine = units.filter((u) => u.tune.includes(want));
  p(`## 本调自查：${want}`);
  if (!mine.length) p('- 语料中未见此调（或标题写法不同）。仿作前必须另核词谱，不得凭印象定句读。');
  for (const [sig, n] of count(mine.map((u) => signature(u.text)).filter(Boolean), 8)) p(`- 句长序列 ${sig}: ${n} 首`);
  p('');
  for (const u of mine.slice(0, 10)) p(`- ${u.note ? `〔${u.note}〕` : ''}${u.text}`);
  if (mine.length > 10) p(`- …另有 ${mine.length - 10} 首，grep raw/ 取全`);
  p('');
  p('- 句长序列取自纳兰自制文本，可作仿作句读依据；平仄声律不在本脚本判断范围，须另核词谱。');
}

const text = out.join('\n') + '\n';
if (argv.out && argv.out !== true) {
  writeFileSync(String(argv.out), text, 'utf8');
  console.log(`written: ${argv.out} (${text.length} chars, ${units.length} poems, src=${SRC})`);
} else {
  console.log(text.length > 9000 ? text.slice(0, 9000) + '\n…（截断；用 --out 落盘或 --top 调小）' : text);
}
