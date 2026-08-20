/* the whiteboard tool rail.

   a webex-style rail down the left of the plane. the top half puts *things*
   on the board — boxes, sticky notes, text, pictures, frames, and the lines
   between them (js/shapes.js owns those). the bottom half is ink: pen,
   highlighter, freehand shapes and an eraser, drawn straight onto the plane
   in plane coordinates so it pans and zooms with everything else and never
   touches your text.
*/

import { $, $$, h, clear, uid } from './util.js?v=2e4abb3f3d';
import { icon } from './icons.js?v=2e4abb3f3d';
import { state, card, commit, bus, undo, redo } from './store.js?v=2e4abb3f3d';
import { toast } from './ui.js?v=2e4abb3f3d';
import { FILLS, KINDS, shapePen, setShapePen, startDrawShape, addShapeAt } from './shapes.js?v=2e4abb3f3d';
import { startWire, wiring, cancelWire } from './wires.js?v=2e4abb3f3d';

export const PEN_COLOURS = [
  ['chalk', 'var(--text)'],
  ['red', '#ff4d5e'],
  ['amber', '#ffc357'],
  ['mint', '#4fd1a5'],
  ['sky', '#4db8ff'],
  ['violet', '#b98cff'],
];

export const STICKY_COLOURS = ['#ffd54a', '#ff9db1', '#8ce99a', '#74c0fc', '#d3b4ff', '#ffb27a'];

/* two groups, one rail. the separator between them is the difference between
   "put something on the board" and "draw on top of it". */
const TOOLS = [
  ['select', 'target', 'select · v'],
  ['box', 'roundBox', 'box · r'],
  ['sticky', 'note', 'sticky note · n'],
  ['text', 'textTool', 'text · x'],
  ['picture', 'image', 'picture'],
  ['frame', 'frame', 'frame · f'],
  ['connect', 'link', 'join two things · c'],
  null,
  ['pen', 'pen', 'pen · b'],
  ['marker', 'highlight', 'highlighter · m'],
  ['shape', 'ellipse', 'draw a shape in ink · shift+r'],
  ['eraser', 'eraser', 'rub ink out · e'],
];

const SHAPES = [
  ['box', 'box', 'rectangle'],
  ['ellipse', 'ellipse', 'ellipse'],
  ['arrow', 'arrow', 'arrow'],
  ['line', 'line', 'line'],
];

const TONES = [
  ['solid', 'box', 'solid'],
  ['soft', 'highlight', 'soft tint'],
  ['none', 'ellipse', 'outline only'],
];

let tool = 'select';
let colour = 'red';
let shape = 'box';
let size = 4;
let stickyColour = STICKY_COLOURS[0];
let inkSvg = null;
let temp = null;
let host = null;

export const activeTool = () => tool;
/** true when the pointer belongs to a tool rather than to selection */
export const inkBusy = () => tool !== 'select';
/** the tools that draw a thing by dragging a box out on the plane */
export const boxTool = () => tool === 'box' || tool === 'frame';

/* ---------------------------------------------------------------- mounting */

export function mountWhiteboard(work, viewport, plane) {
  host = work;
  work.append(rail(), optionsStrip(), zoomPill());
  inkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  inkSvg.setAttribute('class', 'page-ink');
  inkSvg.id = 'page-ink';
  plane.append(inkSvg);
  renderInk();
  bindDrawing(viewport);
  paintTool();
}

export function setTool(next) {
  if (next !== 'connect' && wiring()) cancelWire();
  tool = next;
  paintTool();
  const vp = $('.page-viewport');
  if (vp) vp.dataset.tool = tool;
}

