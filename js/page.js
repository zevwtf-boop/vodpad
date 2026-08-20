/* the page surface — a document that also works in two dimensions:
   a main column, a margin gutter for side notes, and a free layer you can
   drop text anywhere on. */

import { $, $$, h, clear, uid, clamp, debounce, rafThrottle, fmtClock, stripHtml } from './util.js?v=d258d51ea6';
import { icon } from './icons.js?v=d258d51ea6';
import { mediaUrl } from './api.js?v=d258d51ea6';
import { stampsOnCard, tidy, clipLines } from './stamps.js?v=d258d51ea6';
import { state, card, commit, quietly, bus, cardTitle, childrenOf, makeCard, deleteCard, syncTags, allTags, setSetting, SEV_LABEL, SEV_ORDER } from './store.js?v=d258d51ea6';
import { registerSurface, go, openCardPage, toggleMap } from './nav.js?v=d258d51ea6';
import { renderBlocks, insertBlock, currentBlockId, currentBody, focusBlock, getBlock, blockElById, pageStats } from './editor.js?v=d258d51ea6';
import { initSelectionToolbar } from './toolbar.js?v=d258d51ea6';
import { contextMenu, toast, popover, promptDialog, confirmDialog } from './ui.js?v=d258d51ea6';
import { stagger, animate, ping, EASE } from './motion.js?v=d258d51ea6';
import { paintAnchors } from './anchors.js?v=d258d51ea6';
import { paintWires, startWire, cancelWire, wiring } from './wires.js?v=d258d51ea6';
import { mountVideoPanel } from './video.js?v=d258d51ea6';
import { mountWhiteboard, activeTool, renderInk, paintZoomPill } from './whiteboard.js?v=d258d51ea6';
import { renderShapes, startMarquee, addShapeAt, addShape, clearShapeSelection, tidySelection, shapesOf, syncZoom, selectShape } from './shapes.js?v=d258d51ea6';

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
bus.on('page:reflow', rafThrottle(() => { layoutSidenotes(); paintAnchors(); paintWires(); }));

export const pageSheet = () => sheet;

/* ---------------------------------------------------------------- the plane

   the document lives on an endless surface. the paper is only the part with
   margins — anything you drag off it keeps its place out in the open, and you
   pan and zoom the whole thing like a map.
*/

let viewport = null, plane = null;
let view = { x: 0, y: 0, z: 1 };
let spaceHeld = false;
/* bumped by anything that deliberately moves the view. render() re-centres a
   page that has never been panned one frame later, and this is what stops
   that late frame from throwing away a zoom or a fit you asked for in
   between. */
let viewTouch = 0;

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
  viewTouch++;
  view.x += dx;
  view.y += dy;
  applyView();
  persistView();
}

export function setPageZoom(next, at = null) {
  viewTouch++;
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
  syncZoom();
  bus.emit('page:reflow');
}

/** zoom and pan so the paper *and* everything on the board is on screen at
 *  once. on an endless plane this is the only way back from "where did i put
 *  that box" without hunting for it. */
export function fitBoard() {
  if (!viewport || !sheet) return;
  viewTouch++;
  const c = card(state.cardId);
  const boxes = shapesOf(c);
  const onPlane = sheet.isConnected;
  let l = 0, t = 0;
  let r = onPlane ? sheet.offsetWidth : 0;
  let b = onPlane ? sheet.offsetHeight : 0;
  for (const s of boxes) {
    l = Math.min(l, s.x); t = Math.min(t, s.y);
    r = Math.max(r, s.x + s.w); b = Math.max(b, s.y + s.h);
  }
  if (!boxes.length && !onPlane) { resetPageView(); return; }
  const pad = 46;
  const w = Math.max(200, r - l), hh = Math.max(200, b - t);
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  // fitting means "show me everything", never "magnify it" — 1 is the ceiling
  const z = clamp(Math.min((vw - pad * 2) / w, (vh - pad * 2) / hh), 0.2, 1);
  view = { z, x: (vw - w * z) / 2 - l * z, y: (vh - hh * z) / 2 - t * z };
  if (plane) plane.style.transition = 'transform 320ms cubic-bezier(.22,.61,.36,1)';
  applyView();
  syncZoom();
  setTimeout(() => { if (plane) plane.style.transition = ''; }, 360);
  persistView();
  bus.emit('page:reflow');
}

