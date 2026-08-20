/* the lines between things.

   the anchors in anchors.js tie one line of text to one picture and only show
   themselves on hover. this is the general version, and it is always visible:
   drag a dot off the edge of a box, or arm the tool and click two things, and
   a labelled arrow joins them and stays.

   nothing about the geometry is stored. a wire is two ids, a side preference
   and a look; the shape is worked out again on every paint from wherever the
   two elements now are. that is why it can never drift out of step with what
   it joins — drag a box, resize it, re-flow a block, fold it: the line
   follows. it also means a line survives the thing at either end being
   dragged onto a different part of the plane.

     wire = { id, from:{kind,id,side?}, to:{kind,id,side?},
              colour, label, style:'curve'|'elbow'|'straight',
              ends:'to'|'from'|'both'|'none', dash, weight }
*/

import { $, uid } from './util.js?v=7cc5d8f531';
import { state, card, commit } from './store.js?v=7cc5d8f531';
import { toast, contextMenu, promptDialog } from './ui.js?v=7cc5d8f531';

const NS = 'http://www.w3.org/2000/svg';
export const WIRE_COLOURS = ['#a4abb3', '#e5484d', '#5ab0e0', '#45b08a', '#e0a13d', '#b57edc'];

let arming = null;       // set while a wire is being drawn by clicking
let ghost = null;        // the rubber band following the pointer

const wiresOf = (c = card(state.cardId)) => c?.wires || [];

/* ---------------------------------------------------------------- targets

   anything on the page with a stable id can be an end of a wire: a box on the
   whiteboard, a block in the column, a floating text box, a margin note. they
   are found by the same data-id the rest of the app already puts on them. */

const KIND_SEL = {
  shape: '.shape',
  block: '.blk',
  free: '.freebox',
  side: '.sidenote',
};

function targetAt(el) {
  for (const [kind, sel] of Object.entries(KIND_SEL)) {
    const hit = el.closest?.(`${sel}[data-id]`);
    if (hit) return { kind, id: hit.dataset.id, el: hit };
  }
  return null;
}

function elementFor(end) {
  const sel = KIND_SEL[end.kind] || '.blk';
  return document.querySelector(`${sel}[data-id="${CSS.escape(end.id)}"]`);
}

/* ---------------------------------------------------------------- geometry */

const planeOf = () => document.querySelector('.page-plane');

