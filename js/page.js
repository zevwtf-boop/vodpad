/* the page surface — a document that also works in two dimensions:
   a main column, a margin gutter for side notes, and a free layer you can
   drop text anywhere on. */

import { $, $$, h, clear, uid, clamp, debounce, rafThrottle, fmtClock, stripHtml } from './util.js?v=440f02a293';
import { icon } from './icons.js?v=440f02a293';
import { mediaUrl } from './api.js?v=440f02a293';
import { state, card, commit, quietly, bus, cardTitle, childrenOf, makeCard, deleteCard, syncTags, allTags, setSetting } from './store.js?v=440f02a293';
import { registerSurface, go, openCardPage, toggleMap } from './nav.js?v=440f02a293';
import { renderBlocks, insertBlock, currentBlockId, currentBody, focusBlock, getBlock, blockElById, pageStats } from './editor.js?v=440f02a293';
import { initSelectionToolbar } from './toolbar.js?v=440f02a293';
import { contextMenu, toast, popover, promptDialog, confirmDialog } from './ui.js?v=440f02a293';
import { stagger, animate, ping, EASE } from './motion.js?v=440f02a293';
import { paintAnchors } from './anchors.js?v=440f02a293';
import { mountVideoPanel } from './video.js?v=440f02a293';
import { mountWhiteboard, activeTool, renderInk, paintZoomPill } from './whiteboard.js?v=440f02a293';

let host = null;
let sheet = null;
let toolbarReady = false;

registerSurface('page', {
  mount(el) {
    host = el;
    if (!toolbarReady) { initSelectionToolbar(); toolbarReady = true; }
    render();
  },
  unmount() { host = null; },
});

bus.on('replace', () => { if (host) render(); });
bus.on('page:tags', () => paintMeta());
bus.on('page:reflow', rafThrottle(() => { layoutSidenotes(); paintAnchors(); }));

export const pageSheet = () => sheet;

/* ---------------------------------------------------------------- the plane

   the document lives on an endless surface. the paper is only the part with
   margins — anything you drag off it keeps its place out in the open, and you
   pan and zoom the whole thing like a map.
*/

let viewport = null, plane = null;
let view = { x: 0, y: 0, z: 1 };
let spaceHeld = false;

export const pageZoom = () => view.z;
export const planeEl = () => plane;
export const pageViewport = () => viewport;

function centredView() {
  const vw = viewport?.clientWidth || 1200;
  const sw = sheet?.offsetWidth || 900;
  return { x: Math.max(20, Math.round((vw - sw) / 2)), y: 22, z: 1 };
}

function applyView() {
  if (!plane) return;
  plane.style.transform = `translate3d(${Math.round(view.x)}px, ${Math.round(view.y)}px, 0) scale(${view.z})`;
  paintZoomPill(view.z);
  paintStatus();
}

const persistView = rafThrottle(() => {
  const id = state.cardId;
  quietly((b) => { if (b.cards[id]) b.cards[id].pageView = { ...view }; });
});

export function panBy(dx, dy) {
  view.x += dx;
  view.y += dy;
  applyView();
  persistView();
}

export function setPageZoom(next, at = null) {
  const z = clamp(Number(next) || 1, 0.2, 3);
  if (at && viewport) {
    const r = viewport.getBoundingClientRect();
    const px = at.x - r.left, py = at.y - r.top;
    const scale = z / view.z;
    view.x = px - (px - view.x) * scale;
    view.y = py - (py - view.y) * scale;
  }
  view.z = z;
  applyView();
  persistView();
  bus.emit('page:reflow');
}

export function resetPageView() {
  view = centredView();
  if (plane) plane.style.transition = 'transform 320ms cubic-bezier(.22,.61,.36,1)';
  applyView();
  setTimeout(() => { if (plane) plane.style.transition = ''; }, 360);
  persistView();
}
export const resetPageZoom = resetPageView;

/** pan just enough to bring something on the plane into view */
export function ensureVisible(el, { margin = 90, smooth = true } = {}) {
  if (!el || !viewport) return;
  const v = viewport.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (r.top < v.top + margin) dy = v.top + margin - r.top;
  else if (r.bottom > v.bottom - margin) dy = Math.max(v.bottom - margin - r.bottom, v.top + margin - r.top);
  if (r.left < v.left + 40) dx = v.left + 40 - r.left;
  else if (r.right > v.right - 40) dx = Math.max(v.right - 40 - r.right, v.left + 40 - r.left);
  if (!dx && !dy) return;
  if (smooth && plane) plane.style.transition = 'transform 260ms cubic-bezier(.22,.61,.36,1)';
  panBy(dx, dy);
  setTimeout(() => { if (plane) plane.style.transition = ''; }, 300);
}

