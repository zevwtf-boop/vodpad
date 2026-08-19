/* the whiteboard layer — boxes you fill in, join up and drop pictures into.

   the paper column is still in the middle of the plane and every note written
   before this keeps working. what changed is where new notes go: a filled box
   you put down anywhere, joined to other boxes with lines, with a screenshot
   dropped straight into it.

   why a new list rather than more `free[]` boxes: a free box is a scrap of
   text with a width. a shape has a fill, a border, an outline shape, a
   picture, a z-order, a lock and an optional link to a sub-page — and the
   whole point is that several of them are selected, moved, aligned and
   connected as a group. the two models are different enough that bolting the
   second onto the first would have made both worse. old boards have no
   `shapes` key at all and open exactly as they did.

     card.shapes = [{ id, kind, x, y, w, h, z, fill, tone, dash, weight,
                      html, align, valign, font, src, nat, fit, locked,
                      cardId, title }]

   geometry is plane coordinates, the same ones the ink and the free layer
   use, so everything pans and zooms together.
*/

import { $, $$, h, clear, uid, clamp, rafThrottle, stripHtml } from './util.js?v=44ebe426f1';
import { icon } from './icons.js?v=44ebe426f1';
import { mediaUrl } from './api.js?v=44ebe426f1';
import { state, card, commit, bus, makeCard } from './store.js?v=44ebe426f1';
import { contextMenu, toast } from './ui.js?v=44ebe426f1';
import { animate, EASE } from './motion.js?v=44ebe426f1';
import { paintWires, addWire, wiring, ghostWire, clearGhost, boxOfEl, sidePoint } from './wires.js?v=44ebe426f1';
import { activeTool, setTool, STICKY_COLOURS } from './whiteboard.js?v=44ebe426f1';
import { openCardPage } from './nav.js?v=44ebe426f1';

/* ---------------------------------------------------------------- the paints

   twelve fills that hold up on a charcoal board and on the light theme, plus
   two ways of using each one: solid (the box is the colour) and soft (a tint
   with the colour as the border). the text colour is never stored — it is
   worked out from the fill every time it is painted, so a theme change or a
   recolour can never leave unreadable text behind.
*/

export const FILLS = [
  ['slate', '#68707c'],
  ['red', '#cf4a50'],
  ['orange', '#d1793c'],
  ['amber', '#c8a233'],
  ['lime', '#83a63f'],
  ['green', '#3ea07c'],
  ['teal', '#3897a6'],
  ['blue', '#4279c6'],
  ['indigo', '#6a62c8'],
  ['violet', '#9257c4'],
  ['pink', '#c25596'],
  ['brown', '#8a6a52'],
];

export const KINDS = [
  ['round', 'roundBox', 'box'],
  ['rect', 'box', 'square box'],
  ['pill', 'pillShape', 'pill'],
  ['ellipse', 'ellipse', 'ellipse'],
  ['diamond', 'diamond', 'decision'],
  ['hex', 'hexagon', 'hexagon'],
  ['triangle', 'triangle', 'triangle'],
  ['cyl', 'cylinder', 'cylinder'],
  ['sticky', 'note', 'sticky note'],
  ['frame', 'frame', 'frame'],
];

/* shapes that are drawn with a polygon behind the text rather than by the
   div's own border-radius. the numbers are the text inset, in percent. */
const ART = {
  diamond: { pts: '50,1 99,50 50,99 1,50', pad: [16, 22] },
  triangle: { pts: '50,3 99,97 1,97', pad: [40, 16, 6] },
  hex: { pts: '25,2 75,2 99,50 75,98 25,98 1,50', pad: [12, 20] },
  cyl: { pts: null, pad: [18, 12] },
};

const DEFAULT = { w: 210, h: 116 };
const MIN_W = 56;
const MIN_H = 36;
const SNAP = 6;                 // plane px an edge will jump to line up with another

/* last used, so the next box looks like the last one you made */
let pen = { kind: 'round', fill: '#4279c6', tone: 'solid' };

export const shapePen = () => ({ ...pen });
export function setShapePen(patch) {
  pen = { ...pen, ...patch };
  bus.emit('shapes:pen', pen);
}

/* ---------------------------------------------------------------- geometry */

const planeOf = () => document.querySelector('.page-plane');

function zoomOf() {
  const plane = planeOf();
  if (!plane) return 1;
  try { return new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { return 1; }
}

/** a screen point in plane coordinates (page.js has the same maths, but this
 *  layer must not import it — page.js imports this file) */
function toPlanePt(clientX, clientY) {
  const plane = planeOf();
  if (!plane) return { x: 0, y: 0 };
  const r = plane.getBoundingClientRect();
  const z = zoomOf();
  return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
}

const boxOf = (s) => ({ l: s.x, t: s.y, r: s.x + s.w, b: s.y + s.h, cx: s.x + s.w / 2, cy: s.y + s.h / 2 });
const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
const inside = (outer, inner) => inner.l >= outer.l && inner.r <= outer.r && inner.t >= outer.t && inner.b <= outer.b;

/* ---------------------------------------------------------------- the model */

export const shapesOf = (c = card(state.cardId)) => c?.shapes || [];
export const findShape = (id, c = card(state.cardId)) => shapesOf(c).find((s) => s.id === id) || null;

/** frames sit behind everything so you can drop boxes on top of them */
const ordered = (list) => [...list].sort((a, b) =>
  (a.kind === 'frame' ? 0 : 1) - (b.kind === 'frame' ? 0 : 1) || (a.z || 0) - (b.z || 0));

function nextZ() {
  const list = shapesOf();
  return list.length ? Math.max(...list.map((s) => s.z || 0)) + 1 : 1;
}

/** every change to the shape list goes through here so undo stays one step */
function editShapes(label, fn, opts = {}) {
  const cardId = state.cardId;
  commit(label, (b) => {
    const c = b.cards[cardId];
    if (!c) return;
    c.shapes ||= [];
    fn(c.shapes, c);
  }, opts);
}

/* ---------------------------------------------------------------- making one */

export function newShape(patch = {}) {
  const kind = patch.kind || pen.kind;
  return {
    id: uid('sh'),
    kind,
    x: 0, y: 0,
    w: kind === 'frame' ? 520 : kind === 'sticky' ? 180 : DEFAULT.w,
    h: kind === 'frame' ? 360 : kind === 'sticky' ? 170 : DEFAULT.h,
    z: nextZ(),
    fill: kind === 'sticky' ? STICKY_COLOURS[0] : kind === 'frame' ? 'none' : pen.fill,
    tone: kind === 'sticky' ? 'solid' : kind === 'frame' ? 'none' : pen.tone,
    html: '',
    align: 'center',
    valign: 'middle',
    ...patch,
  };
}

/** drop a box at a point on the plane, centred on it, and start typing */
export function addShapeAt(planePoint, patch = {}) {
  const s = newShape(patch);
  s.x = Math.round(planePoint.x - s.w / 2);
  s.y = Math.round(planePoint.y - s.h / 2);
  return placeShape(s);
}

export function placeShape(s, { label = 'box', edit = true } = {}) {
  editShapes(label, (list) => { list.push(s); });
  renderShapes();
  selectShape(s.id);
  const el = elFor(s.id);
  if (el) animate(el, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 190, easing: EASE.snap });
  if (edit && s.kind !== 'frame') editShape(s.id);
  return s;
}