export function planeZoom(plane = planeOf()) {
  if (!plane) return 1;
  try { return new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { return 1; }
}

/** an element's box in plane coordinates */
export function boxOfEl(el, plane = planeOf(), z = planeZoom(plane)) {
  const base = plane.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const l = (r.left - base.left) / z;
  const t = (r.top - base.top) / z;
  const w = r.width / z;
  const hh = r.height / z;
  return { l, t, r: l + w, b: t + hh, cx: l + w / 2, cy: t + hh / 2, w, h: hh };
}

export function sidePoint(box, side) {
  if (side === 'left') return { x: box.l, y: box.cy };
  if (side === 'right') return { x: box.r, y: box.cy };
  if (side === 'top') return { x: box.cx, y: box.t };
  if (side === 'bottom') return { x: box.cx, y: box.b };
  return { x: box.cx, y: box.cy };
}

/** which two sides face each other. a line that leaves the top of one box and
 *  arrives at the bottom of the next reads as a diagram; one that always
 *  leaves the right-hand edge reads as spaghetti. */
export function bestSides(a, b) {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const gapX = Math.max(0, Math.max(a.l - b.r, b.l - a.r));
  const gapY = Math.max(0, Math.max(a.t - b.b, b.t - a.b));
  const horizontal = gapX > gapY || (gapX === 0 && gapY === 0 && Math.abs(dx) > Math.abs(dy));
  if (horizontal) return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

export function pathFor(p1, s1, p2, s2, style = 'curve') {
  if (style === 'straight') return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;

  if (style === 'elbow') {
    const pts = [];
    const out = 22;
    const n1 = NORMAL[s1] || [1, 0];
    const n2 = NORMAL[s2] || [-1, 0];
    const a = { x: p1.x + n1[0] * out, y: p1.y + n1[1] * out };
    const b = { x: p2.x + n2[0] * out, y: p2.y + n2[1] * out };
    pts.push(p1, a);
    if (n1[0] !== 0) pts.push({ x: a.x, y: b.y }, b);            // out sideways, then across
    else pts.push({ x: b.x, y: a.y }, b);
    pts.push(p2);
    return 'M ' + pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(' L ');
  }

  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const bend = Math.max(34, Math.min(170, dist * 0.42));
  const n1 = NORMAL[s1] || [1, 0];
  const n2 = NORMAL[s2] || [-1, 0];
  const c1 = { x: p1.x + n1[0] * bend, y: p1.y + n1[1] * bend };
  const c2 = { x: p2.x + n2[0] * bend, y: p2.y + n2[1] * bend };
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

/* ---------------------------------------------------------------- painting */

export function paintWires() {
  const svg = $('#page-wires');
  const plane = planeOf();
  if (!svg || !plane) return;
  const keep = svg.querySelector('.wire-ghost');
  svg.innerHTML = '';
  if (keep) svg.append(keep);

  const list = wiresOf();
  if (!list.length) return;
  const z = planeZoom(plane);

  // one arrowhead per colour in use, minted on demand
  const defs = document.createElementNS(NS, 'defs');
  const seen = new Set();
  for (const w of list) {
    const c = w.colour || WIRE_COLOURS[0];
    if (seen.has(c)) continue;
    seen.add(c);
    for (const dir of ['end', 'start']) {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', `wire-${dir}-${c.replace('#', '')}`);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', dir === 'end' ? '9' : '1');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', dir === 'end' ? 'auto' : 'auto-start-reverse');
      const tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', dir === 'end' ? 'M0 0 L10 5 L0 10 z' : 'M10 0 L0 5 L10 10 z');
      tip.setAttribute('fill', c);
      marker.append(tip);
      defs.append(marker);
    }
  }
  svg.append(defs);

  for (const w of list) {
    const a = elementFor(w.from);
    const b = elementFor(w.to);
    if (!a || !b) continue;              // an end is gone or off-page — skip it

    const ba = boxOfEl(a, plane, z);
    const bb = boxOfEl(b, plane, z);
    const auto = bestSides(ba, bb);
    const s1 = w.from.side || auto[0];
    const s2 = w.to.side || auto[1];
    const p1 = sidePoint(ba, s1);
    const p2 = sidePoint(bb, s2);
    const colour = w.colour || WIRE_COLOURS[0];
    const ends = w.ends || 'to';
    const d = pathFor(p1, s1, p2, s2, w.style || 'curve');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'wire');
    path.setAttribute('stroke', colour);
    path.setAttribute('stroke-width', String(w.weight || 2));
    if (w.dash) path.setAttribute('stroke-dasharray', '7 5');
    if (ends === 'to' || ends === 'both') path.setAttribute('marker-end', `url(#wire-end-${colour.replace('#', '')})`);
    if (ends === 'from' || ends === 'both') path.setAttribute('marker-start', `url(#wire-start-${colour.replace('#', '')})`);
    svg.append(path);

    // a fat transparent twin, because a 2px curve is not a click target
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'wire-hit');
    hit.addEventListener('click', (e) => { e.stopPropagation(); wireMenu(w, e.clientX, e.clientY); });
    hit.addEventListener('dblclick', (e) => { e.stopPropagation(); labelWire(w); });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wireMenu(w, e.clientX, e.clientY);
    });
    svg.append(hit);

    if (w.label) {
      const mid = path.getPointAtLength(path.getTotalLength() / 2);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', mid.x);
      text.setAttribute('y', mid.y - 6);
      text.setAttribute('class', 'wire-label');
      text.textContent = w.label;
      svg.append(text);
    }
  }
}

/* ---------------------------------------------------------------- the rubber band */

export function ghostWire(from, side, to) {
  const svg = $('#page-wires');
  if (!svg) return;
  if (!ghost || !ghost.isConnected) {
    ghost = document.createElementNS(NS, 'path');
    ghost.setAttribute('class', 'wire wire-ghost');
    svg.append(ghost);
  }
  const back = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[side] || 'left';
  ghost.setAttribute('d', pathFor(from, side, to, back, 'curve'));
}

export function clearGhost() {
  ghost?.remove();
  ghost = null;
}

/* ---------------------------------------------------------------- making one */

export function addWire(from, to, patch = {}) {
  if (!from?.id || !to?.id || from.id === to.id) return null;
  const cardId = state.cardId;
  const made = {
    id: uid('w'), from, to,
    colour: WIRE_COLOURS[0], label: '', style: 'curve', ends: 'to',
    ...patch,
  };
  commit('draw a line', (b) => {
    const c = b.cards[cardId];
    if (!c) return;
    (c.wires ||= []).push(made);
  });
  return made;
}

/* ---------------------------------------------------------------- click, click */

export function startWire() {
  if (arming) return cancelWire();
  arming = { from: null };
  document.body.classList.add('wiring');
  toast('click what it comes from, then what it points at · esc to stop', { ms: 5000 });
  document.addEventListener('click', onPick, true);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('keydown', onKey, true);
}

export function cancelWire() {
  arming = null;
  clearGhost();
  document.body.classList.remove('wiring');
  document.removeEventListener('click', onPick, true);
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('keydown', onKey, true);
  for (const el of document.querySelectorAll('.wire-from')) el.classList.remove('wire-from');
}

export const wiring = () => !!arming;

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelWire(); }
}

