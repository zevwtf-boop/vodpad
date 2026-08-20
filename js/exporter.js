/* turning a page (and everything nested under it) into a clean document —
   used by read mode, by markdown/html export, and by print-to-pdf. */

import { h, stripHtml, download, fmtDate, fmtClock } from './util.js?v=7cc5d8f531';
import { mediaUrl } from './api.js?v=7cc5d8f531';
import { state, card, childrenOf, cardTitle } from './store.js?v=7cc5d8f531';
import { paintStrokes } from './images.js?v=7cc5d8f531';
import { pathFor, sidePoint, bestSides } from './wires.js?v=7cc5d8f531';
import { toast } from './ui.js?v=7cc5d8f531';

/* ---------------------------------------------------------------- dom render */

export function renderCardTree(cardId, { level = 1, max = 6 } = {}) {
  const c = card(cardId);
  if (!c) return h('div');

  const section = h('section.doc-section', { data: { level } });
  const heading = h(`h${Math.min(6, level)}`, { class: 'doc-heading', text: cardTitle(c) });
  section.append(heading);

  const meta = [];
  if (c.severity) meta.push(['working on it', 'costs me games', 'fixed'][c.severity - 1]);
  if (c.t !== null && c.t !== undefined) meta.push(fmtClock(c.t));
  for (const tag of c.tags || []) meta.push(`#${tag}`);
  if (meta.length) section.append(h('p.doc-meta', { text: meta.join(' · ') }));

  const body = h('div.doc-body');
  let listHost = null, listType = null;

  const closeList = () => { listHost = null; listType = null; };

  for (const block of c.blocks || []) {
    if (['ul', 'ol', 'todo'].includes(block.type)) {
      const tag = block.type === 'ol' ? 'ol' : 'ul';
      if (!listHost || listType !== block.type) {
        listHost = h(tag, { class: block.type === 'todo' ? 'doc-todo' : '' });
        listType = block.type;
        body.append(listHost);
      }
      const li = h('li', { html: block.html || '' });
      if (block.type === 'todo') li.prepend(h('span.doc-check', { text: block.checked ? '☑ ' : '☐ ' }));
      if (block.indent) li.style.marginLeft = `${block.indent * 20}px`;
      listHost.append(li);
      appendSidenotes(body, c, block.id);
      continue;
    }
    closeList();

    if (block.type === 'divider') { body.append(h('hr')); continue; }
    if (block.type === 'image') { body.append(figureFor(block)); appendSidenotes(body, c, block.id); continue; }
    if (block.type === 'code') { body.append(h('pre', h('code', { text: stripHtml(block.html) }))); continue; }
    if (block.type === 'quote') { body.append(h('blockquote', { html: block.html || '' })); continue; }
    if (block.type === 'callout') { body.append(h('div.doc-callout', h('span', { text: block.emoji || '💡' }), h('div', { html: block.html || '' }))); continue; }
    if (block.type === 'table') {
      const table = h('table.doc-table');
      (block.rows || []).forEach((row, r) => {
        const tr = h('tr');
        for (const cell of row) tr.append(h(r === 0 && block.header !== false ? 'th' : 'td', { html: cell || '' }));
        table.append(tr);
      });
      body.append(table);
      continue;
    }
    if (block.type === 'subpage') continue;                    // rendered as a nested section below
    if (/^h[1-3]$/.test(block.type)) {
      const depth = Math.min(6, level + Number(block.type[1]));
      body.append(h(`h${depth}`, { html: block.html || '' }));
      appendSidenotes(body, c, block.id);
      continue;
    }
    if (!(block.html || '').trim()) continue;
    body.append(h('p', { html: block.html || '' }));
    appendSidenotes(body, c, block.id);
  }

  section.append(body);

  const board = boardFor(c);
  if (board) section.append(board);

  if ((c.free || []).length) {
    section.append(h('div.doc-loose',
      h('h6', { text: 'notes off to the side' }),
      ...c.free.map((f) => h('div.doc-loose-item', { html: f.html || '' }))));
  }

  if (level < max) {
    for (const kid of childrenOf(cardId)) section.append(renderCardTree(kid.id, { level: level + 1, max }));
  }
  return section;
}

