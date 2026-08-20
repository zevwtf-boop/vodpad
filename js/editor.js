/* the block editor.

   every block owns its own small contenteditable. that one decision kills the
   whole class of cross-block selection bugs you get from a single giant
   editable, and it is what notion/craft do too.
*/

import { h, $, $$, uid, clamp, stripHtml, sanitizeInline, modKey, debounce } from './util.js?v=7cc5d8f531';
import { icon } from './icons.js?v=7cc5d8f531';
import { state, card, commit, quietly, syncTags, bus, undo } from './store.js?v=7cc5d8f531';
import { contextMenu, toast } from './ui.js?v=7cc5d8f531';
import { animate, EASE } from './motion.js?v=7cc5d8f531';
import { renderImageBlock } from './images.js?v=7cc5d8f531';
import { openSlashMenu, closeSlashMenu, slashOpen } from './toolbar.js?v=7cc5d8f531';

export const TEXT_TYPES = new Set(['p', 'h1', 'h2', 'h3', 'quote', 'callout', 'ul', 'ol', 'todo']);
export const LIST_TYPES = new Set(['ul', 'ol', 'todo']);

let ctx = { cardId: null, host: null };

export const editorCardId = () => ctx.cardId;

/* ---------------------------------------------------------------- render */

export function renderBlocks(host, cardId) {
  ctx = { cardId, host };
  host.innerHTML = '';
  host.dataset.card = cardId;
  const c = card(cardId);
  if (!c) return;
  // an empty page used to grow a paragraph back on every render, which is why
  // "blank" never was. it stays empty now and offers a line instead.
  if (!c.blocks?.length) {
    host.append(h('button.page-empty-hint', {
      on: { click: () => insertBlock(null, { type: 'p' }, true) },
    }, 'click here to start writing — or double-click the plane for a box'));
    bus.emit('page:outline');
    return;
  }
  for (const stale of document.querySelectorAll('#page-free > .blk')) stale.remove();
  const free = document.querySelector('#page-free');
  for (const block of card(cardId).blocks) {
    const el = blockEl(block);
    if (block.float && free) free.append(el); else host.append(el);
  }
  renumber();
  applyFolds();
  bus.emit('page:outline');
}

export function blockEl(block) {
  const el = h('div.blk', { data: { id: block.id, type: block.type, indent: block.indent || 0 } });
  el.style.setProperty('--indent', block.indent || 0);
  if (block.type === 'image') {
    // the float lives on the block box, so following text wraps beside it
    el.dataset.layout = block.layout || 'center';
    el.style.setProperty('--w', `${block.width || 100}%`);
  }

  if (block.align) el.dataset.align = block.align;

  el.append(h('div.blk-rail',
    RANK[block.type]
      ? h('button.blk-btn.blk-fold', {
          tip: 'fold this section',
          on: { click: (e) => { e.stopPropagation(); toggleFold(block.id); } },
        }, icon('caret', { size: 14 }))
      : null,
    h('button.blk-btn.blk-plus', { tip: 'insert below', on: { click: () => insertBlock(block.id, { type: 'p' }, true) } }, icon('plus', { size: 14 })),
    h('button.blk-btn.blk-grip', {
      tip: 'drag to move · click to select · right-click for everything',
      on: {
        click: (e) => {
          selectBlock(block.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
          if (!e.shiftKey && !e.ctrlKey && !e.metaKey) blockMenu(block.id, e.currentTarget);
        },
        pointerdown: (e) => startBlockDrag(e, block.id),
      },
    }, icon('grip', { size: 14 })),
  ));

  if (RANK[block.type]) el.append(h('span.fold-count'));

  if (block.float) {
    el.classList.add('floating');
    el.style.left = `${block.float.x}px`;
    el.style.top = `${block.float.y}px`;
    el.style.width = `${block.float.w || 320}px`;
    el.append(h('div.blk-float-resize', { tip: 'drag to resize', on: { pointerdown: (e) => startFloatResize(e, block.id) } }));
  }

  // alt-drag picks a block up from anywhere on it, not just the handle
  el.addEventListener('pointerdown', (e) => {
    if (e.altKey && !e.target.closest('button')) startBlockDrag(e, block.id);
  });

  el.append(bodyFor(block));
  return el;
}

function bodyFor(block) {
  const main = h('div.blk-main');

  if (block.type === 'divider') {
    main.append(h('div.blk-rule'));
    return main;
  }
  if (block.type === 'image') {
    main.append(renderImageBlock(block, ctx.cardId));
    return main;
  }
  if (block.type === 'table') {
    main.append(tableEl(block));
    return main;
  }
  if (block.type === 'subpage') {
    main.append(subPageEl(block));
    return main;
  }
  if (block.type === 'code') {
    const code = h('code.blk-body.mono', { contenteditable: 'plaintext-only', spellcheck: 'false', data: { ph: 'code…' } });
    code.textContent = stripHtml(block.html);
    bindBody(code, block.id);
    main.append(h('pre.blk-code', code));
    return main;
  }

  const body = h('div.blk-body', {
    contenteditable: 'true',
    spellcheck: String(state.settings.spellcheck !== false),
    html: block.html || '',
    class: (block.html || '').trim() ? '' : 'is-empty',
    data: { ph: placeholderFor(block.type) },
  });
  bindBody(body, block.id);

  if (LIST_TYPES.has(block.type)) {
    const mark = block.type === 'todo'
      ? h('button.li-check', { class: block.checked ? 'on' : '', on: { click: () => toggleTodo(block.id) } }, icon('check', { size: 12 }))
      : h('span.li-mark', { text: block.type === 'ul' ? '•' : '1.' });
    main.append(h('div.blk-li', mark, body));
    if (block.type === 'todo' && block.checked) body.classList.add('done');
  } else if (block.type === 'callout') {
    main.append(h('div.blk-callout', h('span.callout-ico', { text: block.emoji || '💡' }), body));
  } else {
    main.append(body);
  }
  return main;
}

function subPageEl(block) {
  const kid = card(block.cardId);
  if (!kid) {
    return h('button.subpage-block', { on: { click: () => deleteBlock(block.id) } },
      h('span.subpage-ico', icon('cards', { size: 15 })),
      h('span.subpage-title', { text: 'this sub-page is gone — click to remove the link' }));
  }
  const kidCount = (kid.children || []).length;
  return h('button.subpage-block', {
    on: {
      click: async (e) => {
        const { openCardPage } = await import('./nav.js?v=7cc5d8f531');
        openCardPage(kid.id, e.currentTarget);
      },
    },
  },
    h('span.subpage-ico', icon('cards', { size: 15 })),
    h('span.subpage-title', { text: (kid.title || '').trim() || 'untitled sub-page' }),
    h('span.subpage-meta', { text: kidCount ? `${kidCount} inside` : `${(kid.blocks || []).length} blocks` }),
    h('span.subpage-ico', icon('chevron', { size: 14 })));
}

const placeholderFor = (type) => ({
  p: "write, or press '/' for anything",
  h1: 'heading', h2: 'heading', h3: 'heading',
  quote: 'quote', callout: 'note to self',
  ul: 'list item', ol: 'list item', todo: 'to do',
}[type] || '');

/* keeps ordered lists numbered correctly per indent level */
export function renumber() {
  if (!ctx.host) return;
  const counters = [];
  for (const el of $$('.blk', ctx.host)) {
    const type = el.dataset.type;
    const indent = Number(el.dataset.indent || 0);
    if (type === 'ol') {
      counters[indent] = (counters[indent] || 0) + 1;
      counters.length = indent + 1;
      const mark = el.querySelector('.li-mark');
      if (mark) mark.textContent = `${counters[indent]}.`;
    } else if (type !== 'ul' && type !== 'todo') {
      counters.length = 0;
    }
  }
}

/* ---------------------------------------------------------------- folding

   a heading swallows everything under it until the next heading of the same
   or higher rank. long sessions stay readable without deleting anything.
*/

const RANK = { h1: 1, h2: 2, h3: 3 };

export function toggleFold(blockId) {
  const block = getBlock(blockId);
  if (!block || !RANK[block.type]) return;
  const next = !block.folded;
  const cardId = ctx.cardId;
  commit(next ? 'fold' : 'unfold', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.folded = next;
  });
  applyFolds();
}