/** put a box on screen and select it — what the outline list clicks through to */
export function jumpToShape(id) {
  selectShape(id);
  const el = document.querySelector(`.shape[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  ensureVisible(el, { margin: 120 });
  ping(el);
}

export function resetPageView() {
  viewTouch++;
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
    const onContent = e.target.closest('.page-sheet, .blk, .freebox, .sidenote, .shape, .shape-groupbar, .video-panel, .page-status, .wb-rail, .wb-options, .wb-zoom');

    // shift+drag on open plane rubber-bands a selection instead of panning.
    // plain drag still pans, because that is the muscle memory this page has
    // always had and nothing about it should change under people.
    if (e.button === 0 && !onContent && e.shiftKey && !spaceHeld) {
      e.preventDefault();
      startMarquee(e);
      return;
    }

    const wantsPan = e.button === 1 || spaceHeld || (e.button === 0 && !onContent);
    if (!wantsPan) return;
    if (e.button === 0 && !onContent) clearShapeSelection();
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

  // double-click out in the open drops a box exactly there, ready to type in
  viewport.addEventListener('dblclick', (e) => {
    if (activeTool() !== 'select') return;
    if (e.target.closest('.page-sheet, .blk, .freebox, .sidenote, .shape, .wb-rail, .wb-options, .wb-zoom')) return;
    addShapeAt(toPlane(e.clientX, e.clientY));
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
      h('span.status-hint', { text: 'double-click the open plane for a box · drag a box’s dot to join it to another · shift+drag to select several · drag the background to pan, ctrl+wheel to zoom' })),
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
  const boxes = (card(state.cardId)?.shapes || []).length;
  const lines = (card(state.cardId)?.wires || []).length;
  right.append(...[
    h('span.status-item', { text: `${s.words} words` }),
    h('span.status-sep'),
    h('span.status-item', { text: `${s.blocks} blocks` }),
    boxes ? h('span.status-sep') : null,
    boxes ? h('span.status-item', { text: `${boxes} ${boxes === 1 ? 'box' : 'boxes'}` }) : null,
    lines ? h('span.status-sep') : null,
    lines ? h('span.status-item', { text: `${lines} ${lines === 1 ? 'line' : 'lines'}` }) : null,
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

  // the tag fade belongs to the page you set it on, not to the next one
  if (dimCard !== c.id) { tagDim = new Set(); dimCard = c.id; }

  clear(host);
  const shell = h('div.page-shell');
  if (state.settings.sidebar === false) shell.classList.add('side-closed');

  const work = h('div.page-work');
  viewport = h('div.page-viewport');
  plane = h('div.page-plane');
  sheet = h('div.page-sheet');

  const chrome = chromeOf(c);
  const top = pageTop(c, chrome);
  if (top) sheet.append(top);
  const canvas = h('div.page-canvas',
    h('div.page-cols',
      h('div.page-gutter.gutter-left#page-gutter-left'),
      h('div.page-main#page-main'),
      h('div.page-gutter.gutter-right#page-gutter')));
  sheet.append(canvas);
  if (chrome.kids) sheet.append(kidsStrip(c));

  // free layer + connectors live on the plane, not inside the paper — that is
  // what lets a line of text be dragged off into open space and stay there
  // the paper is furniture like anything else: a page can be told not to have
  // one, and then the plane is all there is. the sheet is still built, just not
  // put on the plane, so the few places that measure it keep working.
  if (chrome.paper) plane.append(sheet);
  plane.append(h('div.page-shapes#page-shapes'), h('div.page-free#page-free'), svgLayer(), wireLayer());
  viewport.append(plane);
  work.append(viewport, emptyPlaneHint(c, chrome), statusBar());
  shell.append(sideBar(), work);
  host.append(shell);
  mountVideoPanel(host);

  if (chrome.paper) renderBlocks($('#page-main'), c.id);
  paintMeta();
  renderSidenotes();
  renderFreeBoxes();
  renderShapes();

  view = c.pageView ? { ...c.pageView } : centredView();
  applyView();
  bindPlane();
  mountWhiteboard(work, viewport, plane);
  renderInk();

  layoutSidenotes();
  paintAnchors();
  paintWires();
  paintStatus();
  const mark = viewTouch;
  if (!chrome.paper && (c.blocks || []).some((b) => (b.html || '').trim() || b.type === 'image')) {
    plane.append(hiddenPaperChip(c));
  }

  requestAnimationFrame(() => {
    stagger($$('.blk', sheet).slice(0, 12), { step: 18, distance: 8 });
    if (!c.pageView && viewTouch === mark) { view = centredView(); applyView(); }
    layoutSidenotes();
    paintAnchors();
    paintWires();
  });

  sheet.addEventListener('click', (e) => {
    // clicking the empty space under the doc puts the caret on a new last line
    if (e.target !== sheet && e.target !== canvas) return;
    const blocks = card(state.cardId).blocks || [];
    const last = blocks[blocks.length - 1];
    // a page really can have no blocks at all now, and clicking the paper is
    // how you start the first one
    if (!last) { insertBlock(null, { type: 'p' }, true); return; }
    if (last.type === 'p' && !last.html) focusBlock(last.id, 'end');
    else insertBlock(last.id, { type: 'p' }, true);
  });
}

function svgLayer() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'page-links');
  svg.id = 'page-links';
  return svg;
}

/* wires live on their own layer above the anchor hints: anchors clear
   themselves constantly as you move the mouse, and these must not go with them */
function wireLayer() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'page-wires');
  svg.id = 'page-wires';
  return svg;
}

/* ---------------------------------------------------------------- left rail

   six ways to read the same page: its outline, its pictures, its timestamps,
   its flagged notes, its tags, and a grid of things to add. six labels do not
   fit in a 244px rail, so the tabs are icons and the body says which one you
   are on — nothing important is hidden behind a keystroke or a hover.
*/

const SIDE_TABS = [
  ['outline', 'outline', 'listUl', 'headings and sub-pages, in order'],
  ['shots', 'images', 'image', 'the pictures on this page, and the ones you drop on often'],
  ['timeline', 'timeline', 'clock', 'every timestamp — click one to jump the vod'],
  ['drills', 'drills', 'drill', 'every flagged note, worst first'],
  ['tags', 'tags', 'tag', 'click a tag and the rest of the page fades back'],
  ['links', 'links', 'link', 'text tied to a picture, and arrows on the map'],
  ['add', 'add', 'plus', 'drop something into the page'],
];

let sideTab = 'outline';

function sideBar() {
  if (SIDE_TABS.some(([id]) => id === state.settings.sideTab)) sideTab = state.settings.sideTab;

  const aside = h('aside.page-side',
    h('div.side-head',
      h('div.side-tabs',
        ...SIDE_TABS.map(([id, label, ico, blurb]) => h('button.side-tab', {
          class: sideTab === id ? 'on' : '', tip: `${label} — ${blurb}`, data: { tab: id },
          on: { click: () => pickSideTab(id) },
        }, icon(ico, { size: 15 })))),
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

/** switch tabs, move the lit pill with it, and remember the choice for next time */
export function pickSideTab(id) {
  if (sideTab === 'tags' && id !== 'tags') clearTagDim();
  sideTab = id;
  setSetting('sideTab', id);
  for (const btn of $$('.side-tab')) btn.classList.toggle('on', btn.dataset.tab === id);
  paintSide();
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

  const tab = SIDE_TABS.find(([id]) => id === sideTab) || SIDE_TABS[0];
  body.append(h('div.side-cap', h('b', { text: tab[1] }), h('span', { text: tab[3] })));

  if (sideTab === 'outline') paintOutline(body, c);
  else if (sideTab === 'shots') paintImages(body, c);
  else if (sideTab === 'timeline') paintTimeline(body, c);
  else if (sideTab === 'drills') paintDrills(body, c);
  else if (sideTab === 'tags') paintTags(body, c);
  else if (sideTab === 'links') paintLinks(body, c);
  else paintAddPalette(body, c);

  applyTagDim();
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

  if (!rows.length && !(c.shapes || []).length) {
    body.append(h('div.side-empty',
      h('p', { text: 'headings show up here as you write them.' }),
      h('button.btn.btn-sm', { on: { click: () => addHeading() } }, icon('h2', { size: 13 }), 'add a heading'),
      h('button.btn.btn-sm', { on: { click: () => addShape() } }, icon('roundBox', { size: 13 }), 'put a box on the board')));
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
  if (rows.length) body.append(list);
  paintBoardList(body, c);
  markOutlinePosition();
}

/* the board has no reading order, so the outline can't fold it in — but a
   plain list of what is out there is how you find a box you put down twenty
   minutes ago and have since panned away from. */
function paintBoardList(body, c) {
  const boxes = (c.shapes || []).filter((s) => s.kind !== 'frame');
  const frames = (c.shapes || []).filter((s) => s.kind === 'frame');
  if (!boxes.length && !frames.length) return;

  body.append(h('div.side-cap.side-cap-sub',
    h('b', { text: 'on the board' }),
    h('span', { text: `${boxes.length} box${boxes.length === 1 ? '' : 'es'}${frames.length ? `, ${frames.length} frame${frames.length === 1 ? '' : 's'}` : ''}` })));

  const list = h('div.side-list');
  for (const s of [...frames, ...boxes]) {
    const text = stripHtml(s.html || '').trim() || s.title || (s.src ? 'picture' : 'empty box');
    list.append(h('button.side-row', {
      data: { shape: s.id },
      on: {
        click: () => jumpToShape(s.id),
        contextmenu: (e) => {
          e.preventDefault();
          import('./shapes.js?v=d258d51ea6').then((m) => m.shapeMenu(s.id, e.clientX, e.clientY));
        },
      },
    },
      h('span.side-swatch', { style: { background: s.tone === 'solid' && s.fill ? s.fill : 'transparent', borderColor: s.fill || 'var(--line)' } }),
      h('span.side-text', { text: text.slice(0, 70) }),
      s.src ? h('span.side-ico', icon('image', { size: 11 })) : null));
  }
  body.append(list);
}

/* ---------------------------------------------------------------- images

   two halves. the top is what is already in this session — the pictures in
   the column and the ones sitting in boxes on the board — so you can find one
   and jump to it. the bottom is the preset library (js/presets.js): the
   symbols you put down over and over, plus anything you have saved yourself.
   click one and it lands in the middle of what you are looking at.
*/

function paintImages(body, c) {
  const shots = (c.blocks || []).filter((b) => b.type === 'image' && b.src);
  const boxed = (c.shapes || []).filter((sh) => sh.src);

  if (!shots.length && !boxed.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'paste a screenshot with ctrl+v, or drag one onto the plane and it becomes a box.' }),
      h('button.btn.btn-sm', { on: { click: async () => (await import('./images.js?v=d258d51ea6')).pickImageFile(card(state.cardId).blocks.at(-1)?.id) } },
        icon('image', { size: 13 }), 'add a picture')));
  } else {
    const grid = h('div.side-shots');
    shots.forEach((block, i) => {
      grid.append(h('button.side-shot', {
        tip: stripHtml(block.caption || '') || `picture ${i + 1}`,
        on: { click: () => jumpToBlock(block.id) },
      },
        h('img', { src: mediaUrl(state.board.id, block.src), loading: 'lazy', alt: '' }),
        (block.pins || []).length ? h('span.side-shot-pins', { text: String(block.pins.length) }) : null));
    });
    for (const sh of boxed) {
      grid.append(h('button.side-shot', {
        tip: stripHtml(sh.html || '') || 'a picture on the board',
        on: { click: () => jumpToShape(sh.id) },
      },
        h('img', { src: mediaUrl(state.board.id, sh.src), loading: 'lazy', alt: '' }),
        h('span.side-shot-pins', icon('roundBox', { size: 10 }))));
    }
    body.append(grid);
  }

  paintPresets(body);
}

async function dropPresetHere(preset) {
  const { dropPreset } = await import('./presets.js?v=d258d51ea6');
  const vp = viewport?.getBoundingClientRect();
  const at = vp
    ? toPlane(vp.left + vp.width * 0.55, vp.top + vp.height * 0.45)
    : { x: 200, y: 200 };
  const made = await dropPreset(preset, at);
  if (made) toast(`${preset.name} — drag it where you want it`, { ms: 2200 });
}

function paintPresets(body) {
  import('./presets.js?v=d258d51ea6').then((lib) => {
    const host = $('#side-presets');
    if (!host) return;
    clear(host);
    const list = lib.allPresets();

    for (const [group, label] of lib.GROUPS) {
      const mine = list.filter((p) => p.group === group);
      if (!mine.length) continue;
      host.append(h('div.side-group-cap', { text: label }));
      const grid = h('div.side-presets');
      for (const preset of mine) {
        const cell = h('button.side-preset', {
          tip: preset.name,
          on: {
            click: () => dropPresetHere(preset),
            contextmenu: (e) => {
              e.preventDefault();
              e.stopPropagation();
              contextMenu([
                { header: preset.name },
                { label: 'put it on the board', icon: 'roundBox', onPick: () => dropPresetHere(preset) },
                { label: 'rename it', icon: 'pen', onPick: () => lib.renamePreset(preset.id).then(() => paintSide()) },
                { sep: true },
                { label: 'delete it', icon: 'trash', danger: true, onPick: () => lib.deletePreset(preset.id).then(() => paintSide()) },
              ], { x: e.clientX, y: e.clientY, width: 210 });
            },
          },
        });
        if (preset.island) cell.append(h('span.side-preset-map', icon('target', { size: 18 })));
        else cell.append(h('img', { src: lib.presetSrc(preset), loading: 'lazy', alt: preset.name }));
        cell.append(h('span.side-preset-name', { text: preset.name }));
        grid.append(cell);
      }
      host.append(grid);
    }

    host.append(h('div.side-foot',
      h('button.btn.btn-sm', { on: { click: () => lib.pickPresetFile().then(() => paintSide()) } }, icon('plus', { size: 13 }), 'add one of yours'),
      lib.deletedCount()
        ? h('button.btn.btn-sm', { on: { click: () => { lib.restorePresets(); paintSide(); } } }, icon('undo', { size: 13 }), `put back ${lib.deletedCount()}`)
        : null));
  });

  body.append(h('div.side-cap.side-cap-sub',
    h('b', { text: 'drop-on pictures' }),
    h('span', { text: 'click one to put it on the board · right-click to rename or delete' })));
  body.append(h('div#side-presets'));
}

/* ---------------------------------------------------------------- timeline

   every timestamp on the page in one column. a stamp is an inline chip in some
   block's html, or a sub-page pinned to a moment — both end up here, sorted,
   and clicking one seeks the vod and walks you to where the note lives.
*/

/* CHIP_RE, tidy() and the stamp scan live in stamps.js, so the whole-session
   clip export reads exactly the same rows this tab does. */

function timelineRows(c) {
  const rows = stampsOnCard(c);
  // this tab is scoped to the page you are on, so it takes direct children too
  // — the whole-session version in stamps.js visits every card instead
  for (const kid of childrenOf(c.id)) {
    if (kid.t === null || kid.t === undefined) continue;
    rows.push({ t: Number(kid.t), text: cardTitle(kid), kind: 'card', ref: kid.id });
  }
  return rows.filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
}

function paintTimeline(body, c) {
  const rows = timelineRows(c);
  if (!rows.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'press t while the vod plays and the moment lands here.' }),
      h('button.btn.btn-sm', { on: { click: async () => (await import('./video.js?v=d258d51ea6')).insertTimestamp(currentBlockId() || c.blocks.at(-1)?.id) } },
        icon('clock', { size: 13 }), 'stamp this moment')));
    return;
  }

  const list = h('div.side-list');
  for (const row of rows) {
    list.append(h('button.side-row.tl-row', {
      tip: row.text || fmtClock(row.t),
      on: { click: () => goToStamp(row) },
    },
      h('span.tl-t', { text: fmtClock(row.t) }),
      h('span.side-text', { text: row.text || 'no words on this one' }),
      row.kind === 'card' ? h('span.side-ico', icon('cards', { size: 12 })) : null));
  }
  body.append(list);
  body.append(h('div.side-foot',
    h('button.btn.btn-sm.btn-ghost', {
      tip: 'every stamp as plain lines, for an editor',
      on: { click: () => copyClipList(rows) },
    }, icon('copy', { size: 13 }), 'copy as a clip list')));
}

async function goToStamp(row) {
  try { (await import('./video.js?v=d258d51ea6')).seekTo(row.t); } catch { /* no video panel is fine */ }
  if (row.kind === 'card') { openCardPage(row.ref); return; }
  if (row.kind === 'block') { jumpToBlock(row.ref); return; }
  const el = $(row.kind === 'side' ? `.sidenote[data-id="${CSS.escape(row.ref)}"]` : `.freebox[data-id="${CSS.escape(row.ref)}"]`);
  if (!el) return;
  ensureVisible(el, { margin: 160 });
  ping(el);
}

async function copyClipList(rows) {
  const text = clipLines(rows);
  try {
    await navigator.clipboard.writeText(text);
    toast(`${rows.length} timestamp${rows.length === 1 ? '' : 's'} copied`, { kind: 'ok', ms: 1800 });
  } catch {
    toast('the browser would not hand over the clipboard', { kind: 'warn' });
  }
}

/* ---------------------------------------------------------------- drills

   the flagged notes on this page and everything nested under it, worst first.
   same severities as the dashboard drill list, scoped to where you are.
*/

/* SEV_LABEL / SEV_ORDER live in store.js — see the note there */

function subtreeOf(id) {
  const out = [];
  (function walk(cid) {
    const c = card(cid);
    if (!c) return;
    out.push(c);
    for (const kid of c.children || []) walk(kid);
  })(id);
  return out;
}

function paintDrills(body, c) {
  const flagged = subtreeOf(c.id).filter((x) => (x.severity || 0) > 0);

  if (!flagged.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'flag a page with the dots at the top of it — or press 1 to 4 — and it shows up here.' })));
    return;
  }

  for (const lvl of SEV_ORDER) {
    const rows = flagged.filter((x) => (x.severity || 0) === lvl);
    if (!rows.length) continue;

    body.append(h('div.side-group',
      h('span.sev-dot', { class: `sev-${lvl}` }),
      h('span.side-text', { text: SEV_LABEL[lvl] }),
      h('span.side-count', { text: String(rows.length) })));

    const list = h('div.side-list');
    for (const row of rows) {
      const preview = tidy((row.blocks || []).map((b) => b.html).join(' '), 70);
      list.append(h('button.side-row.dr-row', {
        class: row.id === c.id ? 'here' : '',
        on: { click: () => (row.id === c.id ? ping(sheet) : openCardPage(row.id)) },
      },
        h('span.dr-bar', { class: `sev-${lvl}` }),
        h('span.dr-meat',
          h('span.dr-title', { text: cardTitle(row) + (row.id === c.id ? ' — this page' : '') }),
          preview ? h('span.dr-preview', { text: preview }) : null)));
    }
    body.append(list);
  }
}

/* ---------------------------------------------------------------- tags

   every tag on this page and its sub-pages. clicking one fades back everything
   that does not carry it — the same idea as the map's filter, but in place, so
   you do not lose your spot on the plane.
*/

let tagDim = new Set();
let dimCard = null;

/** does this text carry #tag as a whole word? */
function carriesTag(text, tag) {
  const hay = String(text || '').toLowerCase();
  const needle = `#${tag}`;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const after = hay[i + needle.length];
    if (!after || !/[a-z0-9_-]/.test(after)) return true;
  }
  return false;
}