/* ---------------------------------------------------------------- the board

   the whiteboard has to survive leaving the app, or half a session's thinking
   only exists inside vodpad. it is drawn to scale from the model — the boxes
   where they sit and the lines between them — rather than screenshotted, so
   the text in it is still text you can search and select. lines that run to
   something in the column are left out: there is nowhere on this page for
   them to land. */

const SH_MIN = 40;

function boardPaint(s) {
  const fill = s.fill || '#68707c';
  const tone = s.tone || 'solid';
  if (s.kind === 'frame') return { bg: 'transparent', edge: '#2b1c4c', ink: '#9d90b8' };
  if (tone === 'text') return { bg: 'transparent', edge: 'transparent', ink: '#ece6f7' };
  if (tone === 'none') return { bg: 'transparent', edge: fill, ink: '#ece6f7' };
  if (tone === 'soft') return { bg: `color-mix(in srgb, ${fill} 22%, #150d27)`, edge: fill, ink: '#ece6f7' };
  return { bg: fill, edge: fill, ink: inkOn(fill) };
}

function inkOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ece6f7';
  const n = parseInt(m[1], 16);
  const f = (v) => { const ch = v / 255; return ch <= 0.04045 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  return lum > 0.48 ? '#14181c' : '#f6f8fa';
}

const RADIUS = { round: '10px', pill: '999px', ellipse: '50%', sticky: '4px', frame: '10px' };

function boardFor(c) {
  const shapes = (c.shapes || []).filter((s) => s && s.w > 0 && s.h > 0);
  if (!shapes.length) return null;

  const pad = 30;
  const l = Math.min(...shapes.map((s) => s.x)) - pad;
  const t = Math.min(...shapes.map((s) => s.y)) - pad;
  const r = Math.max(...shapes.map((s) => s.x + s.w)) + pad;
  const b = Math.max(...shapes.map((s) => s.y + s.h)) + pad;
  const w = Math.max(SH_MIN, r - l);
  const hh = Math.max(SH_MIN, b - t);
  const scale = Math.min(1, 860 / w);

  const stage = h('div.doc-board-inner', {
    style: { width: `${w}px`, height: `${hh}px`, transform: `scale(${scale})` },
  });

  // the lines first, so boxes sit on top of them exactly as they do in the app
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'doc-board-lines');
  svg.setAttribute('viewBox', `0 0 ${w} ${hh}`);
  let drew = 0;
  for (const wire of c.wires || []) {
    const a = byId.get(wire.from?.id);
    const z = byId.get(wire.to?.id);
    if (!a || !z) continue;
    const ba = { l: a.x - l, t: a.y - t, r: a.x - l + a.w, b: a.y - t + a.h, cx: a.x - l + a.w / 2, cy: a.y - t + a.h / 2 };
    const bz = { l: z.x - l, t: z.y - t, r: z.x - l + z.w, b: z.y - t + z.h, cx: z.x - l + z.w / 2, cy: z.y - t + z.h / 2 };
    const auto = bestSides(ba, bz);
    const s1 = wire.from.side || auto[0];
    const s2 = wire.to.side || auto[1];
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathFor(sidePoint(ba, s1), s1, sidePoint(bz, s2), s2, wire.style || 'curve'));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', wire.colour || '#a4abb3');
    path.setAttribute('stroke-width', String(wire.weight || 2));
    if (wire.dash) path.setAttribute('stroke-dasharray', '7 5');
    svg.append(path);
    drew++;
    if (wire.label) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String((ba.cx + bz.cx) / 2));
      text.setAttribute('y', String((ba.cy + bz.cy) / 2 - 6));
      text.setAttribute('class', 'doc-board-label');
      text.textContent = wire.label;
      svg.append(text);
    }
  }
  if (drew) stage.append(svg);

  const order = [...shapes].sort((a, z) =>
    (a.kind === 'frame' ? 0 : 1) - (z.kind === 'frame' ? 0 : 1) || (a.z || 0) - (z.z || 0));

  for (const s of order) {
    const paint = boardPaint(s);
    const box = h('div.doc-box', {
      style: {
        left: `${s.x - l}px`, top: `${s.y - t}px`, width: `${s.w}px`, height: `${s.h}px`,
        background: paint.bg,
        border: `${s.weight || 1.5}px ${s.dash || s.kind === 'frame' ? 'dashed' : 'solid'} ${paint.edge}`,
        borderRadius: RADIUS[s.kind] || '3px',
        color: paint.ink,
        textAlign: s.align || 'center',
        justifyContent: s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
      },
    });
    if (s.src) box.append(h('img.doc-box-img', { src: mediaUrl(state.board.id, s.src), alt: stripHtml(s.html || '') }));
    if (s.kind === 'frame' && s.title) box.append(h('span.doc-box-title', { text: s.title }));
    if ((s.html || '').trim()) box.append(h('div.doc-box-text', { html: s.html }));
    stage.append(box);
  }

  return h('div.doc-board', { style: { height: `${Math.round(hh * scale)}px` } },
    h('h6', { text: 'the board' }), stage);
}

