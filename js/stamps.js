/* finding timestamps in a session.

   a stamp is an inline `<span data-t="83.2">` written into block html by the
   video panel. keeping the scan here rather than inside page.js means the
   sidebar's timeline tab and the whole-session clip export read exactly the
   same thing — the tab is what you scrub with, the export is what you hand to
   whoever is cutting the video, and they must not disagree. */

import { stripHtml, fmtClock } from './util.js?v=7cc5d8f531';

export const CHIP_RE = /<span[^>]*\bdata-t="([\d.]+)"[^>]*>[\s\S]*?<\/span>/gi;

export const tidy = (html, cap = 90) => {
  const text = stripHtml(String(html || '')).replace(/\s+/g, ' ').trim();
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
};

/** every stamp in one chunk of html, each carrying the words that follow it.
 *  a stamp with nothing after it borrows the whole line, so a row is never
 *  just a naked time with no idea what it was for. */
export function stampsIn(html, cap = 90) {
  const src = String(html || '');
  const spans = [];
  CHIP_RE.lastIndex = 0;
  for (let m = CHIP_RE.exec(src); m; m = CHIP_RE.exec(src)) {
    if (spans.length) spans[spans.length - 1].to = m.index;
    spans.push({ t: Number(m[1]), from: m.index + m[0].length, to: src.length });
  }
  const whole = tidy(src.replace(CHIP_RE, ' '), cap);
  return spans.map((s) => ({ t: s.t, text: tidy(src.slice(s.from, s.to), cap) || whole }));
}

/** every stamp on one card: blocks, captions, margin notes, floating boxes.
 *  child cards are not included — the caller decides whether it wants those,
 *  because the sidebar wants only direct children and an export wants none
 *  (it visits every card in the document anyway). */
export function stampsOnCard(c, cap = 90) {
  const rows = [];
  const take = (html, kind, ref) => {
    for (const s of stampsIn(html, cap)) rows.push({ ...s, kind, ref });
  };
  for (const block of c.blocks || []) {
    take(block.html, 'block', block.id);
    if (block.caption) take(block.caption, 'block', block.id);
    for (const pin of block.pins || []) take(pin.text, 'block', block.id);
  }
  for (const note of c.side || []) take(note.html, 'side', note.id);
  for (const box of c.free || []) take(box.html, 'free', box.id);
  return rows;
}

/** every stamp anywhere in a session document, in time order.
 *  each row also knows which page it came from, which is the column that makes
 *  the export useful to somebody who was not there. */
export function stampsInDoc(doc, cap = 140) {
  const cards = doc?.cards || {};
  const rows = [];

  const titleOf = (c) => {
    if (c.title?.trim()) return c.title.trim();
    for (const b of c.blocks || []) {
      const t = tidy(b.html, 60);
      if (t) return t;
    }
    return 'untitled';
  };

  for (const c of Object.values(cards)) {
    const page = titleOf(c);
    for (const row of stampsOnCard(c, cap)) rows.push({ ...row, page, cardId: c.id, tags: c.tags || [] });
    // a child card can carry its own single stamp instead of an inline one
    if (c.t !== null && c.t !== undefined && Number.isFinite(Number(c.t))) {
      rows.push({ t: Number(c.t), text: page, kind: 'card', ref: c.id, page, cardId: c.id, tags: c.tags || [] });
    }
  }

  return rows.filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
}

/** "0:42  greedy loot after the kill" — what you paste into a message */
export const clipLines = (rows) =>
  rows.map((r) => `${fmtClock(r.t)} ${r.text}`.trim()).join('\n');

/** the same thing as a spreadsheet an editor can sort and tick off */
export function clipCsv(rows, { session = '' } = {}) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [['timestamp', 'seconds', 'note', 'page', 'tags', 'session'].join(',')];
  for (const r of rows) {
    out.push([fmtClock(r.t), r.t.toFixed(2), r.text, r.page || '', (r.tags || []).join(' '), session]
      .map(cell).join(','));
  }
  return out.join('\r\n');            // excel is happier with crlf
}
