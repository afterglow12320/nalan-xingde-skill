#!/usr/bin/env node
// Fetch Nalan Xingde primary texts from zh.wikisource into raw/ as markdown.
// Usage: node fetch_corpus.mjs [--targets=ci,ciIndex,prose,essays,criticism] [--only=页名] [--limit=N] [--dry-run]
// Omit --targets to fetch all five groups. There is no "all" keyword: --targets=all queues 0 pages.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw');
const API = 'https://zh.wikisource.org/w/index.php';
const UA = 'nalan-xingde-skill-corpus/1.0 (scholarly text collection; single run)';
const THROTTLE_MS = 250;
// The large collected-edition page can take ~25s server-side; short timeouts churn.
const RETRIES = 4;
const TIMEOUT_MS = 60000;

const TARGETS = {
  ci: [{ title: '納蘭詞全集', kind: 'ci', note: '词作全集，五卷内联正文' }],
  ciIndex: [{ title: '飲水詞', kind: 'ci-index', note: '饮水词目录页，每首为独立子页（词牌＋首句题名）' }],
  prose: Array.from({ length: 21 }, (_, i) => ({
    title: `通志堂集/${String(i).padStart(2, '0')}`,
    kind: i === 0 ? 'prose-index' : 'prose',
    note: '通志堂集序卷及各卷（赋、诗、词、经解序跋、杂文、渌水亭杂识）',
  })),
  essays: [
    { title: '通志堂集序', kind: 'essay', note: '徐乾学序，一手生平史料' },
    { title: '成容若遺稿序', kind: 'essay', note: '严绳孙序，一手生平史料' },
    { title: '皇清通議大夫一等侍衛佐領納蘭君墓志銘', kind: 'epitaph', note: '徐乾学撰墓志铭' },
    { title: '納蘭家族墓碑銘文', kind: 'epitaph-index', note: '叶赫那拉家族碑铭汇编页' },
  ],
  // 接受史：词话原文，供 references/reception.md 逐条核对引文，禁止凭记忆征引。
  criticism: [
    { title: '人間詞話', kind: 'criticism', note: '王国维词话（另有 人間詞話 (1926) 本）' },
    { title: '蕙風詞話', kind: 'criticism', note: '况周颐词话' },
    { title: '白雨齋詞話', kind: 'criticism', sub: true, note: '陈廷焯词话（正文分散在 /0 … /8 子页）' },
    { title: '彈指詞', kind: 'criticism', note: '顾贞观词，交游与唱和语境' },
    { title: '詞論 (張惠言)', kind: 'criticism', note: '张惠言词论，常州派视角' },
    { title: '清史稿/卷484', kind: 'history', note: '清史稿文苑传候选卷' },
    { title: '清史稿/卷298', kind: 'history', note: '清史稿列传候选卷' },
  ],
};

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const targetsArg = args.targets === undefined ? 'ci,ciIndex,prose,essays,criticism' : args.targets;
const which = (targetsArg === true ? 'ci,ciIndex,prose,essays,criticism' : targetsArg).split(',');
const limit = args.limit === true ? undefined : Number(args.limit);
const dryRun = Boolean(args['dry-run']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractHeader(src) {
  const m = src.match(/\{\{\s*[Hh]eader\b([\s\S]*?)\}\}/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/\|\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/);
    if (kv && kv[2]) out[kv[1].toLowerCase()] = kv[2].replace(/<!--[\s\S]*?-->/g, '').trim();
  }
  return out;
}