function appendSidenotes(body, c, blockId) {
  for (const note of (c.side || []).filter((n) => n.blockId === blockId)) {
    if (!stripHtml(note.html).trim()) continue;
    body.append(h('aside.doc-side', { html: note.html }));
  }
}

function figureFor(block) {
  const fig = h('figure.doc-figure', { class: `layout-${block.layout || 'center'}` });
  const holder = h('div.doc-imgwrap');
  const img = h('img', { src: mediaUrl(state.board.id, block.src), alt: stripHtml(block.caption || '') });
  holder.append(img);

  if ((block.strokes || []).length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'doc-strokes');
    const nat = block.nat || { w: 1600, h: 900 };
    svg.setAttribute('viewBox', `0 0 ${nat.w} ${nat.h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    paintStrokes(svg, block);
    holder.append(svg);
  }
  for (const [i, pin] of (block.pins || []).entries()) {
    holder.append(h('span.doc-pin', {
      text: String(i + 1),
      style: { left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` },
    }));
  }
  fig.append(holder);

  const caption = stripHtml(block.caption || '').trim();
  const pins = (block.pins || []).filter((p) => (p.text || '').trim());
  if (caption || pins.length) {
    fig.append(h('figcaption',
      caption ? h('div', { text: caption }) : null,
      ...pins.map((p, i) => h('div.doc-pinnote',
        h('span.doc-pinnum', { text: String((block.pins || []).indexOf(p) + 1) }),
        h('span', { text: p.text })))));
  }
  return fig;
}

/* ---------------------------------------------------------------- markdown */