export function applyFolds() {
  if (!ctx.host) return;
  const list = blocksOf();
  let hideUntil = 0;                       // rank we're hiding under, 0 = not hiding
  for (const block of list) {
    const el = blockElById(block.id);
    if (!el) continue;
    const rank = RANK[block.type] || 0;
    if (hideUntil && rank && rank <= hideUntil) hideUntil = 0;
    el.classList.toggle('folded-away', !!hideUntil);
    if (RANK[block.type]) {
      el.classList.toggle('folded', !!block.folded);
      const count = el.querySelector('.fold-count');
      if (count) count.textContent = block.folded ? `${countUnder(block)} hidden` : '';
      if (block.folded && !hideUntil) hideUntil = rank;
    }
  }
}

function countUnder(heading) {
  const list = blocksOf();
  const rank = RANK[heading.type];
  let n = 0;
  let counting = false;
  for (const block of list) {
    if (block.id === heading.id) { counting = true; continue; }
    if (!counting) continue;
    const r = RANK[block.type] || 0;
    if (r && r <= rank) break;
    n++;
  }
  return n;
}

/* ---------------------------------------------------------------- block selection */

const picked = new Set();

export const selectedBlockIds = () => [...picked];

export function selectBlock(id, { additive = false, range = false } = {}) {
  const list = blocksOf();
  if (range && picked.size) {
    const anchor = [...picked].pop();
    const a = list.findIndex((b) => b.id === anchor);
    const bIdx = list.findIndex((b) => b.id === id);
    if (a >= 0 && bIdx >= 0) {
      const [lo, hi] = a < bIdx ? [a, bIdx] : [bIdx, a];
      for (let i = lo; i <= hi; i++) picked.add(list[i].id);
    }
  } else if (additive) {
    picked.has(id) ? picked.delete(id) : picked.add(id);
  } else {
    picked.clear();
    picked.add(id);
  }
  paintSelection();
}

export function selectAllBlocks() {
  picked.clear();
  for (const b of blocksOf()) picked.add(b.id);
  paintSelection();
}

export function clearBlockSelection() {
  if (!picked.size) return false;
  picked.clear();
  paintSelection();
  return true;
}

function paintSelection() {
  if (!ctx.host) return;
  for (const el of allBlockEls()) el.classList.toggle('sel', picked.has(el.dataset.id));
  bus.emit('page:selection', [...picked]);
}

export function deleteSelected() {
  const ids = [...picked];
  if (!ids.length) return;
  const cardId = ctx.cardId;
  commit(`delete ${ids.length} blocks`, (b) => {
    const card = b.cards[cardId];
    card.blocks = card.blocks.filter((x) => !ids.includes(x.id));
    if (!card.blocks.length) card.blocks = [{ id: uid('b'), type: 'p', html: '' }];
  });
  picked.clear();
  renderBlocks(ctx.host, cardId);
}