function caretIntoView() {
  const sel = getSelection();
  if (!sel?.rangeCount || !viewport) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r.height && !r.width) return;
  const v = viewport.getBoundingClientRect();
  let dy = 0;
  if (r.top < v.top + 70) dy = v.top + 70 - r.top;
  else if (r.bottom > v.bottom - 90) dy = v.bottom - 90 - r.bottom;
  if (dy) panBy(0, dy);
}

const caretWatch = debounce(() => {
  if (state.route.name === 'page' && document.activeElement?.isContentEditable) caretIntoView();
}, 140);

function bindPlane() {
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) setPageZoom(view.z * (e.deltaY < 0 ? 1.12 : 0.893), { x: e.clientX, y: e.clientY });
    else if (e.shiftKey) panBy(-e.deltaY, 0);
    else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false });

  viewport.addEventListener('pointerdown', (e) => {
    if (activeTool() !== 'select' && e.button === 0 && !spaceHeld) return;   // the whiteboard has the pointer
    const onContent = e.target.closest('.page-sheet, .blk, .freebox, .sidenote, .video-panel, .page-status, .wb-rail, .wb-options, .wb-zoom');
    const wantsPan = e.button === 1 || spaceHeld || (e.button === 0 && !onContent);
    if (!wantsPan) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = view.x, oy = view.y;
    viewport.classList.add('panning');
    const move = (ev) => { view.x = ox + (ev.clientX - sx); view.y = oy + (ev.clientY - sy); applyView(); };
    const up = () => {
      viewport.classList.remove('panning');
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      persistView();
      bus.emit('page:reflow');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });

  // double-click out in the open drops a text box exactly there
  viewport.addEventListener('dblclick', (e) => {
    if (activeTool() !== 'select') return;
    if (e.target.closest('.page-sheet, .blk, .freebox, .sidenote, .wb-rail, .wb-options, .wb-zoom')) return;
    addFreeBox({ x: e.clientX, y: e.clientY });
  });
}

addEventListener('keydown', (e) => { if (e.code === 'Space' && !e.target.isContentEditable && !/INPUT|TEXTAREA/.test(e.target.tagName)) spaceHeld = true; });
addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });
document.addEventListener('selectionchange', () => caretWatch());

/** a screen point in plane coordinates */
export function toPlane(clientX, clientY) {
  const r = plane.getBoundingClientRect();
  return { x: Math.round((clientX - r.left) / view.z), y: Math.round((clientY - r.top) / view.z) };
}

/* ---------------------------------------------------------------- status bar */

function statusBar() {
  return h('div.page-status#page-status',
    h('div.status-left',
      h('span.status-hint', { text: 'drag the background or hold space to pan · ctrl+wheel to zoom · v select, b pen, m marker, n note' })),
    h('div.status-right#status-right'));
}

export function paintStatus() {
  const bar = $('#page-status');
  if (!bar) return;
  const right = $('#status-right');
  if (!right) return;
  const s = pageStats(state.cardId);
  clear(right);
  // Element.append stringifies null into the literal text "null" — filter first
  right.append(...[
    h('span.status-item', { text: `${s.words} words` }),
    h('span.status-sep'),
    h('span.status-item', { text: `${s.blocks} blocks` }),
    s.pictures ? h('span.status-sep') : null,
    s.pictures ? h('span.status-item', { text: `${s.pictures} pictures` }) : null,
    s.todo ? h('span.status-sep') : null,
    s.todo ? h('span.status-item', { text: `${s.done}/${s.todo} done` }) : null,
  ].filter(Boolean));
}

/* ---------------------------------------------------------------- render */

export function render() {
  if (!host) return;
  const c = card(state.cardId);
  if (!c) return;

  clear(host);
  const shell = h('div.page-shell');
  if (state.settings.sidebar === false) shell.classList.add('side-closed');

  const work = h('div.page-work');
  viewport = h('div.page-viewport');
  plane = h('div.page-plane');
  sheet = h('div.page-sheet');

  sheet.append(pageTop(c));
  const canvas = h('div.page-canvas',
    h('div.page-cols',
      h('div.page-gutter.gutter-left#page-gutter-left'),
      h('div.page-main#page-main'),
      h('div.page-gutter.gutter-right#page-gutter')));
  sheet.append(canvas);
  sheet.append(kidsStrip(c));

  // free layer + connectors live on the plane, not inside the paper — that is
  // what lets a line of text be dragged off into open space and stay there
  plane.append(sheet, h('div.page-free#page-free'), svgLayer());
  viewport.append(plane);
  work.append(viewport, statusBar());
  shell.append(sideBar(), work);
  host.append(shell);
  mountVideoPanel(host);

  renderBlocks($('#page-main'), c.id);
  paintMeta();
  renderSidenotes();
  renderFreeBoxes();

  view = c.pageView ? { ...c.pageView } : centredView();
  applyView();
  bindPlane();
  mountWhiteboard(work, viewport, plane);
  renderInk();

  layoutSidenotes();
  paintAnchors();
  paintStatus();
  requestAnimationFrame(() => {
    stagger($$('.blk', sheet).slice(0, 12), { step: 18, distance: 8 });
    if (!c.pageView) { view = centredView(); applyView(); }
    layoutSidenotes();
    paintAnchors();
  });

  sheet.addEventListener('click', (e) => {
    // clicking the empty space under the doc puts the caret on a new last line
    if (e.target !== sheet && e.target !== canvas) return;
    const blocks = card(state.cardId).blocks;
    const last = blocks[blocks.length - 1];
    if (last && last.type === 'p' && !last.html) focusBlock(last.id, 'end');
    else if (last) insertBlock(last.id, { type: 'p' }, true);
  });
}