export function cardToMarkdown(cardId, level = 1) {
  const c = card(cardId);
  if (!c) return '';
  const lines = [`${'#'.repeat(Math.min(6, level))} ${cardTitle(c)}`, ''];

  const bits = [];
  if (c.severity) bits.push(`**${['working on it', 'costs me games', 'fixed'][c.severity - 1]}**`);
  if (c.t !== null && c.t !== undefined) bits.push(`\`${fmtClock(c.t)}\``);
  for (const tag of c.tags || []) bits.push(`#${tag}`);
  if (bits.length) lines.push(bits.join(' · '), '');

  let olCount = 0;
  for (const block of c.blocks || []) {
    const text = mdInline(block.html);
    const pad = '  '.repeat(block.indent || 0);
    switch (block.type) {
      case 'h1': lines.push(`${'#'.repeat(Math.min(6, level + 1))} ${text}`, ''); break;
      case 'h2': lines.push(`${'#'.repeat(Math.min(6, level + 2))} ${text}`, ''); break;
      case 'h3': lines.push(`${'#'.repeat(Math.min(6, level + 3))} ${text}`, ''); break;
      case 'ul': lines.push(`${pad}- ${text}`); break;
      case 'ol': lines.push(`${pad}${++olCount}. ${text}`); break;
      case 'todo': lines.push(`${pad}- [${block.checked ? 'x' : ' '}] ${text}`); break;
      case 'quote': lines.push(`> ${text}`, ''); break;
      case 'callout': lines.push(`> 💡 ${text}`, ''); break;
      case 'code': lines.push('```', stripHtml(block.html), '```', ''); break;
      case 'divider': lines.push('---', ''); break;
      case 'table':
        for (const [r, row] of (block.rows || []).entries()) {
          lines.push(`| ${row.map((cell) => mdInline(cell)).join(' | ')} |`);
          if (r === 0) lines.push(`|${row.map(() => ' --- ').join('|')}|`);
        }
        lines.push('');
        break;
      case 'image': {
        lines.push(`![${stripHtml(block.caption || '')}](${block.src})`);
        for (const [i, pin] of (block.pins || []).entries()) {
          if ((pin.text || '').trim()) lines.push(`> **${i + 1}.** ${pin.text}`);
        }
        lines.push('');
        break;
      }
      case 'subpage': break;
      default: if (text) lines.push(text, '');
    }
    if (block.type !== 'ol') olCount = 0;
    for (const note of (c.side || []).filter((n) => n.blockId === block.id)) {
      const side = mdInline(note.html);
      if (side) lines.push(`> ⟵ ${side}`, '');
    }
  }

  for (const box of c.free || []) {
    const text = mdInline(box.html);
    if (text) lines.push(`> ${text}`, '');
  }

  // the board, flattened: every box, then every line between two of them.
  // markdown has no canvas, so what carries over is what each box says and
  // what points at what — which is the part you would have written down.
  const shapes = c.shapes || [];
  if (shapes.length) {
    lines.push(`${'#'.repeat(Math.min(6, level + 1))} the board`, '');
    const label = (s) => mdInline(s.html) || (s.src ? '(picture)' : s.title || '(empty box)');
    for (const s of shapes) {
      const bits = [label(s)];
      if (s.src) bits.push(`![](${s.src})`);
      lines.push(`- ${bits.join(' ')}`);
    }
    lines.push('');
    const byId = new Map(shapes.map((s) => [s.id, s]));
    const joins = (c.wires || []).filter((w) => byId.has(w.from?.id) && byId.has(w.to?.id));
    for (const w of joins) {
      const arrow = w.ends === 'both' ? '<->' : w.ends === 'none' ? '--' : '->';
      lines.push(`- ${label(byId.get(w.from.id))} ${arrow} ${label(byId.get(w.to.id))}${w.label ? ` (${w.label})` : ''}`);
    }
    if (joins.length) lines.push('');
  }

  lines.push('');
  for (const kid of childrenOf(cardId)) lines.push(cardToMarkdown(kid.id, level + 1));
  return lines.join('\n');
}

function mdInline(html) {
  if (!html) return '';
  const host = document.createElement('div');
  host.innerHTML = html;
  host.querySelectorAll('b, strong').forEach((n) => n.replaceWith(`**${n.textContent}**`));
  host.querySelectorAll('i, em').forEach((n) => n.replaceWith(`*${n.textContent}*`));
  host.querySelectorAll('code').forEach((n) => n.replaceWith('`' + n.textContent + '`'));
  host.querySelectorAll('s, strike, del').forEach((n) => n.replaceWith(`~~${n.textContent}~~`));
  host.querySelectorAll('a').forEach((n) => n.replaceWith(`[${n.textContent}](${n.getAttribute('href')})`));
  return (host.textContent || '').replace(/\s+/g, ' ').trim();
}

/* ---------------------------------------------------------------- files out */

/* ---------------------------------------------------------------- clip list

   every timestamp in the session, in one file, for whoever is cutting the
   video. the sidebar's timeline tab does this for one page; this does the whole
   thing, and both read the same scan out of stamps.js.
*/

