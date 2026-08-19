/* line drawing — persistent wires between things on the page.

   the anchors in anchors.js tie one line of text to one picture and only show
   themselves on hover. this is the general version, and it is always visible:
   arm the tool, click two things, and a labelled arrow joins them and stays.

   nothing about the geometry is stored. a wire is two ids and a colour; the
   shape is worked out again on every paint from wherever the two elements now
   are. that is why it can never drift out of step with what it joins — drag a
   block onto the plane, re-flow it, fold it, resize it, the wire follows.
*/

import { $, uid } from './util.js?v=66fb115653';
import { state, card, commit } from './store.js?v=66fb115653';
import { toast, contextMenu, promptDialog } from './ui.js?v=66fb115653';

const NS = 'http://www.w3.org/2000/svg';
const COLOURS = ['#e5484d', '#5ab0e0', '#45b08a', '#e0a13d', '#b57edc', '#a4abb3'];

let arming = null;       // set while a wire is being drawn
let ghost = null;        // the rubber band following the pointer

const wiresOf = (c = card(state.cardId)) => c?.wires || [];

/* ---------------------------------------------------------------- targets

   anything on the page with a stable id can be an end of a wire: a block, a
   floating text box, a margin note. they are found by the same data-id the
   rest of the app already puts on them. */

function targetAt(el) {
  const blk = el.closest?.('.blk[data-id]');
  if (blk) return { kind: 'block', id: blk.dataset.id, el: blk };
  const box = el.closest?.('.freebox[data-id]');
  if (box) return { kind: 'free', id: box.dataset.id, el: box };
  const note = el.closest?.('.sidenote[data-id]');
  if (note) return { kind: 'side', id: note.dataset.id, el: note };
  return null;
}

function elementFor(end) {
  const sel = end.kind === 'block' ? '.blk' : end.kind === 'free' ? '.freebox' : '.sidenote';
  return document.querySelector(sel + '[data-id="' + CSS.escape(end.id) + '"]');
}

/* ---------------------------------------------------------------- drawing */

/** plane-space box for an element, matching the maths anchors.js uses */
function geom(el, plane, z) {
  const base = plane.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    l: (r.left - base.left) / z,
    r: (r.right - base.left) / z,
    cy: (r.top + r.height / 2 - base.top) / z,
    cx: (r.left + r.width / 2 - base.left) / z,
  };
}

function planeZoom(plane) {
  try { return new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { return 1; }
}

function curve(x1, y1, x2, y2, leftward) {
  const bend = Math.max(30, Math.abs(x2 - x1) * 0.42);
  const c1 = x1 + (leftward ? -bend : bend);
  const c2 = x2 + (leftward ? bend : -bend);
  return 'M ' + x1 + ' ' + y1 + ' C ' + c1 + ' ' + y1 + ', ' + c2 + ' ' + y2 + ', ' + x2 + ' ' + y2;
}

export function paintWires() {
  const svg = $('#page-wires');
  const plane = document.querySelector('.page-plane');
  if (!svg || !plane) return;
  svg.innerHTML = '';

  const list = wiresOf();
  if (!list.length) return;
  const z = planeZoom(plane);

  // one arrowhead per colour in use, minted on demand
  const defs = document.createElementNS(NS, 'defs');
  const seen = new Set();
  for (const w of list) {
    const c = w.colour || COLOURS[0];
    if (seen.has(c)) continue;
    seen.add(c);
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'wire-' + c.replace('#', ''));
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const tip = document.createElementNS(NS, 'path');
    tip.setAttribute('d', 'M0 0 L10 5 L0 10 z');
    tip.setAttribute('fill', c);
    marker.append(tip);
    defs.append(marker);
  }
  svg.append(defs);

  for (const w of list) {
    const a = elementFor(w.from);
    const b = elementFor(w.to);
    if (!a || !b) continue;              // an end is gone or off-page — skip it

    const g1 = geom(a, plane, z);
    const g2 = geom(b, plane, z);
    const colour = w.colour || COLOURS[0];

    // leave from whichever side actually faces the other end
    const leftward = g2.cx < g1.cx;
    const x1 = leftward ? g1.l : g1.r;
    const x2 = leftward ? g2.r : g2.l;
    const d = curve(x1, g1.cy, x2, g2.cy, leftward);

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'wire');
    path.setAttribute('stroke', colour);
    path.setAttribute('marker-end', 'url(#wire-' + colour.replace('#', '') + ')');
    svg.append(path);

    // a fat transparent twin, because a 2px curve is not a click target
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'wire-hit');
    hit.addEventListener('click', (e) => { e.stopPropagation(); wireMenu(w, e.clientX, e.clientY); });
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

/* ---------------------------------------------------------------- drawing one */

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
  ghost?.remove();
  ghost = null;
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

  const from = arming.from;
  const to = { kind: hit.kind, id: hit.id };
  const cardId = state.cardId;
  commit('draw a line', (b) => {
    const c = b.cards[cardId];
    if (!c) return;
    const wires = (c.wires ||= []);
    wires.push({ id: uid('w'), from, to, colour: COLOURS[wires.length % COLOURS.length], label: '' });
  });
  cancelWire();
  paintWires();
}

function onMove(e) {
  if (!arming?.from) return;
  const svg = $('#page-wires');
  const plane = document.querySelector('.page-plane');
  const start = elementFor(arming.from);
  if (!svg || !plane || !start) return;

  const z = planeZoom(plane);
  const base = plane.getBoundingClientRect();
  const g = geom(start, plane, z);

  if (!ghost || !ghost.isConnected) {
    ghost = document.createElementNS(NS, 'path');
    ghost.setAttribute('class', 'wire wire-ghost');
    svg.append(ghost);
  }
  const x2 = (e.clientX - base.left) / z;
  const y2 = (e.clientY - base.top) / z;
  const leftward = x2 < g.cx;
  ghost.setAttribute('d', curve(leftward ? g.l : g.r, g.cy, x2, y2, leftward));
}

/* ---------------------------------------------------------------- editing one */

function wireMenu(w, x, y) {
  const cardId = state.cardId;
  const edit = (label, mutate) => commit(label, (b) => {
    const t = (b.cards[cardId]?.wires || []).find((z) => z.id === w.id);
    if (t) mutate(t);
  });

  contextMenu([
    { header: 'this line' },
    {
      label: w.label ? 'change what it says' : 'put a word on it',
      icon: 'pen',
      onPick: async () => {
        const label = await promptDialog({
          title: 'label this line', value: w.label || '',
          placeholder: 'because of this', okLabel: 'save',
        });
        if (label !== null) { edit('label a line', (t) => { t.label = label; }); paintWires(); }
      },
    },
    {
      label: 'colour', icon: 'palette', subWidth: 170,
      sub: COLOURS.map((c) => ({
        label: c, icon: 'pin', checked: (w.colour || COLOURS[0]) === c,
        onPick: () => { edit('line colour', (t) => { t.colour = c; }); paintWires(); },
      })),
    },
    {
      label: 'turn it around', icon: 'undo',
      onPick: () => {
        edit('flip a line', (t) => { const f = t.from; t.from = t.to; t.to = f; });
        paintWires();
      },
    },
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
  ], { x, y, width: 230 });
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
  ]);
  const keep = c.wires.filter((w) => live.has(w.from.id) && live.has(w.to.id));
  if (keep.length === c.wires.length) return;
  commit('tidy lines', (b) => { b.cards[cardId].wires = keep; });
}