function svgLayer() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'page-links');
  svg.id = 'page-links';
  return svg;
}

/* ---------------------------------------------------------------- left rail

   outline to navigate a long page, a strip of every picture on it, and a
   grid of things to add — so nothing important is hidden behind a keystroke.
*/

let sideTab = 'outline';

function sideBar() {
  const aside = h('aside.page-side',
    h('div.side-head',
      h('div.side-tabs',
        ...[['outline', 'outline', 'listUl'], ['shots', 'pictures', 'image'], ['add', 'add', 'plus']]
          .map(([id, label, ico]) => h('button.side-tab', {
            class: sideTab === id ? 'on' : '', tip: label, data: { tab: id },
            on: { click: () => { sideTab = id; paintSide(); } },
          }, icon(ico, { size: 15 }), h('span', { text: label })))),
      h('button.icon-btn.side-collapse', {
        tip: 'hide this panel · ctrl+\\',
        on: { click: () => toggleSidebar() },
      }, icon('back', { size: 15 }))),
    h('div.side-body#side-body'),
    h('div.side-stats#side-stats'),
  );
  requestAnimationFrame(paintSide);
  setTimeout(paintSide, 0);
  return aside;
}

export function toggleFocusMode() {
  const on = !state.settings.focusMode;
  setSetting('focusMode', on);
  document.body.classList.toggle('focus-on', on);
  toast(on ? 'focus mode — everything but the line you are on fades back' : 'focus mode off', { ms: 1800 });
}

export function toggleSidebar() {
  const shell = $('.page-shell');
  if (!shell) return;
  const closing = !shell.classList.contains('side-closed');
  shell.classList.toggle('side-closed', closing);
  setSetting('sidebar', !closing);
  bus.emit('page:reflow');
}

export function paintSide() {
  const body = $('#side-body');
  if (!body) return;
  clear(body);
  const c = card(state.cardId);
  if (!c) return;

  if (sideTab === 'outline') paintOutline(body, c);
  else if (sideTab === 'shots') paintShots(body, c);
  else paintAddPalette(body, c);

  paintStats();
}

function paintOutline(body, c) {
  const rows = [];
  for (const block of c.blocks || []) {
    if (/^h[1-3]$/.test(block.type)) {
      const text = stripHtml(block.html).trim();
      rows.push({ id: block.id, level: Number(block.type[1]), text: text || 'untitled heading', kind: 'head', folded: block.folded });
    } else if (block.type === 'subpage') {
      const kid = card(block.cardId);
      if (kid) rows.push({ id: block.id, level: 2, text: cardTitle(kid), kind: 'sub', cardId: kid.id });
    }
  }

  if (!rows.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'headings show up here as you write them.' }),
      h('button.btn.btn-sm', { on: { click: () => addHeading() } }, icon('h2', { size: 13 }), 'add a heading')));
    return;
  }

  const list = h('div.side-list');
  for (const row of rows) {
    list.append(h('button.side-row', {
      class: `lvl-${row.level} ${row.kind}`,
      data: { block: row.id },
      on: {
        click: () => row.kind === 'sub' ? openCardPage(row.cardId) : jumpToBlock(row.id),
        contextmenu: (e) => { e.preventDefault(); blockElById(row.id)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })); },
      },
    },
      row.kind === 'sub' ? h('span.side-ico', icon('cards', { size: 12 })) : h('span.side-dash'),
      h('span.side-text', { text: row.text }),
      row.folded ? h('span.side-ico', icon('collapse', { size: 12 })) : null));
  }
  body.append(list);
  markOutlinePosition();
}