export async function exportClipList(doc, { csv = false } = {}) {
  const { stampsInDoc, clipCsv, clipLines } = await import('./stamps.js?v=7cc5d8f531');
  const rows = stampsInDoc(doc);

  if (!rows.length) {
    toast('no timestamps in this session — press t while the vod plays', { kind: 'warn', ms: 4200 });
    return 0;
  }

  const stem = (doc.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
  if (csv) {
    // a bom, or excel reads utf-8 as latin-1 and mangles every accent
    download(`${stem}-clips.csv`, '﻿' + clipCsv(rows, { session: doc.title || '' }), 'text/csv;charset=utf-8');
  } else {
    const head = [doc.title || 'session', doc.video?.label ? `vod: ${doc.video.label}` : null, '']
      .filter((l) => l !== null).join('\n');
    download(`${stem}-clips.txt`, head + clipLines(rows) + '\n');
  }
  toast(`${rows.length} timestamp${rows.length === 1 ? '' : 's'} exported`, { kind: 'ok' });
  return rows.length;
}

export function exportMarkdown(cardId) {
  const c = card(cardId);
  const md = `<!-- vodpad · ${fmtDate(Date.now())} -->\n\n${cardToMarkdown(cardId)}`;
  download(`${slug(cardTitle(c))}.md`, md, 'text/markdown');
  toast('markdown saved to downloads', { kind: 'ok' });
}

export async function exportHtml(cardId) {
  const c = card(cardId);
  toast('packing the pictures in…');
  const tree = renderCardTree(cardId);
  await inlineImages(tree);
  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(cardTitle(c))} — vodpad</title>
<style>${DOC_CSS}</style>
</head><body><main class="doc">${tree.outerHTML}</main>
<footer class="doc-foot">exported from vodpad · ${fmtDate(Date.now())}</footer>
</body></html>`;
  download(`${slug(cardTitle(c))}.html`, doc, 'text/html');
  toast('self-contained html saved to downloads', { kind: 'ok' });
}

async function inlineImages(root) {
  const jobs = [];
  for (const img of root.querySelectorAll('img')) jobs.push(toDataUri(img.getAttribute('src')).then((d) => d && img.setAttribute('src', d)));
  for (const im of root.querySelectorAll('image')) jobs.push(toDataUri(im.getAttribute('href')).then((d) => d && im.setAttribute('href', d)));
  await Promise.all(jobs);
}

async function toDataUri(url) {
  if (!url || url.startsWith('data:')) return null;
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

const slug = (text) => String(text || 'vodpad').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'vodpad';
const escape = (s) => String(s).replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));

/* the stylesheet the exported document carries with it */
export const DOC_CSS = `
:root{--bg:#0b0714;--paper:#150d27;--line:#2b1c4c;--text:#ece6f7;--muted:#9d90b8;--accent:#c9a7ff;
--ink-rose:#ff5f7e;--ink-amber:#ffb454;--ink-mint:#55e6b8;--ink-lilac:#c9a7ff;--ink-white:#fff;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 "Segoe UI",system-ui,sans-serif;}
.doc{max-width:78ch;margin:0 auto;padding:56px 24px 80px;}
.doc-section{margin-bottom:22px}
.doc-section[data-level="2"]{padding-left:18px;border-left:2px solid var(--line);margin-top:34px}
.doc-section[data-level="3"]{padding-left:16px;border-left:1px solid var(--line)}
h1,h2,h3,h4,h5,h6{line-height:1.25;letter-spacing:-.015em;margin:1.4em 0 .5em}
h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.22em}h4{font-size:1.05em}
p{margin:.7em 0}
a{color:var(--accent)}
hr{border:0;height:1px;background:var(--line);margin:26px 0}
blockquote{margin:.8em 0;padding:.2em 0 .2em 16px;border-left:3px solid var(--accent);color:var(--muted);font-style:italic}
code{font-family:"Cascadia Code",Consolas,monospace;font-size:.88em;background:#241640;padding:1px 5px;border-radius:5px;color:var(--accent)}
pre{background:#12091f;border:1px solid var(--line);border-radius:9px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0;color:var(--text)}
mark,[data-hl]{background:rgba(255,180,84,.3);border-radius:3px;padding:0 3px;color:inherit}
[data-hl=rose]{background:rgba(255,107,138,.3)}[data-hl=mint]{background:rgba(110,231,192,.28)}[data-hl=lilac]{background:rgba(201,167,255,.25)}
[data-c=amber]{color:var(--ink-amber)}[data-c=rose]{color:var(--ink-rose)}[data-c=mint]{color:var(--ink-mint)}[data-c=lilac]{color:var(--accent)}
[data-tag]{color:var(--accent);font-weight:550}
.doc-meta{color:var(--muted);font-size:13px;margin:-.3em 0 1em}
.doc-side{margin:.6em 0 .6em 0;padding:8px 12px;border-left:2px solid var(--accent);background:rgba(201,167,255,.06);border-radius:0 8px 8px 0;color:var(--muted);font-size:.88em}
.doc-callout{display:flex;gap:10px;padding:12px 14px;margin:.8em 0;border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:9px;background:rgba(201,167,255,.06)}
.doc-figure{margin:20px 0}
.doc-figure.layout-left{float:left;width:46%;margin:6px 24px 12px 0}
.doc-figure.layout-right{float:right;width:46%;margin:6px 0 12px 24px}
.doc-imgwrap{position:relative;line-height:0;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.doc-imgwrap img{width:100%;display:block}
.doc-strokes{position:absolute;inset:0;width:100%;height:100%}
.doc-pin{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:99px;background:#5b2fa8;color:#fff;border:2px solid #fff;display:grid;place-items:center;font:700 11px/1 monospace}
figcaption{font-size:13px;color:var(--muted);padding-top:8px;line-height:1.5}
.doc-pinnote{display:flex;gap:8px;align-items:baseline;margin-top:5px}
.doc-pinnum{flex:none;width:17px;height:17px;border-radius:99px;background:#5b2fa8;color:#fff;display:grid;place-items:center;font:700 10px/1 monospace}
.doc-table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.94em}
.doc-table th,.doc-table td{border:1px solid var(--line);padding:7px 10px;text-align:left}
.doc-table th{background:#1e1235}
.doc-todo{list-style:none;padding-left:4px}
.doc-board{margin:22px 0;overflow:hidden}
.doc-board h6{margin:0 0 10px;color:var(--muted);font-size:11px;letter-spacing:.09em;text-transform:uppercase}
.doc-board-inner{position:relative;transform-origin:top left}
.doc-board-lines{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
.doc-board-label{font-size:11px;fill:var(--muted);text-anchor:middle}
.doc-box{position:absolute;display:flex;flex-direction:column;padding:8px 11px;overflow:hidden;font-size:14px;line-height:1.4}
.doc-box-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;border-radius:inherit}
.doc-box-text{position:relative}
.doc-box-title{position:absolute;left:8px;top:-20px;font-size:11px;color:var(--muted)}
.doc-loose{margin-top:20px;padding-top:12px;border-top:1px dashed var(--line)}
.doc-loose h6{margin:0 0 8px;color:var(--muted);font-size:11px;letter-spacing:.09em;text-transform:uppercase}
.doc-loose-item{padding:8px 12px;border:1px solid var(--line);border-radius:9px;margin-bottom:7px;font-size:.9em}
.doc-section::after{content:"";display:block;clear:both}
.doc-foot{max-width:78ch;margin:0 auto 40px;padding:0 24px;color:#6f6490;font-size:12px}
@media print{
  body{background:#fff;color:#12101a}
  .doc{max-width:none;padding:0}
  h1,h2,h3,h4{color:#12101a}
  .doc-side,.doc-callout{background:#f4f0fb}
  code{background:#eee;color:#5b2fa8}
  pre{background:#f6f4fa}
  .doc-foot{display:none}
  a{color:#5b2fa8}
}
`;
