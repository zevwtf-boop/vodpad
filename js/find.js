/* find & replace inside the page.

   highlighting uses the css custom highlight api, so nothing is injected into
   your text — no stray spans left behind in the saved html.
*/

import { $, $$, h, clear, debounce } from './util.js?v=764fd7e397';
import { icon } from './icons.js?v=764fd7e397';
import { state, quietly, commit } from './store.js?v=764fd7e397';
import { pushLayer, dropLayer, toast } from './ui.js?v=764fd7e397';
import { popIn, popOut } from './motion.js?v=764fd7e397';

let bar = null;
let hits = [];
let at = -1;
let query = '';

const supported = typeof Highlight !== 'undefined' && CSS.highlights;

export function openFind(prefill = '') {
  if (bar) { bar.querySelector('.find-input').focus(); return; }
  const host = $('#surface-page');
  if (!host) return;

  const input = h('input.find-input.field', { placeholder: 'find in this page', value: prefill, spellcheck: false });
  const replace = h('input.find-replace.field', { placeholder: 'replace with…', spellcheck: false });
  const count = h('span.find-count', { text: '0/0' });

  bar = h('div.find-bar',
    h('div.find-row',
      icon('find', { size: 15 }),
      input,
      count,
      h('button.icon-btn', { tip: 'previous · shift+enter', on: { click: () => step(-1) } }, icon('up', { size: 15 })),
      h('button.icon-btn', { tip: 'next · enter', on: { click: () => step(1) } }, icon('down', { size: 15 })),
      h('button.icon-btn', { tip: 'close · esc', on: { click: close } }, icon('close', { size: 15 }))),
    h('div.find-row',
      icon('redo', { size: 15 }),
      replace,
      h('button.btn.btn-sm', { on: { click: () => doReplace(false) } }, 'replace'),
      h('button.btn.btn-sm', { on: { click: () => doReplace(true) } }, 'all')),
  );

  host.append(bar);
  popIn(bar, { origin: 'top right', duration: 180 });
  input.focus();

  input.addEventListener('input', debounce(() => run(input.value), 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  replace.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doReplace(e.ctrlKey); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  pushLayer(close);
  if (prefill) run(prefill);

  function close() {
    dropLayer(close);
    clearHighlights();
    const el = bar;
    bar = null;
    popOut(el, { duration: 120 }).then(() => el.remove());
  }
}

export const findOpen = () => !!bar;

/* ---------------------------------------------------------------- search */

function editableHosts() {
  return $$('.page-sheet .blk-body, .page-sheet .sidenote-body, .page-sheet .freebox-body, .page-sheet .img-cap, .page-sheet .blk-table td, .page-sheet .blk-table th');
}

function run(text) {
  query = text;
  hits = [];
  at = -1;
  clearHighlights();
  if (!text || text.length < 1) { paintCount(); return; }

  const needle = text.toLowerCase();
  for (const host of editableHosts()) {
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const hay = (node.nodeValue || '').toLowerCase();
      let from = 0, idx;
      while ((idx = hay.indexOf(needle, from)) !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        hits.push({ range, host });
        from = idx + needle.length;
      }
    }
  }
  paintHighlights();
  paintCount();
  if (hits.length) step(1);
}

function paintHighlights() {
  if (!supported) return;
  CSS.highlights.set('vodfind', new Highlight(...hits.map((x) => x.range)));
}

function clearHighlights() {
  if (!supported) return;
  CSS.highlights.delete('vodfind');
  CSS.highlights.delete('vodfind-now');
}

function paintCount() {
  const el = bar?.querySelector('.find-count');
  if (el) el.textContent = hits.length ? `${at + 1}/${hits.length}` : '0/0';
}

function step(delta) {
  if (!hits.length) return;
  at = (at + delta + hits.length) % hits.length;
  const hit = hits[at];
  if (supported) CSS.highlights.set('vodfind-now', new Highlight(hit.range));
  const host = hit.host?.closest('.blk, .sidenote, .freebox, .img-block') || hit.host;
  import('./page.js?v=764fd7e397').then((pg) => pg.ensureVisible(host, { margin: 140 }));
  paintCount();
}

/* ---------------------------------------------------------------- replace */

function doReplace(all) {
  const withText = bar?.querySelector('.find-replace')?.value ?? '';
  if (!query || !hits.length) return;
  const targets = all ? hits.slice() : [hits[Math.max(0, at)]];
  const touched = new Set();

  for (const hit of targets.reverse()) {
    try {
      hit.range.deleteContents();
      hit.range.insertNode(document.createTextNode(withText));
      touched.add(hit.host);
    } catch { /* the dom moved under us; the re-run below picks it up */ }
  }
  for (const host of touched) syncHost(host);
  toast(all ? `replaced ${targets.length}` : 'replaced', { kind: 'ok', ms: 1400 });
  run(query);
}

/** push a host's edited html back into the model */
function syncHost(host) {
  const cardId = state.cardId;
  const blk = host.closest('.blk');
  if (blk && host.classList.contains('blk-body')) {
    const id = blk.dataset.id;
    const html = host.tagName === 'CODE' ? host.textContent : host.innerHTML;
    commit('replace text', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === id);
      if (t) t.html = html;
    });
    return;
  }
  if (host.classList.contains('img-cap')) {
    const id = blk?.dataset.id;
    const html = host.innerHTML;
    commit('replace caption', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === id);
      if (t) t.caption = html;
    });
    return;
  }
  const side = host.closest('.sidenote');
  if (side) {
    const html = host.innerHTML;
    commit('replace note', (b) => {
      const n = (b.cards[cardId].side || []).find((x) => x.id === side.dataset.id);
      if (n) n.html = html;
    });
    return;
  }
  const free = host.closest('.freebox');
  if (free) {
    const html = host.innerHTML;
    commit('replace text box', (b) => {
      const f = (b.cards[cardId].free || []).find((x) => x.id === free.dataset.id);
      if (f) f.html = html;
    });
    return;
  }
  const cell = host.closest('td, th');
  if (cell && blk) {
    const table = cell.closest('table');
    const r = [...table.rows].indexOf(cell.parentElement);
    const c = [...cell.parentElement.cells].indexOf(cell);
    const html = cell.innerHTML;
    commit('replace cell', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === blk.dataset.id);
      if (t && t.rows?.[r]) t.rows[r][c] = html;
    });
  }
}