function paintShots(body, c) {
  const shots = (c.blocks || []).filter((b) => b.type === 'image' && b.src);
  if (!shots.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'paste a screenshot with ctrl+v and it lands here.' }),
      h('button.btn.btn-sm', { on: { click: async () => (await import('./images.js?v=440f02a293')).pickImageFile(card(state.cardId).blocks.at(-1)?.id) } },
        icon('image', { size: 13 }), 'add a picture')));
    return;
  }
  const grid = h('div.side-shots');
  shots.forEach((block, i) => {
    grid.append(h('button.side-shot', {
      tip: stripHtml(block.caption || '') || `picture ${i + 1}`,
      on: { click: () => jumpToBlock(block.id) },
    },
      h('img', { src: mediaUrl(state.board.id, block.src), loading: 'lazy', alt: '' }),
      (block.pins || []).length ? h('span.side-shot-pins', { text: String(block.pins.length) }) : null));
  });
  body.append(grid);
}

function paintAddPalette(body, c) {
  const lastId = () => card(state.cardId).blocks.at(-1)?.id;
  const at = () => currentBlockId() || lastId();

  const add = async (type, extra) => {
    const ed = await import('./editor.js?v=440f02a293');
    const made = ed.insertBlock(at(), { type: 'p' }, false);
    if (type === 'p') { ed.focusBlock(made.id, 'end'); return; }
    ed.setType(made.id, type, extra);
  };

  const items = [
    ['text', 'page', () => add('p')],
    ['heading', 'h2', () => add('h2')],
    ['small head', 'h3', () => add('h3')],
    ['bullets', 'listUl', () => add('ul')],
    ['numbered', 'listOl', () => add('ol')],
    ['checklist', 'listCheck', () => add('todo')],
    ['quote', 'quote', () => add('quote')],
    ['callout', 'callout', () => add('callout')],
    ['code', 'codeTag', () => add('code')],
    ['divider', 'divider', () => add('divider')],
    ['table', 'table', () => add('table', { rows: [['', '', ''], ['', '', ''], ['', '', '']], header: true })],
    ['picture', 'image', async () => (await import('./images.js?v=440f02a293')).pickImageFile(at())],
    ['text box', 'textbox', () => addFreeBox()],
    ['margin note', 'sidenote', () => addSidenoteFromSelection()],
    ['sub-page', 'cards', () => addSubPage(at())],
    ['timestamp', 'clock', async () => (await import('./video.js?v=440f02a293')).insertTimestamp(at())],
  ];

  body.append(h('div.side-grid', ...items.map(([label, ico, run]) => h('button.side-add', {
    on: { click: run },
  }, icon(ico, { size: 16 }), h('span', { text: label })))));

  body.append(h('div.side-note', { text: 'or type / on an empty line — same list, without moving your hands.' }));
}

function paintStats() {
  const host = $('#side-stats');
  if (!host) return;
  clear(host);
  const s = pageStats(state.cardId);
  const bits = [
    [`${s.words}`, s.words === 1 ? 'word' : 'words'],
    [`${s.blocks}`, 'blocks'],
    [`${s.pictures}`, s.pictures === 1 ? 'picture' : 'pictures'],
  ];
  if (s.todo) bits.push([`${s.done}/${s.todo}`, 'done']);
  for (const [n, label] of bits) host.append(h('div.side-stat', h('b', { text: n }), h('span', { text: label })));
}

function jumpToBlock(blockId) {
  const el = blockElById(blockId);
  if (!el) return;
  ensureVisible(el, { margin: 160 });
  ping(el);
  const body = el.querySelector('.blk-body');
  if (body) setTimeout(() => focusBlock(blockId, 'end'), 300);
}

export function markOutlinePosition() {
  const list = $('.side-list');
  if (!list || !viewport) return;
  const line = viewport.getBoundingClientRect().top + 90;
  let active = null;
  for (const row of list.children) {
    const el = blockElById(row.dataset.block);
    if (el && el.getBoundingClientRect().top <= line) active = row;
  }
  for (const row of list.children) row.classList.toggle('here', row === active);
}

async function addHeading() {
  const ed = await import('./editor.js?v=440f02a293');
  const last = card(state.cardId).blocks.at(-1)?.id;
  const made = ed.insertBlock(last, { type: 'p' }, false);
  ed.setType(made.id, 'h2');
}

/* ---------------------------------------------------------------- header */

function pageTop(c) {
  const isRoot = !c.parent;
  const title = h('h1.page-title', {
    contenteditable: 'true',
    spellcheck: 'false',
    'data-ph': isRoot ? 'session title' : 'topic title',
    text: c.title || (isRoot ? state.board.title : ''),
    on: {
      input: (e) => {
        const text = e.target.textContent.trim();
        commit('title', (b) => {
          b.cards[c.id].title = text;
          if (isRoot) b.title = text;
        }, { coalesce: `title:${c.id}` });
        if (isRoot) $('#tb-title').textContent = text;
      },
      keydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = card(state.cardId).blocks[0];
          if (first) focusBlock(first.id, 'start');
        }
      },
      blur: () => { bus.emit('boards'); },
    },
  });

  return h('header.page-top',
    title,
    h('div.page-meta#page-meta'),
  );
}