function paintTool() {
  for (const b of $$('.wb-tool')) b.classList.toggle('on', b.dataset.tool === tool);
  const strip = $('#wb-options');
  if (!strip) return;
  clear(strip);
  const drawing = ['pen', 'marker', 'shape'].includes(tool);
  strip.classList.toggle('show', drawing || tool === 'sticky' || boxTool());

  if (boxTool()) { paintBoxOptions(strip); return; }

  if (tool === 'sticky') {
    strip.append(h('div.wb-swatches', ...STICKY_COLOURS.map((c) => h('button.wb-swatch', {
      class: stickyColour === c ? 'on' : '', style: { background: c }, tip: 'sticky colour',
      on: { click: () => { stickyColour = c; paintTool(); } },
    }))));
    return;
  }
  if (!drawing) return;

  if (tool === 'shape') {
    strip.append(h('div.wb-shapes', ...SHAPES.map(([id, ico, tip]) => h('button.wb-shape', {
      class: shape === id ? 'on' : '', tip,
      on: { click: () => { shape = id; paintTool(); } },
    }, icon(ico, { size: 15 })))));
  }
  strip.append(h('div.wb-swatches', ...PEN_COLOURS.map(([name, css]) => h('button.wb-swatch', {
    class: colour === name ? 'on' : '', style: { background: css }, tip: name,
    on: { click: () => { colour = name; paintTool(); } },
  }))));
  strip.append(h('div.wb-size',
    ...[2, 4, 7, 12].map((n) => h('button.wb-dot', {
      class: size === n ? 'on' : '', tip: `${n}px`,
      on: { click: () => { size = n; paintTool(); } },
    }, h('i', { style: { width: `${Math.min(14, n + 2)}px`, height: `${Math.min(14, n + 2)}px` } })))));
}

/** what the next box will look like: its outline, its fill, how it is filled.
 *  the same three choices are on a box's right-click menu, so this panel is a
 *  shortcut rather than the only way in. */
function paintBoxOptions(strip) {
  const pen = shapePen();
  strip.append(h('div.wb-label', { text: tool === 'frame' ? 'frame' : 'next box' }));
  strip.append(h('div.wb-kinds', ...KINDS.filter(([k]) => k !== 'frame').map(([kind, ico, tip]) => h('button.wb-shape', {
    class: pen.kind === kind ? 'on' : '', tip,
    on: { click: () => { setShapePen({ kind }); paintTool(); } },
  }, icon(ico, { size: 15 })))));
  strip.append(h('div.wb-swatches.wb-wrap', ...FILLS.map(([name, hex]) => h('button.wb-swatch', {
    class: pen.fill === hex ? 'on' : '', style: { background: hex }, tip: name,
    on: { click: () => { setShapePen({ fill: hex }); paintTool(); } },
  }))));
  strip.append(h('div.wb-shapes', ...TONES.map(([id, ico, tip]) => h('button.wb-shape', {
    class: pen.tone === id ? 'on' : '', tip,
    on: { click: () => { setShapePen({ tone: id }); paintTool(); } },
  }, icon(ico, { size: 15 })))));
  strip.append(h('div.wb-hint', { text: 'drag to draw it, or click for a standard one' }));
}

function rail() {
  return h('div.wb-rail',
    ...TOOLS.map((entry) => (entry ? h('button.wb-tool', {
      class: tool === entry[0] ? 'on' : '', data: { tool: entry[0] }, tip: entry[2],
      on: { click: () => pickTool(entry[0]) },
    }, icon(entry[1], { size: 17 })) : h('div.wb-rail-sep'))),
    h('div.wb-rail-sep'),
    h('button.wb-tool.wb-small', { tip: 'undo · ctrl+z', on: { click: () => { const l = undo(); if (l) toast(`undid ${l}`, { ms: 1200 }); } } }, icon('undo', { size: 16 })),
    h('button.wb-tool.wb-small', { tip: 'redo · ctrl+shift+z', on: { click: () => { const l = redo(); if (l) toast(`redid ${l}`, { ms: 1200 }); } } }, icon('redo', { size: 16 })),
    h('button.wb-tool.wb-small', { tip: 'rub out every ink mark on this page', on: { click: clearInk } }, icon('eraser', { size: 16 })),
  );
}

async function pickTool(id) {
  if (id === 'picture') {
    const { pickImageFile } = await import('./images.js?v=2e4abb3f3d');
    const blocks = card(state.cardId)?.blocks || [];
    pickImageFile(blocks.at(-1)?.id);
    return;
  }
  if (id === 'connect') {
    setTool('select');
    startWire();
    return;
  }
  setTool(id);
  if (id !== 'select') toast(hintFor(id), { ms: 1600 });
}

const hintFor = (id) => ({
  box: 'drag out a box, or click to drop a standard one',
  frame: 'drag out a frame — everything inside it moves with it',
  sticky: 'click to drop a sticky note',
  text: 'click anywhere to start writing there',
  pen: 'draw anywhere on the plane',
  marker: 'highlight anywhere — it sits under your text',
  shape: 'drag to draw a shape in ink',
  eraser: 'drag over ink to rub it out',
}[id] || '');

function optionsStrip() {
  return h('div.wb-options#wb-options');
}