function normalize(src, pageTitle) {
  const meta = extractHeader(src);
  const notes = { variants: 0 };
  let t = src;
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/\[\[:?\s*(?:Category|分類)[^\]]*\]\]/gi, '');
  // Variant readings {{另|淚|夜}} / {{作|X|Y}} / {{另2|徹夜寒于水|一作「…」}}: keep the primary
  // character, never the whole template, or body text silently loses characters.
  t = t.replace(/\{\{\s*(?:另|作|校|異|校注)\d*\s*\|\s*([^{|}]+?)(?:\|[^{}]*?)?\}\}/g, (_m, a) => {
    notes.variants++;
    return a.trim();
  });
  t = t.replace(/\{\{\s*ruby\s*\|\s*([^}|]+?)(?:\|[^}]*)?\}\}/g, (_m, a) => a.trim());
  // Language-conversion markup -{X}- / -{zh-hans:A|zh-hant:B}- keeps one reading.
  for (let pass = 0; pass < 3; pass++) {
    const next = t.replace(/-\{([^{}]*)\}-/g, (_m, body) => {
      const first = body.split('|')[0];
      return first.includes(':') ? first.split(':').slice(1).join(':') : first;
    });
    if (next === t) break;
    t = next;
  }
  // Named wrappers carry their payload; dropping the whole template eats body characters
  // (e.g. {{ProperNoun|開元}}, {{WavyBookMark|詞韻正略}} = 《名詞韻正略》 in the epitaph,
  // {{-|…}} for 人間詞話 annotations).
  // Book-title wrappers ({{WavyBookMark|詞韻正略}}) stand for the 书名号 the scan page omits.
  t = t.replace(/\{\{\s*(?:WavyBookMark|BookMark|BookTitle)\s*\|\s*([\s\S]*?)\s*\}\}/g, '《$1》');
  t = t.replace(/\{\{\s*(?:ProperNoun|Lang|ruby|Ruby|key|K|NoteTag|tag|注|-)\s*\|\s*([\s\S]*?)\s*\}\}/g, '$1');
  // Wiki list markers must go before headings are generated, or the "##" output is eaten.
  t = t.replace(/^[:#*]{1,3}(.*)$/gm, '$1');
  t = t.replace(/__TOC__|__NOTOC__/g, '');
  // Subtitle template {{*|(秋夕信步)}} keeps its payload.
  t = t.replace(/\{\{\s*[\*-]\w*\s*\|([^}]*)\}\}/gi, '$1');
  // Transclusion {{:Page|args}} -> marker that survives the generic template strip below.
  t = t.replace(/\{\{\s*:([^}|]+?)(?:\|[^}]*)?\}\}/g, (_m, p) => `@@INC:${p.trim()}@@`);
  // Drop all remaining templates (header blocks, quality tags, category tags).
  for (let pass = 0; pass < 6; pass++) {
    const next = t.replace(/\{\{[^{}]*\}\}/g, '');
    if (next === t) break;
    t = next;
  }
  // Scan-page typos leave variant templates unclosed (通志堂集/08「宿灑全{{另|醒，…{{另|庭梧|梧桐}}葉」).
  // Strip only the markup token then, so the running text survives; count it for the page header.
  t = t.replace(/\{\{\s*(?:另|作|校|異|校注)\d*\s*\|?/g, () => {
    notes.unterminated = (notes.unterminated || 0) + 1;
    return '';
  });
  t = t.replace(/\}\}/g, '');
  t = t.replace(/<\/?poem>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/?(onlyinclude|includeonly|noinclude)>/gi, '');
  // Preserve depth: wikitext == h2 -> ##, === h3 -> ###, so downstream can tell
  // volume headings apart from tune headings.
  t = t.replace(/^(={2,6})\s*(.+?)\s*\1\s*$/gm, (_m, eq, h) => `\n${'#'.repeat(eq.length)} ${h.trim()}\n`);
  // Index pages point at their children with relative links (白雨齋詞話: [[/0|敘]]).
  // Resolve them against the page title before the targets are stripped below.
  if (pageTitle) {
    t = t.replace(/\[\[\s*(\/[^\]|]+?)\s*(?:\|([^\]]+))?\s*\]\]/g, (_m, rel, disp) =>
      `@@INC:${pageTitle}${rel}@@ ${disp || rel.slice(1)}`
    );
  }
  t = t.replace(/\[\[[^[\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
  t = t.replace(/'{2,5}/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { text: t.trim(), meta, notes };
}

function slug(title) {
  return title.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

function transcludes(text) {
  return [...text.matchAll(/@@INC:([^@\n]+)@@/g)].map((m) => m[1].trim());
}

async function fetchRaw(title) {
  const url = `${API}?title=${encodeURIComponent(title)}&action=raw`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return { ok: false, reason: 'not-found' };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      // Wikisource serves an HTML error page for some raw requests.
      if (body.startsWith('<!DOCTYPE')) return { ok: false, reason: 'html-error-page' };
      return { ok: true, body };
    } catch (e) {
      lastErr = e;
      await sleep(600 * (attempt + 1));
    }
  }
  // undici intermittently hits UND_ERR_CONNECT_TIMEOUT on the large collected-edition
  // page where curl succeeds, so curl is the last-resort transport.
  try {
    const { stdout } = await run('curl', ['-sL', '--max-time', '90', '-A', UA, url]);
    if (stdout && stdout.length > 20 && !stdout.startsWith('<!DOCTYPE')) return { ok: true, body: stdout };
  } catch {
    /* curl unavailable */
  }
  const why = lastErr?.cause?.code || lastErr?.cause?.message || lastErr?.message || 'unknown';
  return { ok: false, reason: `${why} (fetch+curl both failed)` };
}

const seen = new Map(); // title -> {file, ok}
const queue = [];

// Some works are split as subpages linked by ordinary wikilinks (白雨齋詞話/0 …),
// which transclusion expansion cannot see; allpages by prefix picks them up.
async function subpagesOf(title) {
  const u = `https://zh.wikisource.org/w/api.php?action=query&list=allpages&apprefix=${encodeURIComponent(
    `${title}/`
  )}&apnamespace=0&aplimit=200&format=json&formatversion=2`;
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.query?.allpages || []).map((x) => x.title);
  } catch {
    return [];
  }
}

// An unknown group name would silently queue zero pages (--targets=all was once recommended in docs).
if (!args.only) {
  const unknown = which.filter((k) => !TARGETS[k]);
  if (unknown.length) {
    console.log(`ERROR: 未知 --targets=${unknown.join(',')}；合法值：${Object.keys(TARGETS).join(',')}（省略 --targets 即五组全取）`);
    process.exit(1);
  }
}

for (const k of which) {
  for (const t of TARGETS[k] || []) {
    queue.push({ ...t, depth: 0 });
    if (t.sub) for (const sp of await subpagesOf(t.title)) queue.push({ ...t, title: sp, sub: false, depth: 0 });
  }
}

// Repair run: refetch named pages only, e.g. after a normalizer fix.
if (args.only && args.only !== true) {
  queue.length = 0;
  for (const t of String(args.only).split(',')) queue.push({ title: t.trim(), kind: 'only', note: '定向重取', depth: 0 });
}

if (dryRun) {
  console.log(`Planned seeds: ${queue.length} pages (${which.join(',')})`);
  process.exit(0);
}


await mkdir(RAW, { recursive: true });

const started = Date.now();
let ok = 0;
const failures = [];

async function harvest(item) {
  const key = item.title;
  if (seen.has(key)) return;
  if (limit && seen.size >= limit) return;
  const { ok: good, body, reason } = await fetchRaw(key);
  seen.set(key, { file: null, ok: good, reason });
  if (!good) {
    failures.push(`${key}: ${reason}`);
    await sleep(THROTTLE_MS);
    return;
  }
  const { text: inner, meta, notes } = normalize(body, item.title);
  const kids = transcludes(inner).filter((t) => t && !t.includes('#'));
  const file = `${slug(key)}.md`;
  const head = [
    `<!-- source: ${API}?title=${encodeURIComponent(key)}&action=raw -->`,
    `<!-- fetched: ${new Date().toISOString()} -->`,
    `# ${key}`,
    meta.title && meta.title !== key ? `> 题: ${meta.title}` : '',
    meta.from ? `> 出处卷: ${meta.from}` : '',
    notes.variants ? `> 异文 ${notes.variants} 处，正文取主读` : '',
    notes.unterminated ? `> 源页 ${notes.unterminated} 处异文模板未闭合，已去标记、存正文` : '',
    item.note ? `> ${item.note}` : '',
    kids.length ? `> 本页为目录页，正文见 ${kids.length} 个子页` : '',
  ].filter(Boolean).join('\n') + '\n\n';
  // Leaf pages carry text; index pages keep the child list so expansion is auditable.
  const textPart = inner || kids.map((t) => `- ${t}`).join('\n');
  await writeFile(join(RAW, file), head + textPart + '\n');
  seen.set(key, { file, ok: true });
  ok++;
  if (item.depth < 2) {
    for (const t of kids) queue.push({ title: t, kind: 'child', note: item.title, depth: item.depth + 1 });
  }
  await sleep(THROTTLE_MS);
}

for (let i = 0; i < queue.length; i++) await harvest(queue[i]);

// A partial re-run must not erase records of pages fetched in earlier runs.
let prior = { pages: {} };
try {
  prior = JSON.parse(await readFile(join(RAW, '_manifest.json'), 'utf8'));
} catch {
  /* first run */
}
await writeFile(
  join(RAW, '_manifest.json'),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      lastSeeds: which,
      pages: { ...prior.pages, ...Object.fromEntries(seen) },
    },
    null,
    2
  )
);

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`OK ${ok} pages / tried ${seen.size} in ${secs}s -> ${RAW}`);
console.log(`manifest: _manifest.json (${seen.size} entries)`);
if (failures.length) {
  console.log(`FAILED ${failures.length}:`);
  console.log(failures.slice(0, 15).join('\n'));
  if (failures.length > 15) console.log(`... ${failures.length - 15} more (see _manifest.json)`);
}