function paintMeta() {
  const wrap = $('#page-meta');
  if (!wrap) return;
  const c = card(state.cardId);
  if (!c) return;
  clear(wrap);

  wrap.append(sevPicker(c));

  const tags = c.tags || [];
  wrap.append(h('div.meta-tags',
    ...tags.map((t) => h('button.chip.chip-tag', {
      text: t, tip: 'filter the map by this tag',
      on: { click: () => { state.filter.tags = new Set([t]); go({ name: 'board', boardId: state.board.id, cardId: state.cardId }); } },
    })),
    h('button.chip.chip-add', { tip: 'add a tag', on: { click: (e) => tagMenu(e.currentTarget) } }, icon('plus', { size: 12 }), tags.length ? '' : 'tag')));

  if (c.t !== null && c.t !== undefined) {
    wrap.append(h('button.chip.chip-time', {
      tip: 'jump the video here',
      on: { click: async () => (await import('./video.js?v=440f02a293')).seekTo(c.t) },
    }, icon('clock', { size: 12 }), fmtClock(c.t)));
  }

  const kids = childrenOf(c.id).length;
  wrap.append(h('div.meta-right',
    kids ? h('button.chip', { tip: 'see them on the map', on: { click: () => toggleMap() } }, icon('grid', { size: 12 }), `${kids} sub-page${kids === 1 ? '' : 's'}`) : null,
    h('button.chip', { tip: 'more', on: { click: (e) => pageMenu(e.currentTarget) } }, icon('dots', { size: 13 }))));
}

function sevPicker(c) {
  const labels = ['no flag', 'working on it', 'costs me games', 'fixed — keep doing it'];
  const wrap = h('div.sev-picker');
  for (let lvl = 0; lvl <= 3; lvl++) {
    wrap.append(h('button.sev-btn', {
      class: `${(c.severity || 0) === lvl ? 'on' : ''} sev-${lvl}`,
      tip: `${labels[lvl]} · press ${lvl + 1}`,
      on: { click: () => setSeverity(c.id, lvl) },
    }, lvl === 0 ? icon('minus', { size: 11 }) : h('span.sev-dot', { class: `sev-${lvl}` })));
  }
  return wrap;
}

export function setSeverity(cardId, level) {
  commit('severity', (b) => { b.cards[cardId].severity = level; });
  paintMeta();
  const el = $('.sev-picker');
  if (el) animate(el, [{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 200, easing: EASE.snap });
  bus.emit('boards');
}

function tagMenu(anchor) {
  const c = card(state.cardId);
  const existing = allTags().map(([t]) => t).filter((t) => !(c.tags || []).includes(t));
  const input = h('input.field', { placeholder: 'new tag…', spellcheck: false });
  const list = h('div.tag-pop-list', ...existing.slice(0, 8).map((t) => h('button.menu-row', {
    on: { click: () => { addTag(t); import('./ui.js?v=440f02a293').then((m) => m.closePopover()); } },
  }, h('span.menu-ico', { text: '#' }), h('span.menu-label', { text: t }))));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
      if (value) addTag(value);
      import('./ui.js?v=440f02a293').then((m) => m.closePopover());
    }
  });
  popover(h('div.tag-pop', input, existing.length ? list : null), { anchor, width: 210 });
  setTimeout(() => input.focus(), 40);
}

function addTag(tag) {
  const id = state.cardId;
  commit('tag', (b) => {
    const c = b.cards[id];
    c.tags = [...new Set([...(c.tags || []), tag])];
  });
  paintMeta();
  bus.emit('boards');
}

function pageMenu(anchor) {
  const c = card(state.cardId);
  contextMenu([
    { label: 'open the map', icon: 'grid', hint: 'ctrl+b', onPick: () => toggleMap() },
    { label: 'read mode', icon: 'book', hint: 'ctrl+r', onPick: async () => (await import('./readmode.js?v=440f02a293')).openReader() },
    { sep: true },
    { label: 'add a sub-page', icon: 'cards', onPick: () => addSubPage(null) },
    { label: 'floating text box', icon: 'textbox', hint: 'ctrl+shift+t', onPick: () => addFreeBox() },
    { sep: true },
    { label: 'export markdown', icon: 'download', onPick: async () => (await import('./exporter.js?v=440f02a293')).exportMarkdown(c.id) },
    { label: 'export html', icon: 'download', onPick: async () => (await import('./exporter.js?v=440f02a293')).exportHtml(c.id) },
    { label: 'export the whole session (.vodpad)', icon: 'download', onPick: async () => (await import('./transfer.js?v=440f02a293')).exportSession(state.board.id) },
    ...(c.parent ? [{ sep: true }, { label: 'delete this page', icon: 'trash', danger: true, onPick: () => removePage(c) }] : []),
  ], { anchor, align: 'end' });
}