function zoomPill() {
  return h('div.wb-zoom',
    h('button.wb-zoom-btn', { tip: 'zoom out · ctrl+-', on: { click: async () => (await import('./page.js?v=2e4abb3f3d')).setPageZoom((await import('./page.js?v=2e4abb3f3d')).pageZoom() * 0.9) } }, icon('minus', { size: 15 })),
    h('button.wb-zoom-val#wb-zoom-val', { tip: 'back to 100% · ctrl+0', text: '100%', on: { click: async () => (await import('./page.js?v=2e4abb3f3d')).resetPageView() } }),
    h('button.wb-zoom-btn', { tip: 'zoom in · ctrl++', on: { click: async () => (await import('./page.js?v=2e4abb3f3d')).setPageZoom((await import('./page.js?v=2e4abb3f3d')).pageZoom() * 1.1) } }, icon('plus', { size: 15 })),
    h('span.wb-zoom-sep'),
    h('button.wb-zoom-btn', { tip: 'fit everything on the board on screen', on: { click: async () => (await import('./page.js?v=2e4abb3f3d')).fitBoard() } }, icon('fit', { size: 15 })),
  );
}

export function paintZoomPill(z) {
  const el = $('#wb-zoom-val');
  if (el) el.textContent = `${Math.round(z * 100)}%`;
}

/* ---------------------------------------------------------------- ink */

const inkOf = () => card(state.cardId)?.ink || [];

export function renderInk() {
  if (!inkSvg) return;
  inkSvg.innerHTML = '';
  const list = temp ? [...inkOf(), temp] : inkOf();
  for (const stroke of list) inkSvg.append(shapeFor(stroke));
}

function shapeFor(s) {
  const NS = 'http://www.w3.org/2000/svg';
  const colourOf = PEN_COLOURS.find((c) => c[0] === s.colour)?.[1] || s.colour || 'var(--text)';
  let el;

  if (s.tool === 'pen' || s.tool === 'marker') {
    el = document.createElementNS(NS, 'polyline');
    el.setAttribute('points', (s.pts || []).map((p) => `${p[0]},${p[1]}`).join(' '));
    el.setAttribute('fill', 'none');
  } else if (s.shape === 'ellipse') {
    el = document.createElementNS(NS, 'ellipse');
    el.setAttribute('cx', (s.x + s.x2) / 2); el.setAttribute('cy', (s.y + s.y2) / 2);
    el.setAttribute('rx', Math.abs(s.x2 - s.x) / 2); el.setAttribute('ry', Math.abs(s.y2 - s.y) / 2);
    el.setAttribute('fill', 'none');
  } else if (s.shape === 'arrow' || s.shape === 'line') {
    el = document.createElementNS(NS, 'line');
    el.setAttribute('x1', s.x); el.setAttribute('y1', s.y);
    el.setAttribute('x2', s.x2); el.setAttribute('y2', s.y2);
    if (s.shape === 'arrow') el.setAttribute('marker-end', 'url(#ink-arrow)');
  } else {
    el = document.createElementNS(NS, 'rect');
    el.setAttribute('x', Math.min(s.x, s.x2)); el.setAttribute('y', Math.min(s.y, s.y2));
    el.setAttribute('width', Math.abs(s.x2 - s.x)); el.setAttribute('height', Math.abs(s.y2 - s.y));
    el.setAttribute('rx', 8);
    el.setAttribute('fill', 'none');
  }

  el.setAttribute('stroke', colourOf);
  el.setAttribute('stroke-width', s.tool === 'marker' ? (s.size || 4) * 4 : (s.size || 4));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (s.tool === 'marker') { el.setAttribute('stroke-opacity', '.28'); el.setAttribute('stroke-linecap', 'butt'); }
  el.dataset.id = s.id;
  el.setAttribute('class', 'ink-stroke');
  return el;
}

function ensureDefs() {
  if (!inkSvg || inkSvg.querySelector('defs')) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `<marker id="ink-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker>`;
  inkSvg.prepend(defs);
}