const carriesAll = (text) => [...tagDim].every((t) => carriesTag(text, t));

export function clearTagDim() {
  if (!tagDim.size) return;
  tagDim = new Set();
  applyTagDim();
}

/** paint the fade. reads the rendered text, so it is always in step with the dom */
function applyTagDim() {
  if (!sheet) return;
  const on = tagDim.size > 0;
  sheet.classList.toggle('tag-dim', on);

  for (const el of [...$$('.page-main .blk'), ...$$('#page-free > .blk')]) {
    el.classList.toggle('tag-out', on && !carriesAll(el.textContent));
  }
  for (const el of $$('.sidenote')) el.classList.toggle('tag-out', on && !carriesAll(el.textContent));
  for (const el of $$('#page-free > .freebox')) el.classList.toggle('tag-out', on && !carriesAll(el.textContent));
  for (const el of $$('.kid-card')) {
    const kid = card(el.dataset.id);
    el.classList.toggle('tag-out', on && !(kid && [...tagDim].every((t) => (kid.tags || []).includes(t))));
  }
}

function pageTagCounts(c) {
  const counts = new Map();
  for (const x of subtreeOf(c.id)) {
    for (const tag of x.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function paintTags(body, c) {
  const counts = pageTagCounts(c);
  if (!counts.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'write #greedy-loot anywhere on the page, or use the + beside the title.' })));
    return;
  }

  const wrap = h('div.side-tags');
  for (const [tag, n] of counts) {
    wrap.append(h('button.chip.chip-tag.side-tag', {
      class: tagDim.has(tag) ? 'on' : '',
      on: {
        click: () => {
          if (tagDim.has(tag)) tagDim.delete(tag); else tagDim.add(tag);
          applyTagDim();
          paintSide();
        },
      },
    }, h('span', { text: tag }), h('span.side-count', { text: String(n) })));
  }
  body.append(wrap);

  if (tagDim.size) {
    body.append(h('div.side-foot',
      h('button.btn.btn-sm.btn-ghost', { on: { click: () => { clearTagDim(); paintSide(); } } },
        icon('close', { size: 13 }), 'show everything again'),
      h('button.btn.btn-sm.btn-ghost', {
        tip: 'the same filter, on the map',
        on: {
          click: () => {
            state.filter.tags = new Set(tagDim);
            go({ name: 'board', boardId: state.board.id, cardId: state.cardId });
          },
        },
      }, icon('grid', { size: 13 }), 'see these on the map')));
  }
}