export function duplicateSelected() {
  const ids = [...picked];
  if (!ids.length) return;
  const cardId = ctx.cardId;
  commit(`duplicate ${ids.length} blocks`, (b) => {
    const list = b.cards[cardId].blocks;
    const copies = list.filter((x) => ids.includes(x.id)).map((x) => {
      const copy = JSON.parse(JSON.stringify(x));
      copy.id = uid('b');
      if (copy.pins) copy.pins = copy.pins.map((p) => ({ ...p, id: uid('pin') }));
      return copy;
    });
    const at = list.findIndex((x) => x.id === ids.at(-1));
    list.splice(at + 1, 0, ...copies);
  });
  picked.clear();
  renderBlocks(ctx.host, cardId);
}

export function setTypeOnSelection(type) {
  const ids = picked.size ? [...picked] : [];
  if (!ids.length) return;
  const cardId = ctx.cardId;
  commit('change blocks', (b) => {
    for (const block of b.cards[cardId].blocks) {
      if (ids.includes(block.id)) {
        block.type = type;
        if (type === 'divider' || type === 'image') block.html = '';
      }
    }
  });
  renderBlocks(ctx.host, cardId);
  paintSelection();
}

/* ---------------------------------------------------------------- alignment */

export function setAlign(blockId, align) {
  const ids = picked.size ? [...picked] : [blockId];
  const cardId = ctx.cardId;
  commit('align', (b) => {
    for (const block of b.cards[cardId].blocks) if (ids.includes(block.id)) block.align = align;
  });
  for (const id of ids) {
    const el = blockElById(id);
    if (el) el.dataset.align = align;
  }
}

/* ---------------------------------------------------------------- counting */

export function pageStats(cardId = ctx.cardId) {
  const c = card(cardId);
  if (!c) return { words: 0, chars: 0, blocks: 0, pictures: 0, notes: 0, todo: 0, done: 0 };
  let words = 0, chars = 0, pictures = 0, todo = 0, done = 0;
  const eat = (html) => {
    const text = stripHtml(html).trim();
    if (!text) return;
    chars += text.length;
    words += text.split(/\s+/).filter(Boolean).length;
  };
  for (const block of c.blocks || []) {
    if (block.type === 'image') { pictures++; eat(block.caption); for (const p of block.pins || []) eat(p.text); continue; }
    if (block.type === 'todo') { todo++; if (block.checked) done++; }
    if (block.type === 'table') { for (const row of block.rows || []) for (const cell of row) eat(cell); continue; }
    eat(block.html);
  }
  for (const note of c.side || []) eat(note.html);
  for (const box of c.free || []) eat(box.html);
  for (const shape of c.shapes || []) { eat(shape.html); if (shape.src) pictures++; }
  return { words, chars, blocks: (c.blocks || []).length, pictures, notes: (c.side || []).length, todo, done };
}

/* ---------------------------------------------------------------- model ops */

const blocksOf = (cardId = ctx.cardId) => card(cardId)?.blocks || [];
const blockIndex = (id) => blocksOf().findIndex((b) => b.id === id);
export const getBlock = (id) => blocksOf().find((b) => b.id === id) || null;

export function insertBlock(afterId, patch = {}, focus = true) {
  const block = { id: uid('b'), type: 'p', html: '', ...patch };
  const cardId = ctx.cardId;
  commit('insert block', (b) => {
    const list = b.cards[cardId].blocks;
    const at = list.findIndex((x) => x.id === afterId);
    list.splice(at < 0 ? list.length : at + 1, 0, block);
  });
  const el = blockEl(block);
  const afterEl = afterId ? blockElById(afterId) : null;
  if (afterEl) afterEl.after(el); else ctx.host.append(el);
  animate(el, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 180 });
  renumber();
  if (focus) focusBlock(block.id, 'start');
  return block;
}

/** blocks can be an end of a wire; dropping one has to tidy those up */
async function tidyWires() {
  try { (await import('./wires.js?v=7cc5d8f531')).pruneWires(); } catch { /* no wires module, fine */ }
}

export function deleteBlock(id, { focusPrev = true } = {}) {
  const list = blocksOf();
  // the last line used to be undeletable — it was cleared and left behind. a
  // page is allowed to have nothing on it, so it goes like any other, and
  // clicking the paper starts a new first line.
  if (list.length === 1 && list[0].id === id) {
    const cardId = ctx.cardId;
    commit('delete block', (b) => { b.cards[cardId].blocks = []; });
    blockElById(id)?.remove();
    tidyWires();
    return;
  }
  const at = blockIndex(id);
  const prev = list[at - 1], next = list[at + 1];
  const cardId = ctx.cardId;
  commit('delete block', (b) => {
    b.cards[cardId].blocks = b.cards[cardId].blocks.filter((x) => x.id !== id);
  });
  blockElById(id)?.remove();
  renumber();
  tidyWires();
  const target = focusPrev ? prev || next : next || prev;
  if (target) focusBlock(target.id, focusPrev ? 'end' : 'start');
}

export function setType(id, type, extra = {}) {
  const block = getBlock(id);
  if (!block) return;
  const html = block.html;
  const cardId = ctx.cardId;
  commit('change block', (b) => {
    const target = b.cards[cardId].blocks.find((x) => x.id === id);
    Object.assign(target, { type, ...extra });
    if (type === 'divider' || type === 'image') target.html = '';
    if (!LIST_TYPES.has(type)) delete target.checked;
  });
  const el = blockElById(id);
  if (!el) return;
  const fresh = blockEl(getBlock(id));
  el.replaceWith(fresh);
  renumber();
  if (TEXT_TYPES.has(type) || type === 'code') focusBlock(id, 'end');
  animate(fresh, [{ opacity: .4, transform: 'scale(.995)' }, { opacity: 1, transform: 'none' }], { duration: 170 });
}