/** the sidebar / palette version: put one in the middle of what you can see */
export function addShape(patch = {}) {
  const vp = document.querySelector('.page-viewport');
  const r = vp ? vp.getBoundingClientRect() : { left: 0, top: 0, width: 1000, height: 700 };
  const at = toPlanePt(r.left + r.width * 0.62, r.top + r.height * 0.42);
  return addShapeAt(at, patch);
}

/* ---------------------------------------------------------------- painting */

export function renderShapes() {
  const layer = $('#page-shapes');
  if (!layer) return;
  const c = card(state.cardId);
  clear(layer);
  if (!c) return;
  for (const s of ordered(shapesOf(c))) layer.append(shapeEl(s));
  layer.append(guideLayer());
  syncZoom();
  paintSelection();
}

/** handles and ports must stay the same size on screen however far you zoom
 *  out, or they vanish exactly when you need them.
 *  deliberately NOT inside requestAnimationFrame: rAF is throttled whenever
 *  the window is not being composited, and this is layout, not animation. */
export function syncZoom() {
  const layer = $('#page-shapes');
  if (layer) layer.style.setProperty('--iz', String(1 / Math.max(0.15, zoomOf())));
}

function guideLayer() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'shape-guides');
  svg.id = 'shape-guides';
  return svg;
}

const elFor = (id) => document.querySelector(`.shape[data-id="${CSS.escape(id)}"]`);

/** relative luminance, so text on a fill is readable without storing a colour */
function inkFor(hex, tone) {
  if (tone !== 'solid' || !hex || hex === 'none') return 'var(--text)';
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'var(--text)';
  const n = parseInt(m[1], 16);
  const f = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  return lum > 0.48 ? '#14181c' : '#f6f8fa';
}

function paintOf(s) {
  const fill = s.fill || '#68707c';
  const tone = s.tone || 'solid';
  if (s.kind === 'frame') return { bg: 'transparent', border: 'var(--line)', ink: 'var(--muted)' };
  // a plain text box: the box itself is off, only the writing is left
  if (tone === 'text') return { bg: 'transparent', border: 'transparent', ink: 'var(--text)' };
  if (tone === 'none') return { bg: 'transparent', border: fill, ink: 'var(--text)' };
  if (tone === 'soft') return { bg: `color-mix(in srgb, ${fill} 22%, var(--bg-1))`, border: fill, ink: 'var(--text)' };
  return { bg: fill, border: `color-mix(in srgb, ${fill} 72%, #000)`, ink: inkFor(fill, tone) };
}