function paintAddPalette(body, c) {
  const lastId = () => card(state.cardId).blocks.at(-1)?.id;
  const at = () => currentBlockId() || lastId();

  const add = async (type, extra) => {
    const ed = await import('./editor.js?v=d258d51ea6');
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
    ['picture', 'image', async () => (await import('./images.js?v=d258d51ea6')).pickImageFile(at())],
    ['box', 'roundBox', () => addShape()],
    ['sticky note', 'note', () => addShape({ kind: 'sticky', fill: '#ffd54a', tone: 'solid', align: 'left', valign: 'top', w: 180, h: 170 })],
    ['decision', 'diamond', () => addShape({ kind: 'diamond' })],
    ['frame', 'frame', () => addShape({ kind: 'frame', w: 520, h: 360 })],
    ['text box', 'textbox', () => addShape({ kind: 'rect', tone: 'text', align: 'left', valign: 'top', w: 240, h: 60 })],
    ['margin note', 'sidenote', () => addSidenoteFromSelection()],
    ['sub-page', 'cards', () => addSubPage(at())],
    ['timestamp', 'clock', async () => (await import('./video.js?v=d258d51ea6')).insertTimestamp(at())],
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

/* ---------------------------------------------------------------- links

   two different things that both mean "these two are connected", and both were
   invisible unless you happened to hover the right thing: `card.anchors[]` ties
   a line of text to a picture (or to one numbered pin on it), and
   `board.links[]` is an arrow between two cards on the map.
*/

function paintLinks(body, c) {
  const anchors = (c.anchors || []).filter((a) => a.blockId && a.target);
  const kids = new Set(childrenOf(c.id).map((k) => k.id));
  const arrows = (state.board.links || []).filter((l) => kids.has(l.from) && kids.has(l.to));

  if (!anchors.length && !arrows.length) {
    body.append(h('div.side-empty',
      h('p', { text: 'nothing on this page is tied to anything yet.' }),
      h('p', { text: 'select a line and press ctrl+l to tie it to a picture, or press tab on the map to branch a card with an arrow.' })));
    return;
  }

  if (anchors.length) {
    body.append(h('div.side-group',
      h('span.side-text', { text: 'text tied to a picture' }),
      h('span.side-count', { text: String(anchors.length) })));
    const list = h('div.side-list');
    for (const a of anchors) {
      const from = (c.blocks || []).find((b) => b.id === a.blockId);
      const shotIndex = (c.blocks || []).filter((b) => b.type === 'image').findIndex((b) => b.id === a.target);
      list.append(h('button.side-row', {
        tip: 'go to the line',
        on: { click: () => jumpToBlock(a.blockId) },
      },
        h('span.side-ico', icon('link', { size: 12 })),
        h('span.side-text', { text: tidy(from?.html, 40) || 'a line of text' }),
        h('span.side-count', { text: a.pin ? `pin ${a.pin.slice(-2)}` : `shot ${shotIndex >= 0 ? shotIndex + 1 : '?'}` })));
    }
    body.append(list);
  }

  if (arrows.length) {
    body.append(h('div.side-group',
      h('span.side-text', { text: 'arrows on the map' }),
      h('span.side-count', { text: String(arrows.length) })));
    const list = h('div.side-list');
    for (const l of arrows) {
      list.append(h('button.side-row', {
        tip: 'open the map on these two',
        on: { click: () => go({ name: 'board', boardId: state.board.id, cardId: state.cardId }) },
      },
        h('span.side-ico', icon('forward', { size: 12 })),
        h('span.side-text', { text: `${cardTitle(card(l.from))} → ${cardTitle(card(l.to))}` })));
    }
    body.append(list);
  }
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
  const ed = await import('./editor.js?v=d258d51ea6');
  const last = card(state.cardId).blocks.at(-1)?.id;
  const made = ed.insertBlock(last, { type: 'p' }, false);
  ed.setType(made.id, 'h2');
}

/* ---------------------------------------------------------------- header */

function pageTop(c, chrome = chromeOf(c)) {
  if (!chrome.title && !chrome.meta) return null;
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
    chrome.title ? title : null,
    chrome.meta ? h('div.page-meta#page-meta') : null,
  );
}

/* ---------------------------------------------------------------- chrome

   every piece of furniture on a page can be taken away: the paper itself, the
   title, the row of flags and tags, the strip of sub-pages. the flags live on
   the card, so one session can be a written page and the next a bare board.
   nothing here deletes any content — the writing is still in the document and
   the chip below says so. */

export const CHROME_PARTS = [
  ['paper', 'the paper', 'the written column in the middle'],
  ['title', 'the title', 'the big line at the top of the paper'],
  ['meta', 'flags and tags', 'the row under the title'],
  ['kids', 'sub-pages', 'the strip of pages under this one'],
];

export const chromeOf = (c) => ({
  paper: c?.chrome?.paper !== false,
  title: c?.chrome?.title !== false,
  meta: c?.chrome?.meta !== false,
  kids: c?.chrome?.kids !== false,
});

export function setChrome(part, on) {
  const id = state.cardId;
  commit(on ? `show ${part}` : `hide ${part}`, (b) => {
    const c = b.cards[id];
    if (!c) return;
    c.chrome = { ...(c.chrome || {}), [part]: on };
  });
  render();
  if (!on && part === 'paper') {
    toast('the paper is hidden — nothing was deleted, and the page menu brings it back', { ms: 4200 });
  }
}

/* a page with nothing on it and no paper is a black rectangle, which reads as
   a broken app rather than as an empty one. this is the one thing on screen
   that says what to do, and it takes itself away the moment anything exists.
   it lives in screen space rather than on the plane, so panning and zooming
   cannot lose it. */

function emptyPlaneHint(c, chrome) {
  if (chrome.paper) return null;
  const bare = !(c.shapes || []).length && !(c.free || []).length && !(c.ink || []).length;
  if (!bare) return null;

  return h('div.plane-hint',
    h('div.plane-hint-card',
      h('div.plane-hint-title', { text: 'nothing here yet' }),
      h('div.plane-hint-line', { text: 'double-click anywhere out here to put a box down, or drag one out with the box tool on the left.' }),
      h('div.plane-hint-acts',
        h('button.btn.btn-sm.btn-primary', { on: { click: () => addShape() } }, icon('roundBox', { size: 13 }), 'put a box down'),
        h('button.btn.btn-sm', { on: { click: () => setChrome('paper', true) } }, icon('page', { size: 13 }), 'bring the paper back'))));
}

/** a page with its paper hidden but writing still on it says so, rather than
 *  quietly swallowing a page of notes */
function hiddenPaperChip(c) {
  const n = (c.blocks || []).filter((b) => (b.html || '').trim() || b.type === 'image').length;
  return h('button.paper-chip', {
    tip: 'the paper is hidden on this page — click to bring it back',
    style: { left: '18px', top: '18px' },
    on: { click: () => setChrome('paper', true) },
  }, icon('page', { size: 13 }), h('span', { text: `${n} line${n === 1 ? '' : 's'} on the hidden paper` }));
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
      on: { click: async () => (await import('./video.js?v=d258d51ea6')).seekTo(c.t) },
    }, icon('clock', { size: 12 }), fmtClock(c.t)));
  }

  const kids = childrenOf(c.id).length;
  wrap.append(h('div.meta-right',
    kids ? h('button.chip', { tip: 'see them on the map', on: { click: () => toggleMap() } }, icon('grid', { size: 12 }), `${kids} sub-page${kids === 1 ? '' : 's'}`) : null,
    h('button.chip', { tip: 'more', on: { click: (e) => pageMenu(e.currentTarget) } }, icon('dots', { size: 13 }))));
}