async function removePage(c) {
  const ok = await confirmDialog({ title: `delete "${cardTitle(c)}"?`, body: 'its sub-pages go with it.', okLabel: 'delete', danger: true });
  if (!ok) return;
  const parent = c.parent;
  deleteCard(c.id);
  go({ name: 'page', boardId: state.board.id, cardId: parent });
}

/* ---------------------------------------------------------------- sub-pages */

export function addSubPage(afterBlockId) {
  const parentId = state.cardId;
  const kid = makeCard(parentId, { title: '' });
  const anchor = afterBlockId || card(parentId).blocks.at(-1)?.id;
  insertBlock(anchor, { type: 'subpage', cardId: kid.id }, false);
  renderKids();
  paintMeta();
  toast('sub-page added — click it to dive in', { kind: 'ok', ms: 2200 });
  return kid;
}

function kidsStrip(c) {
  const wrap = h('div.page-kids#page-kids');
  paintKids(wrap, c);
  return wrap;
}

export function renderKids() {
  const wrap = $('#page-kids');
  if (wrap) paintKids(wrap, card(state.cardId));
}

function paintKids(wrap, c) {
  clear(wrap);
  const kids = childrenOf(c.id);
  wrap.append(h('div.kids-head',
    h('span.kids-title', { text: kids.length ? 'sub-pages' : '' }),
    h('button.btn.btn-sm.btn-ghost', { on: { click: () => addSubPage(null) } }, icon('plus', { size: 13 }), 'sub-page')));
  if (!kids.length) return;
  const grid = h('div.kids-grid', ...kids.map((kid) => {
    const el = h('button.kid-card', {
      on: {
        click: () => openCardPage(kid.id, el),
        contextmenu: (e) => { e.preventDefault(); kidMenu(kid, e.clientX, e.clientY); },
      },
    },
      h('span.kid-bar', { class: `sev-${kid.severity || 0}` }),
      h('div.kid-meat',
        h('div.kid-title', { text: cardTitle(kid) }),
        h('div.kid-meta', { text: `${(kid.blocks || []).length} blocks${childrenOf(kid.id).length ? ` · ${childrenOf(kid.id).length} inside` : ''}` })),
      h('span.kid-go', icon('chevron', { size: 14 })));
    return el;
  }));
  wrap.append(grid);
}

function kidMenu(kid, x, y) {
  contextMenu([
    { label: 'open', icon: 'forward', onPick: () => openCardPage(kid.id) },
    { label: 'rename', icon: 'pen', onPick: async () => {
      const name = await promptDialog({ title: 'rename sub-page', value: kid.title || '' });
      if (name === null) return;
      commit('rename', (b) => { b.cards[kid.id].title = name; });
      renderKids();
    } },
    { sep: true },
    { label: 'delete', icon: 'trash', danger: true, onPick: () => { deleteCard(kid.id); renderKids(); render(); } },
  ], { x, y });
}

/* ---------------------------------------------------------------- side notes */

export function addSidenoteFromSelection() {
  const body = currentBody();
  const blockId = currentBlockId();
  if (!body || !blockId) { toast('put the cursor on a line first', { kind: 'warn' }); return; }

  const noteId = uid('sn');
  const sel = getSelection();
  if (sel && !sel.isCollapsed) {
    import('./editor.js?v=440f02a293').then((ed) => ed.wrapSelection('span', { 'data-side': noteId }));
  } else {
    const mark = document.createElement('span');
    mark.setAttribute('data-side', noteId);
    mark.textContent = '';
    body.append(mark);
    const cardId = state.cardId, html = body.innerHTML;
    quietly((b) => { const t = b.cards[cardId].blocks.find((x) => x.id === blockId); if (t) t.html = html; });
  }

  const cardId = state.cardId;
  commit('margin note', (b) => {
    (b.cards[cardId].side ||= []).push({ id: noteId, blockId, html: '' });
  });
  renderSidenotes();
  requestAnimationFrame(() => {
    const el = $(`.sidenote[data-id="${noteId}"] .sidenote-body`);
    if (el) { el.focus(); ping(el.closest('.sidenote')); }
  });
}

function renderSidenotes() {
  const gutter = $('#page-gutter');
  if (!gutter) return;
  clear(gutter);
  const c = card(state.cardId);
  for (const note of c.side || []) gutter.append(sidenoteEl(note));
  layoutSidenotes();
}