export function moveBlock(id, toIndex) {
  const cardId = ctx.cardId;
  commit('move block', (b) => {
    const list = b.cards[cardId].blocks;
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    list.splice(clamp(toIndex, 0, list.length), 0, item);
  });
  renderBlocks(ctx.host, cardId);
}

function toggleTodo(id) {
  const cardId = ctx.cardId;
  const nowChecked = !getBlock(id)?.checked;
  commit('toggle todo', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === id);
    if (t) t.checked = nowChecked;
  });
  const el = blockElById(id);
  el?.querySelector('.li-check')?.classList.toggle('on', nowChecked);
  el?.querySelector('.blk-body')?.classList.toggle('done', nowChecked);
  const check = el?.querySelector('.li-check');
  if (check && nowChecked) animate(check, [{ transform: 'scale(.7)' }, { transform: 'scale(1)' }], { duration: 200, easing: EASE.snap });
}

/* ---------------------------------------------------------------- dom lookup */

/** floating blocks live in the free layer, not the column — look in both */
export function allBlockEls() {
  return [...$$('.blk', ctx.host || document), ...$$('#page-free > .blk')];
}

export const blockElById = (id) => {
  if (!id) return null;
  const sel = `.blk[data-id="${CSS.escape(id)}"]`;
  return ctx.host?.querySelector(sel) || document.querySelector(`#page-free > ${sel}`) || null;
};
export const bodyOf = (id) => blockElById(id)?.querySelector('.blk-body') || null;

export function focusBlock(id, where = 'end') {
  const body = bodyOf(id);
  if (!body) return;
  body.focus({ preventScroll: false });
  placeCaret(body, where);
}

export function placeCaret(el, where = 'end') {
  const sel = getSelection();
  const range = document.createRange();
  if (where === 'start') { range.setStart(el, 0); range.collapse(true); }
  else if (typeof where === 'number') {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = where, node = null;
    while ((node = walker.nextNode())) {
      if (left <= node.length) { range.setStart(node, left); range.collapse(true); break; }
      left -= node.length;
    }
    if (!node) { range.selectNodeContents(el); range.collapse(false); }
  } else { range.selectNodeContents(el); range.collapse(false); }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function currentBody() {
  const node = getSelection()?.anchorNode;
  if (!node) return null;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el?.closest('.blk-body') || null;
}

export function currentBlockId() {
  return currentBody()?.closest('.blk')?.dataset.id || null;
}

function textBeforeCaret(body) {
  const sel = getSelection();
  if (!sel.rangeCount) return '';
  const range = sel.getRangeAt(0).cloneRange();
  range.setStart(body, 0);
  return range.toString();
}

function caretAtStart(body) {
  const sel = getSelection();
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) return false;
  const probe = r.cloneRange();
  probe.selectNodeContents(body);
  probe.setEnd(r.startContainer, r.startOffset);
  return probe.toString().length === 0;
}

function caretAtEnd(body) {
  const sel = getSelection();
  if (!sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) return false;
  const probe = r.cloneRange();
  probe.selectNodeContents(body);
  probe.setStart(r.endContainer, r.endOffset);
  return probe.toString().length === 0;
}

/* ---------------------------------------------------------------- binding */

function bindBody(body, blockId) {
  body.addEventListener('input', () => onInput(body, blockId));
  body.addEventListener('keydown', (e) => onKeyDown(e, body, blockId));
  body.addEventListener('paste', (e) => onPaste(e, body, blockId));
  body.addEventListener('blur', () => onBlur(body, blockId));
  body.addEventListener('focus', () => { ctx.host?.querySelectorAll('.blk.active').forEach((b) => b.classList.remove('active')); body.closest('.blk')?.classList.add('active'); });
}

function onInput(body, blockId) {
  const cardId = ctx.cardId;
  body.classList.toggle('is-empty', !(body.textContent || '').trim());
  const html = body.isContentEditable && body.tagName === 'CODE' ? body.textContent : body.innerHTML;
  commit('type', (b) => {
    const target = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (target) target.html = html;
  }, { coalesce: `type:${blockId}` });

  const text = body.textContent || '';
  if (text.startsWith('/') && !slashOpen()) openSlashMenu(body, blockId);
  else if (slashOpen() && !text.startsWith('/')) closeSlashMenu();
  bus.emit('page:reflow');
  lazyTagSync(cardId);
}

/* tags show up shortly after you stop typing — the dom decoration waits for
   blur so the caret is never yanked around mid-word */
const lazyTagSync = debounce((cardId) => {
  syncTags(cardId);
  bus.emit('page:tags');
}, 700);

function onBlur(body, blockId) {
  if (body.tagName === 'CODE') return;
  decorateTags(body);
  const cardId = ctx.cardId;
  const html = body.innerHTML;
  quietly((b) => {
    const target = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (target) target.html = html;
  });
  syncTags(cardId);
  bus.emit('page:tags');
}

/** wrap #tags so they read as tags — done on blur so the caret is never disturbed */
function decorateTags(body) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('[data-tag], a, code')) continue;
    const m = /(^|\s)(#[a-z0-9][a-z0-9_-]{0,28})/i.exec(node.nodeValue || '');
    if (m) hits.push({ node, index: m.index + m[1].length, length: m[2].length });
  }
  for (const hit of hits.reverse()) {
    const range = document.createRange();
    range.setStart(hit.node, hit.index);
    range.setEnd(hit.node, hit.index + hit.length);
    const span = document.createElement('span');
    span.setAttribute('data-tag', '');
    try { range.surroundContents(span); } catch { /* crossed a boundary, skip */ }
  }
}