function shapeEl(s) {
  const paint = paintOf(s);
  const art = ART[s.kind];
  const editing = editingId === s.id;

  const body = h('div.shape-body', {
    contenteditable: editing ? 'true' : 'false',
    html: s.html || '',
    'data-ph': s.kind === 'frame' ? '' : 'double-click to write',
    style: {
      textAlign: s.align || 'center',
      justifyContent: s.valign === 'top' ? 'flex-start' : s.valign === 'bottom' ? 'flex-end' : 'center',
      fontFamily: s.font === 'mono' ? 'var(--font-mono)' : s.font === 'serif' ? 'var(--font-serif)' : 'var(--font-ui)',
      fontSize: s.size ? `${s.size}px` : null,
      ...(art ? { padding: `${art.pad[0]}% ${art.pad[1]}% ${art.pad[2] ?? art.pad[0]}%` } : {}),
    },
    on: {
      input: (e) => {
        const html = e.target.innerHTML;
        editShapes('write in a box', (list) => {
          const t = list.find((x) => x.id === s.id);
          if (t) t.html = html;
        }, { coalesce: `shape:${s.id}` });
        growToFit(s.id);
      },
      blur: () => { if (editingId === s.id) stopEditing(); },
      keydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); stopEditing(); }
        e.stopPropagation();      // typing must never reach the board shortcuts
      },
    },
  });

  const el = h('div.shape', {
    data: { id: s.id, kind: s.kind },
    class: [s.locked ? 'locked' : '', editing ? 'editing' : '', (s.src || s.pending) ? 'has-pic' : '', s.tone === 'text' ? 'plain' : ''].filter(Boolean).join(' '),
    style: {
      left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px`,
      zIndex: String(s.kind === 'frame' ? 1 : 10 + (s.z || 0)),
      '--fill': paint.bg,
      '--edge': paint.border,
      '--ink': paint.ink,
      '--weight': `${s.weight || 1.5}px`,
      borderStyle: s.dash ? 'dashed' : 'solid',
    },
  });

  if (art) el.append(artFor(s, paint));
  if (s.src || s.pending) el.append(pictureIn(s));
  if (s.kind === 'frame' && (s.title || true)) el.append(frameTitle(s));
  el.append(body);
  if (s.cardId) el.append(h('button.shape-chip', {
    tip: 'open this box as its own page',
    on: { click: (e) => { e.stopPropagation(); openCardPage(s.cardId); } },
  }, icon('cards', { size: 12 })));
  if (s.locked) el.append(h('div.shape-lockmark', { tip: 'locked — right-click to unlock' }, icon('lock', { size: 12 })));

  bindShape(el, s);
  return el;
}

/** the polygon behind a diamond / hexagon / triangle / cylinder */
function artFor(s, paint) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'shape-art');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  const paths = [];
  if (s.kind === 'cyl') {
    paths.push(`M1 12 A49 11 0 0 1 99 12 V88 A49 11 0 0 1 1 88 Z`);
    paths.push(`M1 12 A49 11 0 0 0 99 12`);
  }
  if (paths.length) {
    paths.forEach((d, i) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', i === 0 ? paint.bg : 'none');
      p.setAttribute('stroke', paint.border);
      p.setAttribute('stroke-width', String(s.weight || 1.5));
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      if (s.dash) p.setAttribute('stroke-dasharray', '6 4');
      svg.append(p);
    });
  } else {
    const poly = document.createElementNS(NS, 'polygon');
    poly.setAttribute('points', ART[s.kind].pts);
    poly.setAttribute('fill', paint.bg);
    poly.setAttribute('stroke', paint.border);
    poly.setAttribute('stroke-width', String(s.weight || 1.5));
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    poly.setAttribute('stroke-linejoin', 'round');
    if (s.dash) poly.setAttribute('stroke-dasharray', '6 4');
    svg.append(poly);
  }
  return svg;
}

function pictureIn(s) {
  const src = s.pending || (s.src ? mediaUrl(state.board.id, s.src) : '');
  return h('img.shape-img', {
    src,
    draggable: false,
    style: { objectFit: s.fit === 'cover' ? 'cover' : 'contain' },
    alt: stripHtml(s.html || ''),
  });
}

function frameTitle(s) {
  return h('div.shape-frame-title', {
    contenteditable: 'true',
    text: s.title || 'frame',
    on: {
      pointerdown: (e) => e.stopPropagation(),
      keydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      blur: (e) => {
        const title = e.target.textContent.trim();
        editShapes('name a frame', (list) => {
          const t = list.find((x) => x.id === s.id);
          if (t) t.title = title;
        });
      },
    },
  });
}

/* ---------------------------------------------------------------- selection */

let picked = new Set();
let editingId = null;

export const selectedIds = () => [...picked];
export const shapeSelected = () => picked.size > 0;

export function selectShape(id, { add = false } = {}) {
  if (!add) picked.clear();
  if (id) { if (add && picked.has(id)) picked.delete(id); else picked.add(id); }
  paintSelection();
}

export function selectShapes(ids) {
  picked = new Set(ids);
  paintSelection();
}

export function clearShapeSelection() {
  if (!picked.size && !editingId) return false;
  stopEditing();
  picked.clear();
  paintSelection();
  return true;
}

function editShape(id) {
  const s = findShape(id);
  if (!s || s.locked) return;
  editingId = id;
  const el = elFor(id);
  const body = el?.querySelector('.shape-body');
  if (!body) return;
  el.classList.add('editing');
  body.contentEditable = 'true';
  body.focus();
  const sel = getSelection();
  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function stopEditing() {
  if (!editingId) return;
  const el = elFor(editingId);
  const body = el?.querySelector('.shape-body');
  if (body) { body.contentEditable = 'false'; body.blur(); }
  el?.classList.remove('editing');
  editingId = null;
}

/** grow a box downwards so typing never disappears under its own edge */
function growToFit(id) {
  const el = elFor(id);
  const body = el?.querySelector('.shape-body');
  const s = findShape(id);
  if (!el || !body || !s) return;
  // the body is flex-filled, so its scrollHeight is the box height until the
  // text genuinely overflows — comparing it against clientHeight is what says
  // "there is more text than room", rather than "there is a box"
  const over = body.scrollHeight - body.clientHeight;
  if (over <= 0) return;
  const height = Math.ceil(s.h + over + 2);
  el.style.height = `${height}px`;
  editShapes('grow a box', (list) => {
    const t = list.find((x) => x.id === id);
    if (t) t.h = height;
  }, { coalesce: `shape:${id}` });
}

function paintSelection() {
  for (const el of $$('.shape')) {
    const on = picked.has(el.dataset.id);
    el.classList.toggle('sel', on);
    el.querySelector('.shape-chrome')?.remove();
    if (on && picked.size === 1) el.append(chromeFor(el.dataset.id));
    else if (on) el.append(h('div.shape-chrome', ...ports(el.dataset.id)));
  }
  paintGroupBar();
  bus.emit('shapes:select', [...picked]);
}

const HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
  ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1],
  ['sw', 0, 1], ['w', 0, 0.5],
];

const SIDES = [['top', 0.5, 0], ['right', 1, 0.5], ['bottom', 0.5, 1], ['left', 0, 0.5]];

function chromeFor(id) {
  const s = findShape(id);
  const chrome = h('div.shape-chrome');
  if (!s?.locked) {
    for (const [dir, fx, fy] of HANDLES) {
      chrome.append(h('div.shape-handle', {
        data: { dir },
        style: { left: `${fx * 100}%`, top: `${fy * 100}%`, cursor: `${dir}-resize` },
        on: { pointerdown: (e) => startResize(e, id, dir) },
      }));
    }
  }
  chrome.append(...ports(id));
  return chrome;
}

/** the four dots you drag to draw a line out of a box. they show on
 *  selection, never on hover — a control that appears under the cursor and
 *  vanishes again reads as broken. */
function ports(id) {
  return SIDES.map(([side, fx, fy]) => h('div.shape-port', {
    data: { side },
    tip: 'drag to join this to something',
    style: { left: `${fx * 100}%`, top: `${fy * 100}%` },
    on: { pointerdown: (e) => startPortDrag(e, id, side) },
  }));
}

/* ---------------------------------------------------------------- the group bar

   two or more boxes selected and a strip appears above them: line them up,
   space them out, make them the same size. it sits on the plane and is
   counter-scaled, so it is always the same size on screen. */

function paintGroupBar() {
  const layer = $('#page-shapes');
  if (!layer) return;
  layer.querySelector('.shape-groupbar')?.remove();
  if (picked.size < 2) return;
  const list = [...picked].map((id) => findShape(id)).filter(Boolean);
  if (list.length < 2) return;
  const l = Math.min(...list.map((s) => s.x));
  const t = Math.min(...list.map((s) => s.y));

  const btn = (ico, tip, fn) => h('button.gb-btn', { tip, on: { click: (e) => { e.stopPropagation(); fn(); } } }, icon(ico, { size: 15 }));
  const bar = h('div.shape-groupbar', { style: { left: `${l}px`, top: `${t}px` } },
    h('span.gb-count', { text: `${list.length} selected` }),
    h('span.gb-sep'),
    btn('alignL', 'line up their left edges', () => alignSelection('left')),
    btn('alignVC', 'line up their centres', () => alignSelection('cx')),
    btn('alignR', 'line up their right edges', () => alignSelection('right')),
    h('span.gb-sep'),
    btn('alignT', 'line up their tops', () => alignSelection('top')),
    btn('alignHC', 'line up their middles', () => alignSelection('cy')),
    btn('alignB', 'line up their bottoms', () => alignSelection('bottom')),
    h('span.gb-sep'),
    btn('distH', 'space them out across', () => distribute('x')),
    btn('distV', 'space them out down', () => distribute('y')),
    btn('tidy', 'tidy into a grid', () => tidySelection()),
    h('span.gb-sep'),
    btn('copy', 'duplicate', () => duplicateSelection()),
    btn('trash', 'delete', () => deleteSelection()),
  );
  layer.append(bar);
}

/* ---------------------------------------------------------------- pointer work */

function bindShape(el, s) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (wiring()) return;                              // the connector tool owns clicks
    if (activeTool() !== 'select') return;
    if (e.target.closest('.shape-handle, .shape-port, .shape-chip, .shape-frame-title')) return;
    // while you are actually typing in this box, a press inside it moves the
    // caret rather than the box. the focus check matters: without it, an
    // editing state left behind by a lost focus wedges the box in place.
    if (editingId === s.id && el.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    stopEditing();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!picked.has(s.id) || additive) selectShape(s.id, { add: additive });
    if (!findShape(s.id)?.locked) startMove(e, s.id, { copy: e.altKey });
  });

  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('.shape-frame-title')) return;
    e.preventDefault();
    e.stopPropagation();
    if (findShape(s.id)?.locked) { toast('this one is locked', { ms: 1400 }); return; }
    selectShape(s.id);
    editShape(s.id);
  });

  el.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;                            // shift falls through to the browser
    e.preventDefault();
    e.stopPropagation();
    if (!picked.has(s.id)) selectShape(s.id);
    shapeMenu(s.id, e.clientX, e.clientY);
  });

  // dropping a picture straight onto a box puts it in the box
  el.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drop-on');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-on'));
  el.addEventListener('drop', async (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
    el.classList.remove('drop-on');
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    await putImageInShape(s.id, files[0]);
    for (const extra of files.slice(1)) await imageShapeAt({ x: findShape(s.id).x + findShape(s.id).w + 30, y: findShape(s.id).y }, extra);
  });
}

/** move the selection. snaps to the grid and to the other boxes' edges and
 *  centres, drawing the guide it snapped to. alt starts the drag on a copy. */
function startMove(e, id, { copy = false } = {}) {
  const startX = e.clientX, startY = e.clientY;
  const z = zoomOf();
  let ids = picked.has(id) ? [...picked] : [id];
  let moved = false;

  if (copy) {
    const made = cloneShapes(ids, 0, 0, 'duplicate');
    ids = made;
    selectShapes(made);
  }

  // frames carry whatever is sitting on them
  const carried = new Set(ids);
  for (const sid of ids) {
    const f = findShape(sid);
    if (f?.kind !== 'frame') continue;
    const fb = boxOf(f);
    for (const other of shapesOf()) {
      if (other.id === f.id || other.kind === 'frame') continue;
      if (inside(fb, boxOf(other))) carried.add(other.id);
    }
  }
  const moving = [...carried].map((sid) => ({ id: sid, s: findShape(sid) })).filter((m) => m.s && !m.s.locked);
  if (!moving.length) return;
  const origin = moving.map((m) => ({ id: m.id, x: m.s.x, y: m.s.y, w: m.s.w, h: m.s.h }));
  const others = shapesOf().filter((s) => !carried.has(s.id));
  const grid = state.settings.gridSnap !== false ? (state.settings.snapSize || 8) : 1;

  const repaint = rafThrottle(() => { paintWires(); paintGroupBar(); });

  const onMove = (ev) => {
    let dx = (ev.clientX - startX) / z;
    let dy = (ev.clientY - startY) / z;
    if (!moved && Math.hypot(dx, dy) < 3 / z) return;
    if (!moved) { moved = true; for (const m of moving) elFor(m.id)?.classList.add('moving'); }
    if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }

    const bounds = unionOf(origin);
    const snapped = ev.altKey ? { dx, dy, guides: [] } : snapDelta(bounds, dx, dy, others, grid);
    for (let i = 0; i < moving.length; i++) {
      const o = origin[i];
      const nx = Math.round(o.x + snapped.dx);
      const ny = Math.round(o.y + snapped.dy);
      const el = elFor(o.id);
      if (el) { el.style.left = `${nx}px`; el.style.top = `${ny}px`; }
      moving[i].nx = nx; moving[i].ny = ny;
    }
    drawGuides(snapped.guides);
    repaint();
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    drawGuides([]);
    for (const m of moving) elFor(m.id)?.classList.remove('moving');
    if (!moved) { paintSelection(); return; }
    editShapes(copy ? 'duplicate' : 'move', (list) => {
      for (const m of moving) {
        const t = list.find((x) => x.id === m.id);
        if (t && m.nx !== undefined) { t.x = m.nx; t.y = m.ny; }
      }
    });
    paintWires();
    paintGroupBar();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function unionOf(list) {
  return {
    l: Math.min(...list.map((s) => s.x)),
    t: Math.min(...list.map((s) => s.y)),
    r: Math.max(...list.map((s) => s.x + s.w)),
    b: Math.max(...list.map((s) => s.y + s.h)),
  };
}

/** the snapping maths: try every edge and centre of the moving box against
 *  every edge and centre of every other one, take the closest within reach. */
function snapDelta(bounds, dx, dy, others, grid) {
  const guides = [];
  let bestX = null, bestY = null;
  const moved = { l: bounds.l + dx, r: bounds.r + dx, t: bounds.t + dy, b: bounds.b + dy };
  moved.cx = (moved.l + moved.r) / 2;
  moved.cy = (moved.t + moved.b) / 2;

  for (const o of others) {
    const b = boxOf(o);
    for (const [mine, theirs] of [[moved.l, b.l], [moved.l, b.r], [moved.r, b.r], [moved.r, b.l], [moved.cx, b.cx]]) {
      const d = theirs - mine;
      if (Math.abs(d) <= SNAP && (bestX === null || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: theirs, box: b };
    }
    for (const [mine, theirs] of [[moved.t, b.t], [moved.t, b.b], [moved.b, b.b], [moved.b, b.t], [moved.cy, b.cy]]) {
      const d = theirs - mine;
      if (Math.abs(d) <= SNAP && (bestY === null || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: theirs, box: b };
    }
  }

  let outX = bestX ? dx + bestX.d : Math.round((bounds.l + dx) / grid) * grid - bounds.l;
  let outY = bestY ? dy + bestY.d : Math.round((bounds.t + dy) / grid) * grid - bounds.t;

  if (bestX) {
    const t = Math.min(bounds.t + outY, bestX.box.t) - 24;
    const b2 = Math.max(bounds.b + outY, bestX.box.b) + 24;
    guides.push({ x1: bestX.at, y1: t, x2: bestX.at, y2: b2 });
  }
  if (bestY) {
    const l = Math.min(bounds.l + outX, bestY.box.l) - 24;
    const r = Math.max(bounds.r + outX, bestY.box.r) + 24;
    guides.push({ x1: l, y1: bestY.at, x2: r, y2: bestY.at });
  }
  return { dx: outX, dy: outY, guides };
}

function drawGuides(lines) {
  const svg = $('#shape-guides');
  if (!svg) return;
  svg.innerHTML = '';
  for (const g of lines) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', g.x1); line.setAttribute('y1', g.y1);
    line.setAttribute('x2', g.x2); line.setAttribute('y2', g.y2);
    line.setAttribute('class', 'shape-guide');
    svg.append(line);
  }
}

function startResize(e, id, dir) {
  e.preventDefault();
  e.stopPropagation();
  const s = findShape(id);
  const el = elFor(id);
  if (!s || !el) return;
  const z = zoomOf();
  const startX = e.clientX, startY = e.clientY;
  const o = { x: s.x, y: s.y, w: s.w, h: s.h };
  const ratio = s.src && s.nat ? s.nat.w / Math.max(1, s.nat.h) : null;
  el.classList.add('moving');
  const repaint = rafThrottle(() => paintWires());
  let next = { ...o };

  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / z;
    const dy = (ev.clientY - startY) / z;
    let { x, y, w, h: hh } = o;
    if (dir.includes('e')) w = o.w + dx;
    if (dir.includes('s')) hh = o.h + dy;
    if (dir.includes('w')) { w = o.w - dx; x = o.x + dx; }
    if (dir.includes('n')) { hh = o.h - dy; y = o.y + dy; }
    w = Math.max(MIN_W, w);
    hh = Math.max(MIN_H, hh);
    // a picture keeps its shape unless you say otherwise
    if (ratio && !ev.altKey && dir.length === 2) {
      hh = Math.round(w / ratio);
      if (dir.includes('n')) y = o.y + o.h - hh;
    }
    if (ev.shiftKey && dir.length === 2) {
      const side = Math.max(w, hh);
      if (dir.includes('w')) x = o.x + o.w - side;
      if (dir.includes('n')) y = o.y + o.h - side;
      w = side; hh = side;
    }
    next = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
    Object.assign(el.style, { left: `${next.x}px`, top: `${next.y}px`, width: `${next.w}px`, height: `${next.h}px` });
    repaint();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    el.classList.remove('moving');
    editShapes('resize', (list) => {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, next);
    });
    paintWires();
    paintSelection();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- drawing one out

   with the box tool armed, dragging on empty plane draws the box at the size
   you drew it. a plain click drops one at the default size. */

export function startDrawShape(e, kind = null) {
  const use = kind || pen.kind;
  const start = toPlanePt(e.clientX, e.clientY);
  const layer = $('#page-shapes');
  if (!layer) return;
  const ghost = h('div.shape-ghost', { style: { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' } });
  layer.append(ghost);
  let box = null;

  const onMove = (ev) => {
    const p = toPlanePt(ev.clientX, ev.clientY);
    box = {
      x: Math.round(Math.min(start.x, p.x)), y: Math.round(Math.min(start.y, p.y)),
      w: Math.round(Math.abs(p.x - start.x)), h: Math.round(Math.abs(p.y - start.y)),
    };
    if (ev.shiftKey) { const side = Math.max(box.w, box.h); box.w = side; box.h = side; }
    Object.assign(ghost.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    ghost.remove();
    const big = box && box.w > 16 && box.h > 16;
    const s = newShape({ kind: use });
    if (big) Object.assign(s, { x: box.x, y: box.y, w: Math.max(MIN_W, box.w), h: Math.max(MIN_H, box.h) });
    else Object.assign(s, { x: Math.round(start.x - s.w / 2), y: Math.round(start.y - s.h / 2) });
    placeShape(s, { label: use === 'frame' ? 'frame' : 'box' });
    setTool('select');
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- marquee */

export function startMarquee(e) {
  const layer = $('#page-shapes');
  if (!layer) return;
  const start = toPlanePt(e.clientX, e.clientY);
  const band = h('div.shape-marquee', { style: { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' } });
  layer.append(band);
  const additive = e.shiftKey && (e.ctrlKey || e.metaKey);
  const before = new Set(picked);

  const onMove = (ev) => {
    const p = toPlanePt(ev.clientX, ev.clientY);
    const box = {
      l: Math.min(start.x, p.x), t: Math.min(start.y, p.y),
      r: Math.max(start.x, p.x), b: Math.max(start.y, p.y),
    };
    Object.assign(band.style, {
      left: `${box.l}px`, top: `${box.t}px`,
      width: `${box.r - box.l}px`, height: `${box.b - box.t}px`,
    });
    const hits = shapesOf().filter((s) => overlaps(box, boxOf(s))).map((s) => s.id);
    picked = new Set(additive ? [...before, ...hits] : hits);
    for (const el of $$('.shape')) el.classList.toggle('sel', picked.has(el.dataset.id));
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    band.remove();
    paintSelection();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- connectors

   drag off a port and let go: on another box it joins the two, on empty plane
   it makes a new box there already joined. that second one is the whole trick
   to building a map quickly — you never stop to place anything. */

function startPortDrag(e, id, side) {
  e.preventDefault();
  e.stopPropagation();
  const from = findShape(id);
  if (!from) return;
  document.body.classList.add('wiring');
  let over = null;

  const onMove = (ev) => {
    const p = toPlanePt(ev.clientX, ev.clientY);
    const el = elFor(id);
    const plane = planeOf();
    const anchor = el && plane ? sidePoint(boxOfEl(el, plane, zoomOf()), side) : { x: from.x, y: from.y };
    ghostWire(anchor, side, p);
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = hit?.closest('.shape, .blk, .freebox, .sidenote');
    if (over && over !== target) over.classList.remove('wire-target');
    over = target && target.dataset.id !== id ? target : null;
    if (over) over.classList.add('wire-target');
  };

  const onUp = async (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.classList.remove('wiring');
    clearGhost();
    over?.classList.remove('wire-target');
    const hit = document.elementFromPoint(ev.clientX, ev.clientY);
    const target = hit?.closest('.shape, .blk, .freebox, .sidenote');

    if (target && target.dataset.id && target.dataset.id !== id) {
      addWire({ kind: 'shape', id, side }, endFor(target));
      paintWires();
      return;
    }
    // let go over nothing: make the next box there, already joined
    const p = toPlanePt(ev.clientX, ev.clientY);
    if (Math.hypot(p.x - (from.x + from.w / 2), p.y - (from.y + from.h / 2)) < 30) return;
    const s = newShape({ kind: from.kind === 'frame' ? 'round' : from.kind, fill: from.fill, tone: from.tone });
    s.w = from.w; s.h = from.h;
    s.x = Math.round(p.x - s.w / 2);
    s.y = Math.round(p.y - s.h / 2);
    editShapes('box on a line', (list, c) => {
      list.push(s);
      (c.wires ||= []).push({
        id: uid('w'), from: { kind: 'shape', id, side }, to: { kind: 'shape', id: s.id },
        colour: '#a4abb3', label: '', style: 'curve', ends: 'to',
      });
    });
    renderShapes();
    paintWires();
    selectShape(s.id);
    editShape(s.id);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function endFor(el) {
  if (el.classList.contains('shape')) return { kind: 'shape', id: el.dataset.id };
  if (el.classList.contains('freebox')) return { kind: 'free', id: el.dataset.id };
  if (el.classList.contains('sidenote')) return { kind: 'side', id: el.dataset.id };
  return { kind: 'block', id: el.dataset.id };
}

/** tab from a selected box: the next one to its right, already joined */
export function branchFrom(id) {
  const from = findShape(id);
  if (!from) return;
  const s = newShape({ kind: from.kind === 'frame' ? 'round' : from.kind, fill: from.fill, tone: from.tone });
  s.w = from.w; s.h = from.h;
  s.x = from.x + from.w + 90;
  s.y = from.y;
  // slide down past anything already sitting there
  while (shapesOf().some((o) => o.kind !== 'frame' && overlaps(boxOf(s), boxOf(o)))) s.y += s.h + 26;
  editShapes('box on a line', (list, c) => {
    list.push(s);
    (c.wires ||= []).push({
      id: uid('w'), from: { kind: 'shape', id, side: 'right' }, to: { kind: 'shape', id: s.id, side: 'left' },
      colour: '#a4abb3', label: '', style: 'curve', ends: 'to',
    });
  });
  renderShapes();
  paintWires();
  selectShape(s.id);
  editShape(s.id);
}

/* ---------------------------------------------------------------- pictures

   "if i drag an image it should fit into the box and make the box bigger
   depending on size" — so the box takes the picture's shape, at something
   close to its real size, clamped to something you can still see whole. */

const PIC_MIN = 180;
const PIC_MAX = 620;

function sizeForPicture(nat, keepW = null) {
  const ratio = nat.h / Math.max(1, nat.w);
  const w = Math.round(keepW || clamp(nat.w, PIC_MIN, PIC_MAX));
  return { w, h: Math.max(MIN_H, Math.round(w * ratio)) };
}

function measure(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => resolve({ w: 1600, h: 900 });
    probe.src = url;
  });
}

/** put a picture inside an existing box and reshape the box around it */
export async function putImageInShape(id, file) {
  if (!file?.type?.startsWith('image/')) { toast('that is not a picture', { kind: 'warn' }); return; }
  const preview = URL.createObjectURL(file);
  const nat = await measure(preview);
  const hasText = !!stripHtml(findShape(id)?.html || '').trim();
  const size = sizeForPicture(nat);

  editShapes('picture in a box', (list) => {
    const t = list.find((x) => x.id === id);
    if (!t) return;
    t.pending = preview;
    t.nat = nat;
    t.fit = t.fit || 'contain';
    t.w = size.w;
    t.h = size.h + (hasText ? 34 : 0);
    if (hasText) t.valign = 'bottom';
  });
  renderShapes();
  paintWires();

  try {
    const { uploadImage } = await import('./images.js?v=44ebe426f1');
    const src = await uploadImage(file);
    editShapes('picture in a box', (list) => {
      const t = list.find((x) => x.id === id);
      if (t) { t.src = src; delete t.pending; }
    });
    renderShapes();
    toast('picture saved with the board', { kind: 'ok', ms: 1600 });
  } catch (err) {
    toast(`could not save the picture: ${err.message}`, { kind: 'error' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 8000);
  }
  bus.emit('boards');
}

/** a picture dropped on open plane becomes its own box, sized to the picture */
export async function imageShapeAt(planePoint, file) {
  const s = newShape({ kind: 'rect', tone: 'none', fill: '#68707c' });
  const preview = URL.createObjectURL(file);
  const nat = await measure(preview);
  const size = sizeForPicture(nat);
  Object.assign(s, {
    w: size.w, h: size.h,
    x: Math.round(planePoint.x - size.w / 2), y: Math.round(planePoint.y - size.h / 2),
    pending: preview, nat, fit: 'contain',
  });
  placeShape(s, { label: 'picture', edit: false });

  try {
    const { uploadImage } = await import('./images.js?v=44ebe426f1');
    const src = await uploadImage(file);
    editShapes('picture', (list) => {
      const t = list.find((x) => x.id === s.id);
      if (t) { t.src = src; delete t.pending; }
    });
    renderShapes();
  } catch (err) {
    toast(`could not save the picture: ${err.message}`, { kind: 'error' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 8000);
  }
  bus.emit('boards');
  return s;
}

export function pickImageForShape(id) {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await putImageInShape(id, file);
    input.remove();
  });
  input.click();
}

/* ---------------------------------------------------------------- arranging */

export function alignSelection(edge) {
  const list = [...picked].map((id) => findShape(id)).filter(Boolean);
  if (list.length < 2) return;
  const boxes = list.map(boxOf);
  const target = {
    left: Math.min(...boxes.map((b) => b.l)),
    right: Math.max(...boxes.map((b) => b.r)),
    top: Math.min(...boxes.map((b) => b.t)),
    bottom: Math.max(...boxes.map((b) => b.b)),
    cx: (Math.min(...boxes.map((b) => b.l)) + Math.max(...boxes.map((b) => b.r))) / 2,
    cy: (Math.min(...boxes.map((b) => b.t)) + Math.max(...boxes.map((b) => b.b))) / 2,
  }[edge];

  editShapes('line them up', (all) => {
    for (const s of list) {
      const t = all.find((x) => x.id === s.id);
      if (!t) continue;
      if (edge === 'left') t.x = Math.round(target);
      if (edge === 'right') t.x = Math.round(target - t.w);
      if (edge === 'cx') t.x = Math.round(target - t.w / 2);
      if (edge === 'top') t.y = Math.round(target);
      if (edge === 'bottom') t.y = Math.round(target - t.h);
      if (edge === 'cy') t.y = Math.round(target - t.h / 2);
    }
  });
  renderShapes();
  paintWires();
}

export function distribute(axis) {
  const list = [...picked].map((id) => findShape(id)).filter(Boolean);
  if (list.length < 3) { toast('pick three or more to space out', { ms: 1800 }); return; }
  const key = axis === 'x' ? 'x' : 'y';
  const span = axis === 'x' ? 'w' : 'h';
  const sorted = [...list].sort((a, b) => a[key] - b[key]);
  const first = sorted[0][key];
  const last = sorted.at(-1)[key] + sorted.at(-1)[span];
  const used = sorted.reduce((n, s) => n + s[span], 0);
  const gap = (last - first - used) / (sorted.length - 1);

  editShapes('space them out', (all) => {
    let at = first;
    for (const s of sorted) {
      const t = all.find((x) => x.id === s.id);
      if (t) t[key] = Math.round(at);
      at += s[span] + gap;
    }
  });
  renderShapes();
  paintWires();
}

export function sameSize() {
  const list = [...picked].map((id) => findShape(id)).filter(Boolean);
  if (list.length < 2) return;
  const w = Math.round(list.reduce((n, s) => n + s.w, 0) / list.length);
  const hh = Math.round(list.reduce((n, s) => n + s.h, 0) / list.length);
  editShapes('same size', (all) => {
    for (const s of list) {
      const t = all.find((x) => x.id === s.id);
      if (t && !t.src) { t.w = w; t.h = hh; }
    }
  });
  renderShapes();
  paintWires();
}

/** pack the selection (or everything, if nothing is selected) into a grid */
export function tidySelection() {
  const list = (picked.size > 1 ? [...picked].map((id) => findShape(id)) : shapesOf().filter((s) => s.kind !== 'frame'))
    .filter(Boolean);
  if (list.length < 2) { toast('nothing to tidy yet', { ms: 1600 }); return; }
  const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
  const left = Math.min(...list.map((s) => s.x));
  const top = Math.min(...list.map((s) => s.y));
  const colW = Math.max(...list.map((s) => s.w)) + 40;
  const rowH = Math.max(...list.map((s) => s.h)) + 40;
  const cols = Math.max(1, Math.round(Math.sqrt(sorted.length)));

  editShapes('tidy up', (all) => {
    sorted.forEach((s, i) => {
      const t = all.find((x) => x.id === s.id);
      if (!t) return;
      t.x = Math.round(left + (i % cols) * colW);
      t.y = Math.round(top + Math.floor(i / cols) * rowH);
    });
  });
  renderShapes();
  paintWires();
  toast('tidied into a grid · ctrl+z to undo', { kind: 'ok', ms: 2200 });
}

export function orderSelection(where) {
  const ids = [...picked];
  if (!ids.length) return;
  editShapes(where === 'front' ? 'bring to front' : 'send to back', (all) => {
    const top = all.length ? Math.max(...all.map((s) => s.z || 0)) : 0;
    const bottom = all.length ? Math.min(...all.map((s) => s.z || 0)) : 0;
    ids.forEach((id, i) => {
      const t = all.find((x) => x.id === id);
      if (t) t.z = where === 'front' ? top + 1 + i : bottom - 1 - i;
    });
  });
  renderShapes();
}

/* ---------------------------------------------------------------- copy, delete */

let clipboard = [];

function cloneShapes(ids, dx = 26, dy = 26, label = 'duplicate') {
  const source = ids.map((id) => findShape(id)).filter(Boolean);
  if (!source.length) return [];
  const remap = new Map();
  const copies = source.map((s) => {
    const copy = { ...s, id: uid('sh'), x: s.x + dx, y: s.y + dy, z: 0 };
    delete copy.pending;
    remap.set(s.id, copy.id);
    return copy;
  });
  editShapes(label, (list, c) => {
    let top = list.length ? Math.max(...list.map((s) => s.z || 0)) : 0;
    for (const copy of copies) { copy.z = ++top; list.push(copy); }
    // lines that joined two copied boxes get copied with them
    for (const w of c.wires || []) {
      if (remap.has(w.from.id) && remap.has(w.to.id)) {
        (c.wires ||= []).push({
          ...w, id: uid('w'),
          from: { ...w.from, id: remap.get(w.from.id) },
          to: { ...w.to, id: remap.get(w.to.id) },
        });
      }
    }
  });
  renderShapes();
  paintWires();
  return copies.map((c) => c.id);
}

export function duplicateSelection() {
  const made = cloneShapes([...picked]);
  if (made.length) selectShapes(made);
}

export function copySelection({ cut = false } = {}) {
  clipboard = [...picked].map((id) => findShape(id)).filter(Boolean).map((s) => JSON.parse(JSON.stringify(s)));
  if (!clipboard.length) return false;
  if (cut) deleteSelection();
  else toast(`${clipboard.length} copied`, { ms: 1200 });
  return true;
}

export function pasteShapes(at = null) {
  if (!clipboard.length) return false;
  const base = { x: Math.min(...clipboard.map((s) => s.x)), y: Math.min(...clipboard.map((s) => s.y)) };
  const dx = at ? at.x - base.x : 30;
  const dy = at ? at.y - base.y : 30;
  const made = [];
  editShapes('paste', (list) => {
    let top = list.length ? Math.max(...list.map((s) => s.z || 0)) : 0;
    for (const s of clipboard) {
      const copy = { ...JSON.parse(JSON.stringify(s)), id: uid('sh'), x: Math.round(s.x + dx), y: Math.round(s.y + dy), z: ++top };
      delete copy.pending;
      list.push(copy);
      made.push(copy.id);
    }
  });
  renderShapes();
  selectShapes(made);
  return true;
}

export function deleteSelection() {
  const ids = new Set([...picked]);
  if (!ids.size) return;
  const n = ids.size;
  stopEditing();
  editShapes(n === 1 ? 'delete a box' : `delete ${n} boxes`, (list, c) => {
    const keep = list.filter((s) => !ids.has(s.id));
    list.length = 0;
    list.push(...keep);
    // a line to a box that is gone points at nothing — take it in the same step
    if (c.wires) c.wires = c.wires.filter((w) => !ids.has(w.from.id) && !ids.has(w.to.id));
  });
  picked.clear();
  renderShapes();
  paintWires();
}

/* ---------------------------------------------------------------- editing one */

function patchSelection(label, patch) {
  const ids = [...picked];
  if (!ids.length) return;
  editShapes(label, (list) => {
    for (const id of ids) {
      const t = list.find((x) => x.id === id);
      if (t) Object.assign(t, typeof patch === 'function' ? patch(t) : patch);
    }
  });
  renderShapes();
  paintWires();
}

export function setFill(hex, tone) {
  if (hex) pen.fill = hex;
  if (tone) pen.tone = tone;
  patchSelection('recolour', (t) => ({
    fill: hex || t.fill,
    tone: tone || t.tone || 'solid',
  }));
}

export function setKind(kind) {
  pen.kind = kind;
  patchSelection('change shape', { kind });
}

/** make one of these boxes its own page, and keep a way back to it */
async function makeSubPage(id) {
  const s = findShape(id);
  if (!s) return;
  if (s.cardId) { openCardPage(s.cardId); return; }
  const title = stripHtml(s.html || '').trim().slice(0, 60) || 'new page';
  const made = makeCard(state.cardId, { title });
  editShapes('box becomes a page', (list) => {
    const t = list.find((x) => x.id === id);
    if (t) t.cardId = made.id;
  });
  renderShapes();
  toast('this box is a page now — click the badge to open it', { kind: 'ok', ms: 2600 });
}

export function shapeMenu(id, x, y) {
  const s = findShape(id);
  if (!s) return;
  const many = picked.size > 1;

  const fillRow = FILLS.map(([name, hex]) => ({
    icon: 'box', color: hex, tip: name,
    onPick: () => setFill(hex, s.tone === 'solid' || !s.tone ? 'solid' : s.tone),
  }));

  contextMenu([
    { header: many ? `${picked.size} boxes` : 'this box' },
    { row: fillRow },
    {
      label: 'how it is filled', icon: 'palette', subWidth: 200,
      sub: [
        { label: 'solid', icon: 'box', checked: (s.tone || 'solid') === 'solid', onPick: () => setFill(null, 'solid') },
        { label: 'soft tint', icon: 'highlight', checked: s.tone === 'soft', onPick: () => setFill(null, 'soft') },
        { label: 'outline only', icon: 'ellipse', checked: s.tone === 'none', onPick: () => setFill(null, 'none') },
        { sep: true },
        { label: s.dash ? 'solid edge' : 'dashed edge', icon: 'line', onPick: () => patchSelection('edge', { dash: !s.dash }) },
        { label: 'thicker edge', icon: 'pen', onPick: () => patchSelection('edge', (t) => ({ weight: ((t.weight || 1.5) >= 4 ? 1 : (t.weight || 1.5) + 1) })) },
      ],
    },
    {
      label: 'shape', icon: 'box', subWidth: 200,
      sub: KINDS.map(([kind, ico, label]) => ({
        label, icon: ico, checked: s.kind === kind, onPick: () => setKind(kind),
      })),
    },
    {
      label: 'text', icon: 'textTool', subWidth: 210,
      sub: [
        { label: 'edit the text', icon: 'pen', onPick: () => editShape(id) },
        { sep: true },
        { label: 'left', icon: 'alignLeft', checked: s.align === 'left', onPick: () => patchSelection('align text', { align: 'left' }) },
        { label: 'centred', icon: 'alignCenter', checked: (s.align || 'center') === 'center', onPick: () => patchSelection('align text', { align: 'center' }) },
        { label: 'right', icon: 'alignRight', checked: s.align === 'right', onPick: () => patchSelection('align text', { align: 'right' }) },
        { sep: true },
        { label: 'top of the box', icon: 'alignT', checked: s.valign === 'top', onPick: () => patchSelection('align text', { valign: 'top' }) },
        { label: 'middle', icon: 'alignHC', checked: (s.valign || 'middle') === 'middle', onPick: () => patchSelection('align text', { valign: 'middle' }) },
        { label: 'bottom', icon: 'alignB', checked: s.valign === 'bottom', onPick: () => patchSelection('align text', { valign: 'bottom' }) },
        { sep: true },
        { label: 'bigger', icon: 'plus', onPick: () => patchSelection('text size', (t) => ({ size: Math.min(48, (t.size || 15) + 2) })) },
        { label: 'smaller', icon: 'minus', onPick: () => patchSelection('text size', (t) => ({ size: Math.max(9, (t.size || 15) - 2) })) },
        { label: 'monospace', icon: 'codeTag', checked: s.font === 'mono', onPick: () => patchSelection('font', { font: s.font === 'mono' ? null : 'mono' }) },
      ],
    },
    { sep: true },
    {
      label: s.src ? 'replace the picture' : 'put a picture in it', icon: 'image',
      onPick: () => pickImageForShape(id),
    },
    s.src ? {
      label: s.fit === 'cover' ? 'show the whole picture' : 'fill the box with it', icon: 'crop',
      onPick: () => patchSelection('picture fit', { fit: s.fit === 'cover' ? 'contain' : 'cover' }),
    } : null,
    s.src ? {
      label: 'size the box to the picture', icon: 'fit',
      onPick: () => patchSelection('fit to picture', (t) => (t.nat ? sizeForPicture(t.nat) : {})),
    } : null,
    s.src ? {
      label: 'keep it as a preset', icon: 'plus', hint: 'every session',
      onPick: async () => (await import('./presets.js?v=44ebe426f1')).addPresetFromSrc(s.src, stripHtml(s.html || '') || 'my picture'),
    } : null,
    s.src ? { label: 'take the picture out', icon: 'close', onPick: () => patchSelection('remove picture', { src: null, pending: null, nat: null }) } : null,
    { sep: true },
    { label: 'draw a line from here', icon: 'link', hint: 'or drag a dot', onPick: () => { selectShape(id); toast('drag one of the four dots on the edge', { ms: 2600 }); } },
    { label: 'a new box, joined on', icon: 'arrowR', hint: 'tab', onPick: () => branchFrom(id) },
    { label: s.cardId ? 'open its page' : 'make it a page of its own', icon: 'cards', onPick: () => makeSubPage(id) },
    { sep: true },
    many ? { label: 'line them up', icon: 'alignVC', subWidth: 210, sub: [
      { label: 'left edges', icon: 'alignL', onPick: () => alignSelection('left') },
      { label: 'centres', icon: 'alignVC', onPick: () => alignSelection('cx') },
      { label: 'right edges', icon: 'alignR', onPick: () => alignSelection('right') },
      { sep: true },
      { label: 'tops', icon: 'alignT', onPick: () => alignSelection('top') },
      { label: 'middles', icon: 'alignHC', onPick: () => alignSelection('cy') },
      { label: 'bottoms', icon: 'alignB', onPick: () => alignSelection('bottom') },
      { sep: true },
      { label: 'space out across', icon: 'distH', onPick: () => distribute('x') },
      { label: 'space out down', icon: 'distV', onPick: () => distribute('y') },
      { label: 'all the same size', icon: 'expand', onPick: () => sameSize() },
      { label: 'tidy into a grid', icon: 'tidy', onPick: () => tidySelection() },
    ] } : null,
    { label: 'bring to the front', icon: 'toFront', onPick: () => orderSelection('front') },
    { label: 'send to the back', icon: 'toBack', onPick: () => orderSelection('back') },
    { label: s.locked ? 'unlock' : 'lock it in place', icon: s.locked ? 'unlock' : 'lock', onPick: () => patchSelection('lock', { locked: !s.locked }) },
    { sep: true },
    { label: 'duplicate', icon: 'copy', hint: 'ctrl+d', onPick: () => duplicateSelection() },
    { label: 'copy', icon: 'copy', hint: 'ctrl+c', onPick: () => copySelection() },
    { label: many ? `delete ${picked.size} boxes` : 'delete this box', icon: 'trash', danger: true, hint: 'del', onPick: () => deleteSelection() },
  ].filter(Boolean), { x, y, width: 250 });
}

/* ---------------------------------------------------------------- keys

   these run before the app-wide shortcuts and only when a box is selected and
   you are not typing, so nothing here can eat a keystroke meant for the text. */

document.addEventListener('keydown', (e) => {
  if (state.route.name !== 'page') return;
  const el = document.activeElement;
  const typing = el?.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(el?.tagName || '');
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'v' && !typing && clipboard.length) {
    e.preventDefault();
    e.stopPropagation();
    pasteShapes();
    return;
  }
  if (!picked.size || typing) return;

  const key = e.key.toLowerCase();

  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteSelection(); return; }
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); editShape([...picked][0]); return; }
  if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); branchFrom([...picked][0]); return; }
  if (mod && key === 'd') { e.preventDefault(); e.stopPropagation(); duplicateSelection(); return; }
  if (mod && key === 'c') { e.preventDefault(); e.stopPropagation(); copySelection(); return; }
  if (mod && key === 'x') { e.preventDefault(); e.stopPropagation(); copySelection({ cut: true }); return; }
  if (mod && key === 'a') { e.preventDefault(); e.stopPropagation(); selectShapes(shapesOf().map((s) => s.id)); return; }
  if (mod && e.key === ']') { e.preventDefault(); orderSelection('front'); return; }
  if (mod && e.key === '[') { e.preventDefault(); orderSelection('back'); return; }

  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 20 : (state.settings.gridSnap !== false ? (state.settings.snapSize || 8) : 1);
    const dx = (e.key === 'ArrowRight' ? step : 0) - (e.key === 'ArrowLeft' ? step : 0);
    const dy = (e.key === 'ArrowDown' ? step : 0) - (e.key === 'ArrowUp' ? step : 0);
    patchSelection('nudge', (t) => ({ x: t.x + dx, y: t.y + dy }));
  }
}, true);

/* the plane repaints on undo/redo through page.js, but the counter-scale of
   the handles has to follow every zoom change */
bus.on('page:reflow', () => { syncZoom(); paintGroupBar(); });
bus.on('board:open', () => { picked.clear(); editingId = null; });
