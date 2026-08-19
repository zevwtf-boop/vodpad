/* the whiteboard layer.

   a webex-style tool rail down the left of the plane: pen, highlighter,
   shapes, sticky notes, text and an eraser. ink lives on the plane in plane
   coordinates, so it pans and zooms with everything else and never touches
   your text.
*/

import { $, $$, h, clear, uid, clamp, debounce } from './util.js?v=66fb115653';
import { icon } from './icons.js?v=66fb115653';
import { state, card, commit, quietly, bus, undo, redo, canUndo, canRedo } from './store.js?v=66fb115653';
import { toast, contextMenu } from './ui.js?v=66fb115653';
import { animate, popIn, EASE } from './motion.js?v=66fb115653';

export const PEN_COLOURS = [
  ['chalk', 'var(--text)'],
  ['red', '#ff4d5e'],
  ['amber', '#ffc357'],
  ['mint', '#4fd1a5'],
  ['sky', '#4db8ff'],
  ['violet', '#b98cff'],
];

export const STICKY_COLOURS = ['#ffd54a', '#ff9db1', '#8ce99a', '#74c0fc', '#d3b4ff', '#ffb27a'];

const TOOLS = [
  ['select', 'target', 'select · v'],
  ['pen', 'pen', 'pen · b'],
  ['marker', 'highlight', 'highlighter · m'],
  ['shape', 'box', 'shapes · r'],
  ['sticky', 'callout', 'sticky note · n'],
  ['text', 'textTool', 'text box · x'],
  ['picture', 'image', 'picture'],
  ['eraser', 'eraser', 'eraser · e'],
];

const SHAPES = [
  ['box', 'box', 'rectangle'],
  ['ellipse', 'ellipse', 'ellipse'],
  ['arrow', 'arrow', 'arrow'],
  ['line', 'line', 'line'],
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
export const inkBusy = () => tool !== 'select';

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
  strip.classList.toggle('show', drawing || tool === 'sticky');

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

function rail() {
  return h('div.wb-rail',
    ...TOOLS.map(([id, ico, tip]) => h('button.wb-tool', {
      class: tool === id ? 'on' : '', data: { tool: id }, tip,
      on: { click: () => pickTool(id) },
    }, icon(ico, { size: 17 }))),
    h('div.wb-rail-sep'),
    h('button.wb-tool.wb-small', { tip: 'undo · ctrl+z', on: { click: () => { const l = undo(); if (l) toast(`undid ${l}`, { ms: 1200 }); } } }, icon('undo', { size: 16 })),
    h('button.wb-tool.wb-small', { tip: 'redo · ctrl+shift+z', on: { click: () => { const l = redo(); if (l) toast(`redid ${l}`, { ms: 1200 }); } } }, icon('redo', { size: 16 })),
    h('button.wb-tool.wb-small', { tip: 'clear all ink on this page', on: { click: clearInk } }, icon('trash', { size: 16 })),
  );
}

async function pickTool(id) {
  if (id === 'picture') {
    const { pickImageFile } = await import('./images.js?v=66fb115653');
    const blocks = card(state.cardId)?.blocks || [];
    pickImageFile(blocks.at(-1)?.id);
    return;
  }
  setTool(id);
  if (id !== 'select') toast(hintFor(id), { ms: 1600 });
}

const hintFor = (id) => ({
  pen: 'draw anywhere on the plane',
  marker: 'highlight anywhere — it sits under your text',
  shape: 'drag to draw a shape',
  sticky: 'click to drop a sticky note',
  text: 'click anywhere to start a text box there',
  eraser: 'drag over ink to rub it out',
}[id] || '');

function optionsStrip() {
  return h('div.wb-options#wb-options');
}

function zoomPill() {
  return h('div.wb-zoom',
    h('button.wb-zoom-btn', { tip: 'zoom out · ctrl+-', on: { click: async () => (await import('./page.js?v=66fb115653')).setPageZoom((await import('./page.js?v=66fb115653')).pageZoom() * 0.9) } }, icon('minus', { size: 15 })),
    h('button.wb-zoom-val#wb-zoom-val', { tip: 'back to 100% · ctrl+0', text: '100%', on: { click: async () => (await import('./page.js?v=66fb115653')).resetPageView() } }),
    h('button.wb-zoom-btn', { tip: 'zoom in · ctrl++', on: { click: async () => (await import('./page.js?v=66fb115653')).setPageZoom((await import('./page.js?v=66fb115653')).pageZoom() * 1.1) } }, icon('plus', { size: 15 })),
    h('span.wb-zoom-sep'),
    h('button.wb-zoom-btn', { tip: 'centre the page · ctrl+0', on: { click: async () => (await import('./page.js?v=66fb115653')).resetPageView() } }, icon('fit', { size: 15 })),
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
    const { toPlane } = await import('./page.js?v=66fb115653');
    const p = toPlane(e.clientX, e.clientY);

    if (tool === 'sticky') { dropSticky(p); return; }
    if (tool === 'text') { dropText(e); return; }
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
    const { toPlane } = await import('./page.js?v=66fb115653');
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

/* ---------------------------------------------------------------- stickies + text */

async function dropSticky(p) {
  const { addStickyAt } = await import('./page.js?v=66fb115653');
  addStickyAt(p, stickyColour);
  setTool('select');
}

async function dropText(e) {
  const { addFreeBox } = await import('./page.js?v=66fb115653');
  addFreeBox({ x: e.clientX, y: e.clientY });
  setTool('select');
}

/* ---------------------------------------------------------------- keys */

document.addEventListener('keydown', (e) => {
  if (state.route.name !== 'page') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el?.isContentEditable || /INPUT|TEXTAREA/.test(el?.tagName || '')) return;
  const map = { v: 'select', b: 'pen', m: 'marker', r: 'shape', n: 'sticky', x: 'text', e: 'eraser' };
  const next = map[e.key.toLowerCase()];
  if (!next) return;
  e.preventDefault();
  setTool(next);
});

bus.on('replace', () => renderInk());