/* ---------------------------------------------------------------- keys */

function onKeyDown(e, body, blockId) {
  const block = getBlock(blockId);
  if (!block) return;

  if (slashOpen() && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) return;  // toolbar handles it

  // ---- formatting
  if (modKey(e) && !e.altKey) {
    const key = e.key.toLowerCase();
    const map = { b: 'bold', i: 'italic', u: 'underline' };
    if (map[key]) { e.preventDefault(); exec(map[key]); return; }
    if (key === 'e') { e.preventDefault(); wrapSelection('code'); return; }
    if (e.shiftKey && key === 'x') { e.preventDefault(); exec('strikeThrough'); return; }
    if (key === 'enter') {
      e.preventDefault();
      if (block.type === 'todo') toggleTodo(blockId);
      return;
    }
  }

  // ---- enter
  if (e.key === 'Enter' && !e.shiftKey) {
    if (block.type === 'code') return;                       // newline inside code
    e.preventDefault();
    const text = body.textContent || '';
    if (LIST_TYPES.has(block.type) && !text.trim()) {        // empty list item exits the list
      if (block.indent) { setIndent(blockId, (block.indent || 0) - 1); return; }
      setType(blockId, 'p');
      return;
    }
    const atEnd = caretAtEnd(body);
    const nextType = LIST_TYPES.has(block.type) ? block.type : 'p';
    if (atEnd) {
      insertBlock(blockId, { type: nextType, indent: block.indent || 0 });
    } else {
      // split the block at the caret
      const range = getSelection().getRangeAt(0);
      const tail = range.cloneRange();
      tail.setEnd(body, body.childNodes.length);
      const frag = tail.extractContents();
      const holder = document.createElement('div');
      holder.append(frag);
      const head = body.innerHTML;
      const cardId = ctx.cardId;
      commit('split block', (b) => {
        const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
        if (t) t.html = head;
      });
      insertBlock(blockId, { type: nextType, indent: block.indent || 0, html: holder.innerHTML });
    }
    return;
  }

  // ---- backspace merging
  if (e.key === 'Backspace' && caretAtStart(body)) {
    if (block.indent) { e.preventDefault(); setIndent(blockId, block.indent - 1); return; }
    if (block.type !== 'p') { e.preventDefault(); setType(blockId, 'p'); return; }
    const at = blockIndex(blockId);
    const prev = blocksOf()[at - 1];
    if (!prev) return;
    e.preventDefault();
    // backspacing into a picture used to swallow it silently. now the first
    // press arms it (and says so), the second one deletes, and undo is offered.
    if (['image', 'divider', 'table', 'subpage'].includes(prev.type)) {
      const el = blockElById(prev.id);
      if (el && !el.classList.contains('arm-delete')) {
        el.classList.add('arm-delete');
        selectBlock(prev.id);
        toast(`backspace again to delete that ${prev.type === 'image' ? 'picture' : prev.type}`, { kind: 'warn', ms: 2600 });
        setTimeout(() => el.classList.remove('arm-delete'), 2800);
        return;
      }
      deleteBlock(prev.id, { focusPrev: false });
      clearBlockSelection();
      focusBlock(blockId, 'start');
      toast('deleted', { kind: 'ok', action: { label: 'undo', fn: () => undo() } });
      return;
    }
    const prevBody = bodyOf(prev.id);
    const offset = (prevBody?.textContent || '').length;
    const merged = (prev.html || '') + (block.html || '');
    const cardId = ctx.cardId;
    commit('merge blocks', (b) => {
      const list = b.cards[cardId].blocks;
      const target = list.find((x) => x.id === prev.id);
      if (target) target.html = merged;
      b.cards[cardId].blocks = list.filter((x) => x.id !== blockId);
    });
    blockElById(blockId)?.remove();
    if (prevBody) prevBody.innerHTML = merged;
    renumber();
    focusBlock(prev.id, offset);
    return;
  }

  // ---- delete forward merge
  if (e.key === 'Delete' && caretAtEnd(body)) {
    const at = blockIndex(blockId);
    const next = blocksOf()[at + 1];
    if (next && TEXT_TYPES.has(next.type)) {
      e.preventDefault();
      const offset = (body.textContent || '').length;
      const merged = (block.html || '') + (next.html || '');
      const cardId = ctx.cardId;
      commit('merge blocks', (b) => {
        const list = b.cards[cardId].blocks;
        const target = list.find((x) => x.id === blockId);
        if (target) target.html = merged;
        b.cards[cardId].blocks = list.filter((x) => x.id !== next.id);
      });
      blockElById(next.id)?.remove();
      body.innerHTML = merged;
      renumber();
      focusBlock(blockId, offset);
    }
    return;
  }

  // ---- tab indent
  if (e.key === 'Tab') {
    e.preventDefault();
    if (block.type === 'code') { document.execCommand('insertText', false, '  '); return; }
    setIndent(blockId, (block.indent || 0) + (e.shiftKey ? -1 : 1));
    return;
  }

  // ---- arrow between blocks
  if (e.key === 'ArrowUp' && caretAtStart(body)) {
    const prev = blocksOf()[blockIndex(blockId) - 1];
    if (prev && bodyOf(prev.id)) { e.preventDefault(); focusBlock(prev.id, 'end'); }
  }
  if (e.key === 'ArrowDown' && caretAtEnd(body)) {
    const next = blocksOf()[blockIndex(blockId) + 1];
    if (next && bodyOf(next.id)) { e.preventDefault(); focusBlock(next.id, 'start'); }
  }

  // ---- markdown shortcuts
  if (e.key === ' ' && state.settings.markdownShortcuts !== false && block.type !== 'code') {
    const before = textBeforeCaret(body).trim();
    const rules = {
      '#': ['h1'], '##': ['h2'], '###': ['h3'],
      '-': ['ul'], '*': ['ul'], '+': ['ul'],
      '1.': ['ol'], '1)': ['ol'],
      '[]': ['todo'], '[ ]': ['todo'],
      '>': ['quote'], '!': ['callout'],
      '```': ['code'], '---': ['divider'], '***': ['divider'],
    };
    const hit = rules[before];
    if (hit) {
      e.preventDefault();
      stripLeading(body, before.length);
      onInput(body, blockId);                                // keep the model in step before we re-render
      if (hit[0] === 'divider') { insertBlock(blockId, { type: 'p' }, true); setType(blockId, 'divider'); }
      else setType(blockId, hit[0], { indent: block.indent || 0 });
    }
  }
}