function onPick(e) {
  const hit = targetAt(e.target);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();

  if (!arming.from) {
    arming.from = { kind: hit.kind, id: hit.id };
    hit.el.classList.add('wire-from');
    return;
  }
  if (arming.from.id === hit.id) return;      // a wire from a thing to itself is nothing

  addWire(arming.from, { kind: hit.kind, id: hit.id });
  cancelWire();
  paintWires();
}

function onMove(e) {
  if (!arming?.from) return;
  const plane = planeOf();
  const start = elementFor(arming.from);
  if (!plane || !start) return;
  const z = planeZoom(plane);
  const base = plane.getBoundingClientRect();
  const box = boxOfEl(start, plane, z);
  const to = { x: (e.clientX - base.left) / z, y: (e.clientY - base.top) / z };
  const side = bestSides(box, { cx: to.x, cy: to.y, l: to.x, r: to.x, t: to.y, b: to.y })[0];
  ghostWire(sidePoint(box, side), side, to);
}

/* ---------------------------------------------------------------- editing one */

async function labelWire(w) {
  const cardId = state.cardId;
  const label = await promptDialog({
    title: 'label this line', value: w.label || '',
    placeholder: 'because of this', okLabel: 'save',
  });
  if (label === null) return;
  commit('label a line', (b) => {
    const t = (b.cards[cardId]?.wires || []).find((z) => z.id === w.id);
    if (t) t.label = label;
  });
  paintWires();
}

function wireMenu(w, x, y) {
  const cardId = state.cardId;
  const edit = (label, mutate) => {
    commit(label, (b) => {
      const t = (b.cards[cardId]?.wires || []).find((z) => z.id === w.id);
      if (t) mutate(t);
    });
    paintWires();
  };

  contextMenu([
    { header: 'this line' },
    { row: WIRE_COLOURS.map((c) => ({
      icon: 'line', color: c, tip: 'colour',
      onPick: () => edit('line colour', (t) => { t.colour = c; }),
    })) },
    {
      label: 'how it runs', icon: 'elbow', subWidth: 200,
      sub: [
        { label: 'curved', icon: 'curveLine', checked: (w.style || 'curve') === 'curve', onPick: () => edit('line shape', (t) => { t.style = 'curve'; }) },
        { label: 'right angles', icon: 'elbow', checked: w.style === 'elbow', onPick: () => edit('line shape', (t) => { t.style = 'elbow'; }) },
        { label: 'straight', icon: 'straight', checked: w.style === 'straight', onPick: () => edit('line shape', (t) => { t.style = 'straight'; }) },
        { sep: true },
        { label: w.dash ? 'solid' : 'dashed', icon: 'line', onPick: () => edit('line style', (t) => { t.dash = !t.dash; }) },
        { label: 'thicker', icon: 'pen', onPick: () => edit('line weight', (t) => { t.weight = (t.weight || 2) >= 5 ? 1.5 : (t.weight || 2) + 1; }) },
      ],
    },
    {
      label: 'arrows', icon: 'arrowR', subWidth: 190,
      sub: [
        { label: 'one end', icon: 'arrowR', checked: (w.ends || 'to') === 'to', onPick: () => edit('arrows', (t) => { t.ends = 'to'; }) },
        { label: 'both ends', icon: 'arrowBoth', checked: w.ends === 'both', onPick: () => edit('arrows', (t) => { t.ends = 'both'; }) },
        { label: 'no arrow', icon: 'line', checked: w.ends === 'none', onPick: () => edit('arrows', (t) => { t.ends = 'none'; }) },
      ],
    },
    { label: w.label ? 'change what it says' : 'put a word on it', icon: 'pen', hint: 'double-click', onPick: () => labelWire(w) },
    { label: 'turn it around', icon: 'undo', onPick: () => edit('flip a line', (t) => { const f = t.from; t.from = t.to; t.to = f; }) },
    { label: 'let it pick its own sides', icon: 'target', onPick: () => edit('free the ends', (t) => { delete t.from.side; delete t.to.side; }) },
    { sep: true },
    {
      label: 'delete this line', icon: 'trash', danger: true,
      onPick: () => {
        commit('delete a line', (b) => {
          const c = b.cards[cardId];
          if (c) c.wires = (c.wires || []).filter((z) => z.id !== w.id);
        });
        paintWires();
      },
    },
  ], { x, y, width: 235 });
}

/** drop wires whose ends no longer exist. cheap, and it keeps a deleted block
 *  from leaving a line pointing at nothing forever. */
export function pruneWires(cardId = state.cardId) {
  const c = card(cardId);
  if (!c?.wires?.length) return;
  const live = new Set([
    ...(c.blocks || []).map((b) => b.id),
    ...(c.free || []).map((f) => f.id),
    ...(c.side || []).map((s) => s.id),
    ...(c.shapes || []).map((s) => s.id),
  ]);
  const keep = c.wires.filter((w) => live.has(w.from.id) && live.has(w.to.id));
  if (keep.length === c.wires.length) return;
  commit('tidy lines', (b) => { b.cards[cardId].wires = keep; });
}
