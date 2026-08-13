/* the annotation studio — vector marks on top of a screenshot, never baked
   into the pixels, so every arrow stays editable and stays sharp. */

import { h, $, clear, uid, clamp } from './util.js?v=58e76add28';
import { icon } from './icons.js?v=58e76add28';
import { mediaUrl } from './api.js?v=58e76add28';
import { state, card, commit } from './store.js?v=58e76add28';
import { pushLayer, dropLayer, toast } from './ui.js?v=58e76add28';
import { animate, EASE } from './motion.js?v=58e76add28';
import { paintStrokes, refreshImage, addPin } from './images.js?v=58e76add28';

const TOOLS = [
  ['arrow', 'arrow', 'arrow · a'],
  ['box', 'box', 'box · b'],
  ['ellipse', 'ellipse', 'circle · c'],
  ['line', 'line', 'line · l'],
  ['pen', 'pen', 'freehand · p'],
  ['text', 'textTool', 'text · t'],
  ['blur', 'blur', 'blur out a name · x'],
  ['pin', 'pin', 'numbered pin · n'],
];

const COLORS = ['rose', 'amber', 'mint', 'lilac', 'white'];

let session = null;

export function openAnnotator(blockId) {
  const cardId = state.cardId;
  const block = card(cardId)?.blocks.find((b) => b.id === blockId);
  if (!block || !block.src) { toast('give the picture a second to save first', { kind: 'warn' }); return; }

  const wrap = $('#annotate-wrap');
  const root = clear($('#annotate'));
  wrap.hidden = false;

  session = {
    blockId, cardId, block,
    tool: 'arrow', color: 'rose', size: 4,
    strokes: JSON.parse(JSON.stringify(block.strokes || [])),
    temp: null,
  };

  const stage = h('div.ann-stage');
  const holder = h('div.ann-holder');
  const img = h('img.ann-img', { src: mediaUrl(state.board.id, block.src), draggable: 'false' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ann-svg');

  img.addEventListener('load', () => {
    const nat = { w: img.naturalWidth, h: img.naturalHeight };
    session.nat = nat;
    svg.setAttribute('viewBox', `0 0 ${nat.w} ${nat.h}`);
    redraw();
  });

  holder.append(img, svg);
  stage.append(holder);
  root.append(bar(), stage);

  bindDraw(holder, svg);
  animate(root, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 220 });

  session.close = () => closeAnnotator();
  session.layer = pushLayer(session.close);
  document.addEventListener('keydown', onKey, true);
}

export function closeAnnotator() {
  if (!session) return;
  document.removeEventListener('keydown', onKey, true);
  session.layer?.();
  const { blockId } = session;
  session = null;
  $('#annotate-wrap').hidden = true;
  refreshImage(blockId);
}

function onKey(e) {
  if (!session) return;
  if (e.key === 'Escape') { e.preventDefault(); closeAnnotator(); return; }
  if (e.target.matches('input, textarea')) return;
  const map = { a: 'arrow', b: 'box', c: 'ellipse', l: 'line', p: 'pen', t: 'text', x: 'blur', n: 'pin' };
  if (map[e.key.toLowerCase()]) { e.preventDefault(); setTool(map[e.key.toLowerCase()]); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoStroke(); }
}

/* ---------------------------------------------------------------- chrome */

function bar() {
  const tools = h('div.ann-tools', ...TOOLS.map(([id, ico, tip]) => h('button.ann-tool', {
    class: session.tool === id ? 'on' : '', tip, data: { tool: id },
    on: { click: () => setTool(id) },
  }, icon(ico, { size: 17 }))));

  const colors = h('div.ann-colors', ...COLORS.map((c) => h('button.ann-color', {
    class: session.color === c ? 'on' : '', data: { color: c }, tip: c,
    style: { background: `var(--ink-${c})` },
    on: { click: () => setColor(c) },
  })));

  const size = h('input', {
    type: 'range', min: 2, max: 12, value: session.size, tip: 'stroke width',
    on: { input: (e) => { session.size = Number(e.target.value); } },
  });

  return h('div.ann-bar',
    h('div.ann-left', tools, h('span.tb-sep'), colors, h('div.ann-size', icon('pen', { size: 13 }), size)),
    h('div.ann-right',
      h('button.btn.btn-sm', { on: { click: undoStroke } }, icon('undo', { size: 14 }), 'undo'),
      h('button.btn.btn-sm', { on: { click: clearStrokes } }, icon('eraser', { size: 14 }), 'clear'),
      h('button.btn.btn-sm.btn-primary', { on: { click: closeAnnotator } }, icon('check', { size: 14 }), 'done')));
}

function setTool(tool) {
  session.tool = tool;
  for (const b of document.querySelectorAll('.ann-tool')) b.classList.toggle('on', b.dataset.tool === tool);
  const stage = $('.ann-holder');
  if (stage) stage.dataset.tool = tool;
}

function setColor(color) {
  session.color = color;
  for (const b of document.querySelectorAll('.ann-color')) b.classList.toggle('on', b.dataset.color === color);
}

/* ---------------------------------------------------------------- drawing */

function point(e, holder) {
  const r = holder.getBoundingClientRect();
  const nat = session.nat || { w: r.width, h: r.height };
  return [
    clamp(((e.clientX - r.left) / r.width) * nat.w, 0, nat.w),
    clamp(((e.clientY - r.top) / r.height) * nat.h, 0, nat.h),
  ];
}

function bindDraw(holder, svg) {
  holder.dataset.tool = session.tool;

  holder.addEventListener('pointerdown', (e) => {
    if (!session || e.button !== 0) return;
    const [x, y] = point(e, holder);

    if (session.tool === 'pin') {
      const r = holder.getBoundingClientRect();
      addPin(session.blockId, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      toast('pin dropped — close the studio to write on it', { ms: 2000 });
      return;
    }
    if (session.tool === 'text') return textAt(x, y, holder);

    try { holder.setPointerCapture(e.pointerId); } catch { /* capture is a nicety */ }
    session.temp = session.tool === 'pen'
      ? { id: uid('s'), tool: 'pen', color: session.color, size: session.size, pts: [[Math.round(x), Math.round(y)]] }
      : { id: uid('s'), tool: session.tool, color: session.color, size: session.size, x, y, x2: x, y2: y };
    redraw();
  });

  holder.addEventListener('pointermove', (e) => {
    if (!session?.temp) return;
    const [x, y] = point(e, holder);
    if (session.temp.tool === 'pen') {
      const last = session.temp.pts.at(-1);
      if (Math.hypot(x - last[0], y - last[1]) > 2) session.temp.pts.push([Math.round(x), Math.round(y)]);
    } else {
      session.temp.x2 = x;
      session.temp.y2 = y;
      if (e.shiftKey && (session.temp.tool === 'box' || session.temp.tool === 'blur')) {
        const side = Math.max(Math.abs(x - session.temp.x), Math.abs(y - session.temp.y));
        session.temp.x2 = session.temp.x + Math.sign(x - session.temp.x) * side;
        session.temp.y2 = session.temp.y + Math.sign(y - session.temp.y) * side;
      }
    }
    redraw();
  });

  const finish = () => {
    if (!session?.temp) return;
    const s = session.temp;
    session.temp = null;
    const big = s.tool === 'pen' ? s.pts.length > 2 : Math.hypot(s.x2 - s.x, s.y2 - s.y) > 6;
    if (big) { session.strokes.push(s); persist(); }
    redraw();
  };
  holder.addEventListener('pointerup', finish);
  holder.addEventListener('pointercancel', finish);
}

function textAt(x, y, holder) {
  const r = holder.getBoundingClientRect();
  const nat = session.nat;
  const input = h('input.ann-text-input', {
    placeholder: 'type, then enter',
    style: { left: `${(x / nat.w) * r.width}px`, top: `${(y / nat.h) * r.height - 14}px`, color: `var(--ink-${session.color})` },
  });
  holder.append(input);
  setTimeout(() => input.focus(), 20);
  const done = (commitIt) => {
    const text = input.value.trim();
    input.remove();
    if (commitIt && text) {
      session.strokes.push({ id: uid('s'), tool: 'text', color: session.color, size: session.size, x, y, text });
      persist();
      redraw();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
  });
  input.addEventListener('blur', () => done(true));
}

function redraw() {
  const svg = $('.ann-svg');
  if (!svg || !session) return;
  const strokes = session.temp ? [...session.strokes, session.temp] : session.strokes;
  paintStrokes(svg, { ...session.block, id: `ann-${session.blockId}`, nat: session.nat, strokes });
}

function persist() {
  const { cardId, blockId } = session;
  const strokes = JSON.parse(JSON.stringify(session.strokes));
  commit('draw', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.strokes = strokes;
  });
}

function undoStroke() {
  if (!session?.strokes.length) return;
  session.strokes.pop();
  persist();
  redraw();
}

function clearStrokes() {
  if (!session) return;
  session.strokes = [];
  persist();
  redraw();
}