function sidenoteEl(note) {
  const body = h('div.sidenote-body', {
    contenteditable: 'true',
    html: note.html || '',
    'data-ph': 'note in the margin…',
    on: {
      input: (e) => {
        const cardId = state.cardId, html = e.target.innerHTML;
        commit('margin note', (b) => {
          const n = (b.cards[cardId].side || []).find((x) => x.id === note.id);
          if (n) n.html = html;
        }, { coalesce: `side:${note.id}` });
        layoutSidenotes();
      },
      focus: () => highlightAnchor(note.id, true),
      blur: () => highlightAnchor(note.id, false),
    },
  });

  const el = h('aside.sidenote', { data: { id: note.id } },
    h('span.sidenote-tick'),
    body,
    h('button.sidenote-x.icon-btn', { tip: 'remove note', on: { click: () => removeSidenote(note.id) } }, icon('close', { size: 12 })));

  el.addEventListener('mouseenter', () => highlightAnchor(note.id, true));
  el.addEventListener('mouseleave', () => highlightAnchor(note.id, false));
  return el;
}

function highlightAnchor(noteId, on) {
  const mark = sheet?.querySelector(`[data-side="${CSS.escape(noteId)}"]`);
  mark?.classList.toggle('side-lit', on);
  sheet?.querySelector(`.sidenote[data-id="${CSS.escape(noteId)}"]`)?.classList.toggle('lit', on);
}

export function removeSidenote(noteId) {
  const cardId = state.cardId;
  const mark = sheet?.querySelector(`[data-side="${CSS.escape(noteId)}"]`);
  if (mark) {
    const blockEl = mark.closest('.blk');
    while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
    mark.remove();
    const blockId = blockEl?.dataset.id;
    const html = blockEl?.querySelector('.blk-body')?.innerHTML;
    if (blockId && html !== undefined) {
      quietly((b) => { const t = b.cards[cardId].blocks.find((x) => x.id === blockId); if (t) t.html = html; });
    }
  }
  commit('remove margin note', (b) => {
    b.cards[cardId].side = (b.cards[cardId].side || []).filter((n) => n.id !== noteId);
  });
  renderSidenotes();
}

/** stack the notes so they sit beside their line without overlapping each other */
export function layoutSidenotes() {
  const gutter = $('#page-gutter');
  const canvas = $('.page-canvas');
  if (!gutter || !canvas) return;
  const z = view.z || 1;
  const base = canvas.getBoundingClientRect().top;
  let floor = 0;
  for (const el of gutter.children) {
    const id = el.dataset.id;
    const mark = sheet.querySelector(`[data-side="${CSS.escape(id)}"]`);
    const note = (card(state.cardId).side || []).find((n) => n.id === id);
    const target = mark || (note?.blockId ? blockElById(note.blockId) : null);
    const top = target ? (target.getBoundingClientRect().top - base) / z : floor;
    const y = Math.max(top, floor);
    el.style.transform = `translateY(${Math.max(0, Math.round(y))}px)`;
    floor = y + el.offsetHeight + 10;
  }
}

/* ---------------------------------------------------------------- free boxes */

export function addFreeBox(at = null) {
  const cardId = state.cardId;
  const spot = at ? toPlane(at.x, at.y) : toPlane(
    (viewport.getBoundingClientRect().left + viewport.clientWidth * 0.78),
    (viewport.getBoundingClientRect().top + 160));
  const box = { id: uid('fb'), x: spot.x, y: spot.y, w: 210, h: 96, html: '' };
  return placeBox(box, cardId);
}

/** a webex-style sticky note: same free box, bright paper, dark ink */
export function addStickyAt(planePoint, colour) {
  const cardId = state.cardId;
  const box = {
    id: uid('fb'), kind: 'sticky', colour,
    x: Math.round(planePoint.x - 90), y: Math.round(planePoint.y - 70),
    w: 180, h: 140, html: '',
  };
  return placeBox(box, cardId);
}

function placeBox(box, cardId) {
  commit(box.kind === 'sticky' ? 'sticky note' : 'text box', (b) => { (b.cards[cardId].free ||= []).push(box); });
  renderFreeBoxes();
  const el = $(`.freebox[data-id="${box.id}"]`);
  el?.querySelector('.freebox-body')?.focus();
  if (el) animate(el, [{ opacity: 0, transform: 'scale(.88) rotate(-1.5deg)' }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE.snap });
  return box;
}

function renderFreeBoxes() {
  const layer = $('#page-free');
  if (!layer) return;
  for (const old of layer.querySelectorAll(':scope > .freebox')) old.remove();   // floating blocks live here too
  for (const box of card(state.cardId).free || []) layer.append(freeBoxEl(box));
}