function stripLeading(body, count) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (node) node.nodeValue = node.nodeValue.slice(count);
  else body.innerHTML = '';
}

export function setIndent(blockId, value) {
  const next = clamp(value, 0, 6);
  const cardId = ctx.cardId;
  commit('indent', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.indent = next;
  });
  const el = blockElById(blockId);
  if (el) { el.dataset.indent = next; el.style.setProperty('--indent', next); }
  renumber();
  focusBlock(blockId, 'end');
}

/* ---------------------------------------------------------------- formatting */

export function exec(command, value = null) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand(command, false, value);
  const body = currentBody();
  const id = currentBlockId();
  if (body && id) onInput(body, id);
}

/** wrap the selection in a tag we control (code, mark, anchor spans) */
export function wrapSelection(tagName, attrs = {}) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const body = currentBody();
  if (!body) return null;
  const range = sel.getRangeAt(0);
  const node = document.createElement(tagName);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  try {
    node.append(range.extractContents());
    range.insertNode(node);
    sel.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(node);
    sel.addRange(after);
  } catch {
    return null;
  }
  const id = currentBlockId();
  if (id) onInput(body, id);
  return node;
}

export function clearFormatting() {
  exec('removeFormat');
  const body = currentBody();
  if (!body) return;
  for (const el of body.querySelectorAll('mark, code, [data-hl], [data-c]')) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
  }
  const id = currentBlockId();
  if (id) onInput(body, id);
}

export function isActive(command) {
  try { return document.queryCommandState(command); } catch { return false; }
}

/* ---------------------------------------------------------------- paste */

async function onPaste(e, body, blockId) {
  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find((i) => i.type.startsWith('image/'));
  if (imageItem) {
    e.preventDefault();
    const file = imageItem.getAsFile();
    const { insertImageFromFile } = await import('./images.js?v=7cc5d8f531');
    insertImageFromFile(file, blockId);
    return;
  }

  const html = e.clipboardData.getData('text/html');
  const text = e.clipboardData.getData('text/plain');
  e.preventDefault();

  if (html && body.tagName !== 'CODE') {
    const blocks = htmlToBlocks(html);
    if (blocks.length > 1) return pasteBlocks(blocks, blockId, body);
    if (blocks.length === 1) { document.execCommand('insertHTML', false, blocks[0].html); onInput(body, blockId); return; }
  }

  if (body.tagName === 'CODE') { document.execCommand('insertText', false, text); onInput(body, blockId); return; }

  const lines = text.split(/\r?\n/).filter((l, i, arr) => l.trim() || i < arr.length - 1);
  if (lines.length > 1) {
    return pasteBlocks(lines.map((line) => mdLineToBlock(line)), blockId, body);
  }
  document.execCommand('insertText', false, text);
  onInput(body, blockId);
}

function pasteBlocks(blocks, blockId, body) {
  const empty = !(body.textContent || '').trim();
  let anchor = blockId;
  if (empty && blocks.length) {
    const first = blocks.shift();
    setType(blockId, first.type, { indent: first.indent || 0 });
    const freshBody = bodyOf(blockId);
    if (freshBody) { freshBody.innerHTML = first.html; onInput(freshBody, blockId); }
  }
  for (const block of blocks) {
    const made = insertBlock(anchor, { type: block.type, html: block.html, indent: block.indent || 0, checked: block.checked }, false);
    anchor = made.id;
  }
  focusBlock(anchor, 'end');
  toast(`pasted ${blocks.length + (empty ? 1 : 0)} blocks`, { kind: 'ok', ms: 1600 });
}