function sevPicker(c) {
  const wrap = h('div.sev-picker');
  for (let lvl = 0; lvl <= 3; lvl++) {
    wrap.append(h('button.sev-btn', {
      class: `${(c.severity || 0) === lvl ? 'on' : ''} sev-${lvl}`,
      tip: `${SEV_LABEL[lvl]} · press ${lvl + 1}`,
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
    on: { click: () => { addTag(t); import('./ui.js?v=d258d51ea6').then((m) => m.closePopover()); } },
  }, h('span.menu-ico', { text: '#' }), h('span.menu-label', { text: t }))));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const value = input.value.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
      if (value) addTag(value);
      import('./ui.js?v=d258d51ea6').then((m) => m.closePopover());
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

/** the show/hide switches for this page's furniture, offered in three places:
 *  the page menu, the plane's right-click menu and the command palette */
export function chromeItems() {
  const c = card(state.cardId);
  const now = chromeOf(c);
  return CHROME_PARTS.map(([part, label, blurb]) => ({
    label,
    hint: blurb,
    icon: now[part] ? 'eye' : 'close',
    checked: now[part],
    onPick: () => setChrome(part, !now[part]),
  }));
}

function pageMenu(anchor) {
  const c = card(state.cardId);
  contextMenu([
    { label: 'open the map', icon: 'grid', hint: 'ctrl+b', onPick: () => toggleMap() },
    { label: 'read mode', icon: 'book', hint: 'ctrl+r', onPick: async () => (await import('./readmode.js?v=d258d51ea6')).openReader() },
    { sep: true },
    { label: 'add a sub-page', icon: 'cards', onPick: () => addSubPage(null) },
    { label: 'put a box on the board', icon: 'roundBox', hint: 'r', onPick: () => addShape() },
    { label: 'text box', icon: 'textbox', hint: 'ctrl+shift+t', onPick: () => addShape({ kind: 'rect', tone: 'text', align: 'left', valign: 'top', w: 240, h: 60 }) },
    { label: 'draw a line between two things', icon: 'link', hint: 'c', onPick: () => startWire() },
    { label: 'tidy the boxes into a grid', icon: 'tidy', hint: 'whole board', onPick: () => tidySelection() },
    { label: 'what this page shows', icon: 'eye', subWidth: 240, sub: chromeItems() },
    { label: 'arrange this page…', icon: 'grid', hint: 'presets',
      onPick: async () => (await import('./layouts.js?v=d258d51ea6')).openLayouts() },
    { sep: true },
    { label: 'loot routes', icon: 'target', hint: 'map',
      onPick: async () => (await import('./lootmap.js?v=d258d51ea6')).openLootmap() },
    { label: 'earlier versions of this session', icon: 'history',
      onPick: async () => (await import('./history.js?v=d258d51ea6')).openHistory() },
    { label: 'save this page as a template', icon: 'copy', hint: 'reuse',
      onPick: async () => (await import('./templates.js?v=d258d51ea6')).saveAsTemplate(c) },
    { sep: true },
    { label: 'export markdown', icon: 'download', onPick: async () => (await import('./exporter.js?v=d258d51ea6')).exportMarkdown(c.id) },
    { label: 'export html', icon: 'download', onPick: async () => (await import('./exporter.js?v=d258d51ea6')).exportHtml(c.id) },
    { label: 'export the whole session (.vodpad)', icon: 'download', onPick: async () => (await import('./transfer.js?v=d258d51ea6')).exportSession(state.board.id) },
    { label: 'export the clip list', icon: 'clock', hint: '.csv',
      onPick: async () => (await import('./exporter.js?v=d258d51ea6')).exportClipList(state.board, { csv: true }) },
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
      data: { id: kid.id },
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
    import('./editor.js?v=d258d51ea6').then((ed) => ed.wrapSelection('span', { 'data-side': noteId }));
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

/* ---------------------------------------------------------------- free boxes

   the old floating text boxes. nothing makes a new one any more — a text box
   and a sticky note are both shapes now (js/shapes.js), so they can be
   selected with a marquee, lined up with everything else and joined with a
   line. everything below is here because boards written before that still
   have `free[]` in them, and they must keep dragging, resizing and taking a
   wire exactly as they did. */

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
      import('./whiteboard.js?v=d258d51ea6').then(({ STICKY_COLOURS }) => {
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
