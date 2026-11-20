// Shared parsing of the ci corpus in raw/, used by style_stats.mjs and works_index.mjs
// so that "how many poems" and "which poems" are always derived the same way.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const RAW = join(dirname(fileURLToPath(import.meta.url)), '..', 'raw');

export const VOLUME_FILES = ['通志堂集_06.md', '通志堂集_07.md', '通志堂集_08.md', '通志堂集_09.md'];
export const COLLECTION = '納蘭詞全集.md';
// 卷六…卷九 correspond to the four ci volumes of 通志堂集.
export const VOLUME_LABEL = { '通志堂集_06.md': '卷六', '通志堂集_07.md': '卷七', '通志堂集_08.md': '卷八', '通志堂集_09.md': '卷九' };

export function clean(s) {
  return s
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/@@INC:[^@]+@@/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function stripPunct(s) {
  return s.replace(/[，。！？、；：,.!?;:"“”‘’《》（）()【】—…·\-～]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function han(s) {
  return s.match(/[㐀-䶿一-鿿]/g) || [];
}

export function readRaw(name) {
  try {
    return readFileSync(join(RAW, name), 'utf8');
  } catch {
    return null;
  }
}

// Split a raw page into heading-delimited blocks, tracking the tune name.
export function blocksOf(text, tuneLevel) {
  const blocks = [];
  let tune = null;
  let notes = [];
  let lines = [];
  const close = () => {
    if (tune && lines.length) blocks.push({ tune, note: notes.join(' '), lines: lines.slice() });
    lines = [];
  };
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    const h = l.match(/^(#+)\s*(.+?)\s*#*\s*$/);
    if (h) {
      const level = h[1].length;
      const name = clean(h[2]);
      const paren = h[2].match(/[（(]([^）)]*)[）)]/);
      if (level === tuneLevel && !/^又/.test(name)) {
        close();
        tune = name.replace(/[（(].*$/, '').trim();
        notes = paren ? [paren[1]] : [];
        continue;
      }
      if (level >= tuneLevel && /^又/.test(name) && tune) {
        close();
        notes = paren ? [paren[1]] : [];
        continue;
      }
      if (level < tuneLevel) {
        close();
        if (level === 2 && tuneLevel > 2) tune = null;
        continue;
      }
      continue;
    }
    if (!l) {
      lines.push('');
      continue;
    }
    if (/^<!--|^>|^#\s|^納蘭詞$|^作者/.test(l)) continue;
    if (/^[（(][^）)]*[））]$/.test(l)) {
      notes.push(l.replace(/^[（(]|[）)]$/g, ''));
      continue;
    }
    lines.push(l);
  }
  close();
  return blocks;
}

export function toPoem(lines) {
  return stripPunct(lines.filter(Boolean).join(''));
}

// One record per poem heading: tune, 小注, full text, and the first 句 for lookup.
export function parseUnits(text, tuneLevel) {
  const out = [];
  for (const b of blocksOf(text, tuneLevel)) {
    const t = toPoem(b.lines);
    if (han(t).length >= 15 && b.tune && !/卷|賦|詩|^詞$/.test(b.tune)) {
      // A raw volume line carries a whole 片, so 首句 is its first space-delimited segment.
      const line = b.lines.map((l) => stripPunct(l)).find((l) => han(l).length >= 3) || '';
      const first = han(line.split(' ')[0] || '').join('');
      out.push({ tune: b.tune, note: b.note, text: t, first });
    }
  }
  return out;
}

export function volumeUnits() {
  const units = [];
  for (const f of VOLUME_FILES) {
    const t = readRaw(f);
    if (t) units.push(...parseUnits(t, 3).map((u) => ({ ...u, volume: VOLUME_LABEL[f], file: f })));
  }
  return units;
}

// 《飲水詞》 keeps one poem per page, titled 「詞牌（首句）」, so those pages need no
// segmentation and are the safer text to quote verbatim.
export function indexPoems() {
  const byTitle = new Map();
  let man;
  try {
    man = JSON.parse(readFileSync(join(RAW, '_manifest.json'), 'utf8'));
  } catch {
    return byTitle;
  }
  for (const [title, rec] of Object.entries(man.pages || {})) {
    if (!rec || !rec.ok || !rec.file) continue;
    if (/^通志堂集|^飲水詞$|^納蘭詞全集/.test(title)) continue;
    const txt = readRaw(rec.file);
    if (!txt || !/^>\s*飲水詞\s*$/m.test(txt)) continue;
    const body = txt
      .split('\n')
      .filter((l) => !/^\s*(<!--|#|>|$)/.test(l))
      .join('');
    const key = han(body).join('');
    if (key.length < 15) continue;
    const m = title.match(/^(.+?)[（(]([^）)]*)[）)]\s*$/);
    // Most pages are titled 詞牌（首句）, but some carry the author or a theme in the
    // brackets (木蘭花令（納蘭性德）), so trust the bracket only when the text opens that way.
    const fromTitle = m ? han(clean(m[2])).join('') : '';
    const bodyFirst = han(
      stripPunct((txt.split('\n').find((l) => !/^\s*(<!--|#|>|$)/.test(l)) || '').trim()).split(' ')[0] || ''
    ).join('');
    byTitle.set(key, {
      file: rec.file,
      title,
      tune: m ? clean(m[1]) : clean(title),
      first: fromTitle && key.startsWith(fromTitle.slice(0, 5)) ? fromTitle : bodyFirst,
    });
  }
  return byTitle;
}