/** turn arbitrary pasted html (google docs included) into our block list */
export function htmlToBlocks(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  host.querySelectorAll('style, script, meta, link').forEach((n) => n.remove());
  const out = [];

  const push = (type, node, extra = {}) => {
    const clean = sanitizeInline(node.innerHTML ?? node.textContent ?? '');
    if (!clean.trim() && type !== 'divider') return;
    out.push({ type, html: clean, ...extra });
  };

  const walk = (parent, indent = 0) => {
    for (const node of Array.from(parent.children)) {
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag)) push(tag === 'H1' ? 'h1' : tag === 'H2' ? 'h2' : 'h3', node);
      else if (tag === 'P' || tag === 'DIV') {
        if (node.querySelector('ul, ol, table, h1, h2, h3, p')) walk(node, indent);
        else push('p', node);
      }
      else if (tag === 'UL' || tag === 'OL') {
        for (const li of Array.from(node.children)) {
          if (li.tagName !== 'LI') continue;
          const nested = li.querySelector('ul, ol');
          const clone = li.cloneNode(true);
          clone.querySelectorAll('ul, ol').forEach((n) => n.remove());
          push(tag === 'UL' ? 'ul' : 'ol', clone, { indent });
          if (nested) walk(li, indent + 1);
        }
      }
      else if (tag === 'BLOCKQUOTE') push('quote', node);
      else if (tag === 'PRE') out.push({ type: 'code', html: node.textContent || '' });
      else if (tag === 'HR') out.push({ type: 'divider', html: '' });
      else if (tag === 'BR') continue;
      else if (node.children.length) walk(node, indent);
      else push('p', node);
    }
  };

  walk(host);
  if (!out.length) {
    const clean = sanitizeInline(host.innerHTML);
    if (clean.trim()) out.push({ type: 'p', html: clean });
  }
  return out;
}

function mdLineToBlock(line) {
  const trimmed = line.trim();
  let m;
  if ((m = /^(#{1,3})\s+(.*)$/.exec(trimmed))) return { type: `h${m[1].length}`, html: escapeInline(m[2]) };
  if ((m = /^[-*+]\s+\[( |x)\]\s+(.*)$/i.exec(trimmed))) return { type: 'todo', html: escapeInline(m[2]), checked: m[1].toLowerCase() === 'x' };
  if ((m = /^[-*+]\s+(.*)$/.exec(trimmed))) return { type: 'ul', html: escapeInline(m[1]) };
  if ((m = /^\d+[.)]\s+(.*)$/.exec(trimmed))) return { type: 'ol', html: escapeInline(m[1]) };
  if ((m = /^>\s?(.*)$/.exec(trimmed))) return { type: 'quote', html: escapeInline(m[1]) };
  if (/^(---|\*\*\*|___)$/.test(trimmed)) return { type: 'divider', html: '' };
  return { type: 'p', html: escapeInline(line) };
}

function escapeInline(text) {
  let out = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
           .replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>')
           .replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

/* ---------------------------------------------------------------- tables */

function tableEl(block) {
  const rows = block.rows || [['', ''], ['', '']];
  const table = h('table.blk-table');
  rows.forEach((row, r) => {
    const tr = h('tr');
    row.forEach((cell, c) => {
      const td = h(r === 0 && block.header !== false ? 'th' : 'td', {
        contenteditable: 'true', html: cell,
        on: {
          input: (e) => {
            const cardId = ctx.cardId, html = e.target.innerHTML;
            commit('table cell', (b) => {
              const t = b.cards[cardId].blocks.find((x) => x.id === block.id);
              if (t) t.rows[r][c] = html;
            }, { coalesce: `cell:${block.id}:${r}:${c}` });
          },
          keydown: (e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const cells = Array.from(table.querySelectorAll('th, td'));
              const i = cells.indexOf(e.target);
              const next = cells[i + (e.shiftKey ? -1 : 1)];
              if (next) { next.focus(); placeCaret(next, 'end'); }
              else if (!e.shiftKey) addRow(block.id);
            }
          },
        },
      });
      tr.append(td);
    });
    table.append(tr);
  });

  return h('div.blk-tablewrap',
    table,
    h('div.table-tools',
      h('button.btn.btn-sm.btn-ghost', { on: { click: () => addRow(block.id) } }, icon('plus', { size: 13 }), 'row'),
      h('button.btn.btn-sm.btn-ghost', { on: { click: () => addCol(block.id) } }, icon('plus', { size: 13 }), 'column')));
}

function addRow(blockId) {
  const cardId = ctx.cardId;
  commit('add row', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.rows.push(new Array(t.rows[0].length).fill(''));
  });
  refreshBlock(blockId);
}

function addCol(blockId) {
  const cardId = ctx.cardId;
  commit('add column', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.rows.forEach((r) => r.push(''));
  });
  refreshBlock(blockId);
}

export function refreshBlock(blockId) {
  const el = blockElById(blockId);
  const block = getBlock(blockId);
  if (!el || !block) return;
  const fresh = blockEl(block);
  el.replaceWith(fresh);
  renumber();
}

/* ---------------------------------------------------------------- block menu + drag */

export function blockMenu(blockId, anchor) {
  const block = getBlock(blockId);
  if (!block) return;
  const turn = (type, label, ico) => ({
    label, icon: ico, checked: block.type === type,
    onPick: () => setType(blockId, type),
  });
  contextMenu([
    { header: 'turn into' },
    turn('p', 'text', 'page'),
    turn('h1', 'heading 1', 'h1'),
    turn('h2', 'heading 2', 'h2'),
    turn('h3', 'heading 3', 'h3'),
    turn('ul', 'bullet list', 'listUl'),
    turn('ol', 'numbered list', 'listOl'),
    turn('todo', 'checklist', 'listCheck'),
    turn('quote', 'quote', 'quote'),
    turn('callout', 'callout', 'callout'),
    turn('code', 'code', 'codeTag'),
    { sep: true },
    { label: 'duplicate', icon: 'copy', hint: 'ctrl+d', onPick: () => duplicateBlock(blockId) },
    { label: 'delete', icon: 'trash', danger: true, hint: 'ctrl+⌫', onPick: () => deleteBlock(blockId) },
  ], { anchor });
}