function bindDrawing(viewport) {
  viewport.dataset.tool = tool;

  viewport.addEventListener('pointerdown', async (e) => {
    if (tool === 'select' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // before the await: a quick click must not outrun the module import and
    // lose its own pointerup
    if (boxTool()) { startDrawShape(e, tool === 'frame' ? 'frame' : null); return; }

    const { toPlane } = await import('./page.js?v=2e4abb3f3d');
    const p = toPlane(e.clientX, e.clientY);

    if (tool === 'sticky') { dropSticky(p); return; }
    if (tool === 'text') { dropText(p); return; }
    if (tool === 'eraser') { startErase(viewport); return; }

    temp = tool === 'shape'
      ? { id: uid('ink'), tool: 'shape', shape, colour, size, x: p.x, y: p.y, x2: p.x, y2: p.y }
      : { id: uid('ink'), tool, colour, size, pts: [[p.x, p.y]] };
    ensureDefs();
    renderInk();

    const move = async (ev) => {
      if (!temp) return;
      const q = toPlane(ev.clientX, ev.clientY);
      if (temp.pts) {
        const last = temp.pts.at(-1);
        if (Math.hypot(q.x - last[0], q.y - last[1]) > 2) temp.pts.push([Math.round(q.x), Math.round(q.y)]);
      } else {
        temp.x2 = q.x; temp.y2 = q.y;
        if (ev.shiftKey) {
          const side = Math.max(Math.abs(q.x - temp.x), Math.abs(q.y - temp.y));
          temp.x2 = temp.x + Math.sign(q.x - temp.x) * side;
          temp.y2 = temp.y + Math.sign(q.y - temp.y) * side;
        }
      }
      renderInk();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      const s = temp;
      temp = null;
      if (!s) return;
      const big = s.pts ? s.pts.length > 2 : Math.hypot(s.x2 - s.x, s.y2 - s.y) > 8;
      if (big) {
        const cardId = state.cardId;
        commit('draw', (b) => { (b.cards[cardId].ink ||= []).push(s); });
      }
      renderInk();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }, true);
}

function startErase(viewport) {
  const cardId = state.cardId;
  const gone = new Set();
  const hit = async (ev) => {
    const { toPlane } = await import('./page.js?v=2e4abb3f3d');
    const p = toPlane(ev.clientX, ev.clientY);
    for (const s of inkOf()) {
      if (gone.has(s.id)) continue;
      if (near(s, p)) gone.add(s.id);
    }
    if (gone.size) {
      for (const el of inkSvg.querySelectorAll('.ink-stroke')) {
        if (gone.has(el.dataset.id)) el.style.opacity = '.2';
      }
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', hit);
    document.removeEventListener('pointerup', up);
    if (!gone.size) return;
    commit('erase', (b) => { b.cards[cardId].ink = (b.cards[cardId].ink || []).filter((s) => !gone.has(s.id)); });
    renderInk();
  };
  document.addEventListener('pointermove', hit);
  document.addEventListener('pointerup', up);
}

function near(s, p, r = 14) {
  if (s.pts) return s.pts.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < r);
  const x1 = Math.min(s.x, s.x2) - r, x2 = Math.max(s.x, s.x2) + r;
  const y1 = Math.min(s.y, s.y2) - r, y2 = Math.max(s.y, s.y2) + r;
  return p.x > x1 && p.x < x2 && p.y > y1 && p.y < y2;
}

function clearInk() {
  if (!inkOf().length) { toast('no ink on this page', { ms: 1400 }); return; }
  const cardId = state.cardId;
  const n = inkOf().length;
  commit('clear ink', (b) => { b.cards[cardId].ink = []; });
  renderInk();
  toast(`rubbed out ${n} marks`, { kind: 'ok', action: { label: 'undo', fn: () => { undo(); renderInk(); } } });
}

/* ---------------------------------------------------------------- things on the board

   a sticky note and a text box are both shapes now, so they can be selected
   with a marquee, lined up with everything else and joined with a line. the
   old `free[]` boxes still render and still work — they are just not what a
   new one is made of. */

function dropSticky(p) {
  addShapeAt(p, { kind: 'sticky', fill: stickyColour, tone: 'solid', align: 'left', valign: 'top' });
  setTool('select');
}

function dropText(p) {
  addShapeAt(p, { kind: 'rect', tone: 'text', align: 'left', valign: 'top', w: 240, h: 60 });
  setTool('select');
}

/* ---------------------------------------------------------------- keys */

document.addEventListener('keydown', (e) => {
  if (state.route.name !== 'page') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el?.isContentEditable || /INPUT|TEXTAREA/.test(el?.tagName || '')) return;
  const key = e.key.toLowerCase();
  const map = { v: 'select', b: 'pen', m: 'marker', n: 'sticky', x: 'text', e: 'eraser', f: 'frame' };
  const next = key === 'r' ? (e.shiftKey ? 'shape' : 'box') : map[key];
  if (!next) return;
  e.preventDefault();
  setTool(next);
});

bus.on('replace', () => renderInk());