function freeBoxEl(box) {
  const sticky = box.kind === 'sticky';
  const body = h('div.freebox-body', {
    contenteditable: 'true',
    html: box.html || '',
    'data-ph': sticky ? 'sticky note…' : 'anything you want, anywhere you want',
    on: {
      input: (e) => {
        const cardId = state.cardId, html = e.target.innerHTML;
        commit('text box', (b) => {
          const t = (b.cards[cardId].free || []).find((x) => x.id === box.id);
          if (t) t.html = html;
        }, { coalesce: `free:${box.id}` });
      },
    },
  });

  const el = h('div.freebox', {
    class: sticky ? 'sticky' : '',
    data: { id: box.id },
    style: {
      left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, minHeight: `${box.h}px`,
      ...(sticky ? { background: box.colour || '#ffd54a' } : {}),
    },
  },
    h('div.freebox-grip', { tip: 'drag me', on: { pointerdown: (e) => dragFreeBox(e, box.id) } }, icon('grip', { size: 13 })),
    body,
    h('button.freebox-x.icon-btn', { tip: 'delete', on: { click: () => removeFreeBox(box.id) } }, icon('close', { size: 12 })),
    h('div.freebox-resize', { on: { pointerdown: (e) => resizeFreeBox(e, box.id) } }),
  );
  if (sticky) {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      import('./whiteboard.js?v=440f02a293').then(({ STICKY_COLOURS }) => {
        contextMenu([
          { row: STICKY_COLOURS.map((c) => ({ icon: 'callout', color: c, tip: 'recolour', onPick: () => {
            const cardId = state.cardId;
            commit('sticky colour', (b) => {
              const t = (b.cards[cardId].free || []).find((x) => x.id === box.id);
              if (t) t.colour = c;
            });
            renderFreeBoxes();
          } })) },
          { sep: true },
          { label: 'duplicate', icon: 'copy', onPick: () => duplicateFreeBox(box.id) },
          { label: 'delete note', icon: 'trash', danger: true, onPick: () => removeFreeBox(box.id) },
        ], { x: e.clientX, y: e.clientY });
      });
    });
  }
  return el;
}

export function removeFreeBox(id) {
  const cardId = state.cardId;
  commit('remove text box', (b) => {
    b.cards[cardId].free = (b.cards[cardId].free || []).filter((f) => f.id !== id);
  });
  renderFreeBoxes();
}

export function duplicateFreeBox(id) {
  const cardId = state.cardId;
  const source = (card(cardId).free || []).find((f) => f.id === id);
  if (!source) return;
  const copy = { ...source, id: uid('fb'), x: source.x + 24, y: source.y + 24 };
  commit('duplicate text box', (b) => { b.cards[cardId].free.push(copy); });
  renderFreeBoxes();
}

function dragFreeBox(e, id) {
  e.preventDefault();
  const el = $(`.freebox[data-id="${id}"]`);
  const layer = $('#page-free');
  const box = (card(state.cardId).free || []).find((f) => f.id === id);
  if (!el || !box) return;
  const startX = e.clientX, startY = e.clientY;
  const originX = box.x, originY = box.y;
  const snap = state.settings.gridSnap !== false ? (state.settings.snapSize || 8) : 1;
  el.classList.add('moving');

  const guides = h('div.free-guides');
  layer.append(guides);

  const onMove = (ev) => {
    let x = originX + (ev.clientX - startX) / view.z;
    let y = originY + (ev.clientY - startY) / view.z;
    x = Math.round(x / snap) * snap;
    y = Math.round(y / snap) * snap;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    box._x = x; box._y = y;
    ensureVisible(el, { margin: 40, smooth: false });
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    el.classList.remove('moving');
    guides.remove();
    const cardId = state.cardId;
    const nx = box._x ?? box.x, ny = box._y ?? box.y;
    commit('move text box', (b) => {
      const t = (b.cards[cardId].free || []).find((f) => f.id === id);
      if (t) { t.x = nx; t.y = ny; }
    });
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function resizeFreeBox(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const el = $(`.freebox[data-id="${id}"]`);
  const box = (card(state.cardId).free || []).find((f) => f.id === id);
  if (!el || !box) return;
  const startX = e.clientX, startY = e.clientY, w0 = box.w, h0 = box.h;
  const onMove = (ev) => {
    const w = clamp(w0 + (ev.clientX - startX) / view.z, 120, 640);
    const hh = clamp(h0 + (ev.clientY - startY) / view.z, 60, 900);
    el.style.width = `${w}px`;
    el.style.minHeight = `${hh}px`;
    box._w = w; box._h = hh;
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    const cardId = state.cardId;
    const nw = box._w ?? box.w, nh = box._h ?? box.h;
    commit('resize text box', (b) => {
      const t = (b.cards[cardId].free || []).find((f) => f.id === id);
      if (t) { t.w = nw; t.h = nh; }
    });
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- misc */

bus.on('board:open', () => { if (host) render(); });
bus.on('page:meta', () => paintMeta());
bus.on('page:outline', () => { if (host) paintSide(); });
bus.on('mutate', debounce(() => { if (host) { renderKids(); paintSide(); } }, 700));

export function refreshPage() { render(); }