export function duplicateBlock(blockId) {
  const block = getBlock(blockId);
  if (!block) return;
  const copy = JSON.parse(JSON.stringify(block));
  copy.id = uid('b');
  if (copy.pins) copy.pins = copy.pins.map((p) => ({ ...p, id: uid('pin') }));
  const cardId = ctx.cardId;
  commit('duplicate block', (b) => {
    const list = b.cards[cardId].blocks;
    list.splice(list.findIndex((x) => x.id === blockId) + 1, 0, copy);
  });
  const el = blockEl(copy);
  blockElById(blockId)?.after(el);
  renumber();
  animate(el, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 200 });
}

/* ---------------------------------------------------------------- drag anywhere

   pick a block up by its handle (or alt-drag it anywhere) and it follows the
   cursor. drop it back in the column and it re-flows into place; drop it out in
   the margins and it stays exactly where you let go.
*/

export function setFloat(blockId, pos) {
  const cardId = ctx.cardId;
  commit('float block', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.float = pos;
  });
  renderBlocks(ctx.host, cardId);
  bus.emit('page:reflow');
}

export function unfloat(blockId, index = null) {
  const cardId = ctx.cardId;
  commit('back into the text', (b) => {
    const list = b.cards[cardId].blocks;
    const i = list.findIndex((x) => x.id === blockId);
    if (i < 0) return;
    delete list[i].float;
    if (index !== null) {
      const [item] = list.splice(i, 1);
      list.splice(clamp(index > i ? index - 1 : index, 0, list.length), 0, item);
    }
  });
  renderBlocks(ctx.host, cardId);
  bus.emit('page:reflow');
}

function startFloatResize(e, blockId) {
  e.preventDefault();
  e.stopPropagation();
  const el = blockElById(blockId);
  const block = getBlock(blockId);
  if (!el || !block?.float) return;
  const startX = e.clientX;
  const w0 = block.float.w || el.getBoundingClientRect().width;
  let next = w0;

  const onMove = (ev) => {
    next = clamp(Math.round(w0 + (ev.clientX - startX) / zoomFactor()), 140, 900);
    el.style.width = `${next}px`;
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    const cardId = ctx.cardId;
    commit('resize block', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
      if (t?.float) t.float.w = next;
    });
    bus.emit('page:reflow');
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

const freeLayer = () => document.querySelector('#page-free');
const pageCanvas = () => document.querySelector('.page-plane');
const textColumn = () => document.querySelector('.page-main');
/* the plane is panned and scaled, so screen pixels and plane pixels differ */
function zoomFactor() {
  const plane = document.querySelector('.page-plane');
  if (!plane) return 1;
  try { return new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { return 1; }
}

function startBlockDrag(e, blockId) {
  if (e.button !== 0) return;
  const el = blockElById(blockId);
  const block = getBlock(blockId);
  if (!el || !block) return;
  e.preventDefault();

  const startX = e.clientX, startY = e.clientY;
  const first = el.getBoundingClientRect();
  const grab = { x: e.clientX - first.left, y: e.clientY - first.top };
  const width = first.width;
  const snap = state.settings.gridSnap !== false ? (state.settings.snapSize || 8) : 1;
  const indicator = h('div.drop-line');
  let moved = false;
  let dropInColumn = false;

  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;

    if (!moved) {
      moved = true;
      document.body.classList.add('dragging-block');
      el.classList.add('dragging', 'floating', 'lifted');
      el.style.width = `${Math.min(width, 620)}px`;
      freeLayer()?.append(el);
      ctx.host.append(indicator);
    }

    const canvasR = pageCanvas().getBoundingClientRect();
    const z = zoomFactor();
    el.style.left = `${Math.round((ev.clientX - grab.x - canvasR.left) / z / snap) * snap}px`;
    el.style.top = `${Math.round((ev.clientY - grab.y - canvasR.top) / z / snap) * snap}px`;

    const col = textColumn().getBoundingClientRect();
    dropInColumn = ev.clientX > col.left - 30 && ev.clientX < col.right + 30;
    indicator.style.display = dropInColumn ? '' : 'none';
    el.classList.toggle('will-flow', dropInColumn);

    if (!dropInColumn) return;
    const others = $$('.blk', ctx.host).filter((b) => b !== el);
    let target = null, before = false;
    for (const b of others) {
      const r = b.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { target = b; before = true; break; }
      target = b; before = false;
    }
    const hostR = ctx.host.getBoundingClientRect();
    if (target) {
      const r = target.getBoundingClientRect();
      indicator.style.top = `${(before ? r.top : r.bottom) - hostR.top}px`;
      indicator.dataset.target = target.dataset.id;
      indicator.dataset.before = String(before);
    } else {
      indicator.style.top = '0px';
      delete indicator.dataset.target;
    }
  };

  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!moved) return;
    document.body.classList.remove('dragging-block');
    el.classList.remove('dragging', 'lifted', 'will-flow');
    const targetId = indicator.dataset.target;
    const before = indicator.dataset.before === 'true';
    indicator.remove();

    if (dropInColumn) {
      let index = null;
      if (targetId) {
        const list = blocksOf();
        index = list.findIndex((b) => b.id === targetId) + (before ? 0 : 1);
      }
      unfloat(blockId, index);
      toast('back in the text', { ms: 1200 });
      return;
    }

    const canvasR = pageCanvas().getBoundingClientRect();
    const z = zoomFactor();
    setFloat(blockId, {
      x: Math.round((ev.clientX - grab.x - canvasR.left) / z / snap) * snap,
      y: Math.round((ev.clientY - grab.y - canvasR.top) / z / snap) * snap,
      w: Math.round(Math.min(width / z, 620)),
    });
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
