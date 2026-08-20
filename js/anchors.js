/* linking a line of text to a picture (or to one pin on a picture), both ways.

   the link lives as an inline <span data-anchor="…"> inside the block html, so
   it survives typing, cut/paste and undo — character offsets would not.
*/

import { $, $$, h, uid } from './util.js?v=2e4abb3f3d';
import { state, card, commit, quietly } from './store.js?v=2e4abb3f3d';
import { toast } from './ui.js?v=2e4abb3f3d';
import { ping, animate } from './motion.js?v=2e4abb3f3d';

let wired = false;
let picking = null;

/* ---------------------------------------------------------------- data */

const anchorsOf = (c = card(state.cardId)) => c?.anchors || [];
const anchorById = (id) => anchorsOf().find((a) => a.id === id) || null;

function saveBlockHtml(blockId) {
  const el = document.querySelector(`.blk[data-id="${CSS.escape(blockId)}"] .blk-body`);
  if (!el) return;
  const cardId = state.cardId, html = el.innerHTML;
  quietly((b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.html = html;
  });
}

/* ---------------------------------------------------------------- from text → picture */

export async function startAnchorPick() {
  const ed = await import('./editor.js?v=2e4abb3f3d');
  const body = ed.currentBody();
  const blockId = ed.currentBlockId();
  if (!body || !blockId) { toast('select some text first', { kind: 'warn' }); return; }

  const sel = getSelection();
  const id = uid('a');
  if (sel && !sel.isCollapsed) {
    ed.wrapSelection('span', { 'data-anchor': id });
  } else {
    body.insertAdjacentHTML('beforeend', `<span data-anchor="${id}">↵</span>`);
  }
  saveBlockHtml(blockId);

  const images = $$('.img-block');
  if (!images.length) {
    toast('no pictures on this page yet — paste one first', { kind: 'warn' });
    unwrapMark(id, blockId);
    return;
  }

  beginPicking({
    mode: 'image',
    hint: 'click the picture (or a pin on it) this line is about',
    onPick: (target) => {
      const cardId = state.cardId;
      commit('link line to picture', (b) => {
        (b.cards[cardId].anchors ||= []).push({ id, blockId, target: target.blockId, pin: target.pinId || null });
      });
      paintAnchors();
      toast('linked — hover the line to see it light up', { kind: 'ok' });
    },
    onCancel: () => unwrapMark(id, blockId),
  });
}

/* ---------------------------------------------------------------- from picture → text */

export function linkImageToLine(imageBlockId) {
  pickLine((blockId, markId) => {
    const cardId = state.cardId;
    commit('link picture to line', (b) => {
      (b.cards[cardId].anchors ||= []).push({ id: markId, blockId, target: imageBlockId, pin: null });
    });
    paintAnchors();
    toast('linked', { kind: 'ok' });
  });
}

export function linkPinToLine(imageBlockId, pinId) {
  pickLine((blockId, markId) => {
    const cardId = state.cardId;
    commit('link pin to line', (b) => {
      (b.cards[cardId].anchors ||= []).push({ id: markId, blockId, target: imageBlockId, pin: pinId });
    });
    paintAnchors();
    toast('pin linked to that line', { kind: 'ok' });
  });
}

function pickLine(done) {
  document.body.classList.add('picking-line');
  toast('now click the line of text it belongs to', { ms: 3200 });

  const onClick = (e) => {
    const blk = e.target.closest?.('.blk');
    const body = blk?.querySelector('.blk-body');
    if (!blk || !body) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    const markId = uid('a');
    const mark = document.createElement('span');
    mark.setAttribute('data-anchor', markId);
    while (body.firstChild) mark.append(body.firstChild);
    body.append(mark);
    saveBlockHtml(blk.dataset.id);
    done(blk.dataset.id, markId);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); stop(); } };
  const stop = () => {
    document.body.classList.remove('picking-line');
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}

/* ---------------------------------------------------------------- picking a target */

function beginPicking({ mode, hint, onPick, onCancel }) {
  document.body.classList.add('picking-target');
  toast(hint, { ms: 3200 });
  picking = { mode, onPick, onCancel };

  const onClick = (e) => {
    const pin = e.target.closest?.('.img-pin');
    const fig = e.target.closest?.('.img-block');
    if (!fig) return;
    e.preventDefault();
    e.stopPropagation();
    const blockId = fig.dataset.id;
    stop(true);
    onPick({ blockId, pinId: pin?.dataset.id || null });
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); stop(false); onCancel?.(); } };
  const stop = (ok) => {
    document.body.classList.remove('picking-target');
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    picking = null;
    if (!ok) onCancel?.();
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
}

function unwrapMark(id, blockId) {
  const mark = document.querySelector(`[data-anchor="${CSS.escape(id)}"]`);
  if (mark) {
    while (mark.firstChild) mark.parentNode.insertBefore(mark.firstChild, mark);
    mark.remove();
    saveBlockHtml(blockId);
  }
}

export function removeAnchor(id) {
  const anchor = anchorById(id);
  if (!anchor) return;
  unwrapMark(id, anchor.blockId);
  const cardId = state.cardId;
  commit('unlink', (b) => {
    b.cards[cardId].anchors = anchorsOf(b.cards[cardId]).filter((a) => a.id !== id);
  });
  paintAnchors();
}

/* ---------------------------------------------------------------- painting */

export function paintAnchors() {
  const sheet = document.querySelector('.page-sheet');
  if (!sheet) return;
  const live = new Set();

  for (const mark of sheet.querySelectorAll('[data-anchor]')) {
    const id = mark.dataset.anchor;
    const anchor = anchorById(id);
    if (!anchor) { mark.classList.remove('anchor-mark'); continue; }
    mark.classList.add('anchor-mark');
    mark.dataset.pin = anchor.pin ? String(pinNumber(anchor.target, anchor.pin)) : '';
    live.add(id);
  }

  // pictures that something points at get a subtle badge
  for (const fig of sheet.querySelectorAll('.img-block')) {
    const count = anchorsOf().filter((a) => a.target === fig.dataset.id && live.has(a.id)).length;
    fig.classList.toggle('has-links', count > 0);
    fig.dataset.links = count || '';
  }

  if (!wired) wire(sheet);
  clearHints();
}

function pinNumber(blockId, pinId) {
  const block = card(state.cardId)?.blocks.find((b) => b.id === blockId);
  const i = (block?.pins || []).findIndex((p) => p.id === pinId);
  return i >= 0 ? i + 1 : '';
}

function wire() {
  wired = true;
  document.addEventListener('mouseover', (e) => {
    const mark = e.target.closest?.('.anchor-mark');
    if (mark) return lightUp(mark.dataset.anchor);
    const fig = e.target.closest?.('.img-block');
    if (fig) return lightUpImage(fig.dataset.id, e.target.closest('.img-pin')?.dataset.id || null);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('.anchor-mark, .img-block')) clearHints();
  });
  document.addEventListener('click', (e) => {
    const mark = e.target.closest?.('.anchor-mark');
    if (!mark || picking) return;
    const anchor = anchorById(mark.dataset.anchor);
    if (!anchor) return;
    const fig = document.querySelector(`.img-block[data-id="${CSS.escape(anchor.target)}"]`);
    if (!fig) return;
    fig.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ping(fig);
  });
  document.addEventListener('contextmenu', async (e) => {
    const mark = e.target.closest?.('.anchor-mark');
    if (!mark) return;
    e.preventDefault();
    const { contextMenu } = await import('./ui.js?v=2e4abb3f3d');
    contextMenu([
      { label: 'go to the picture', icon: 'image', onPick: () => mark.click() },
      { label: 'remove this link', icon: 'unlink', danger: true, onPick: () => removeAnchor(mark.dataset.anchor) },
    ], { x: e.clientX, y: e.clientY });
  });
}

/* ---------------------------------------------------------------- hints + connectors */

export function clearHints() {
  for (const el of document.querySelectorAll('.anchor-lit')) el.classList.remove('anchor-lit');
  for (const el of document.querySelectorAll('.pin-lit')) el.classList.remove('pin-lit');
  document.querySelector('.page-sheet')?.classList.remove('anchors-dim');
  const svg = $('#page-links');
  if (svg) svg.innerHTML = '';
}

function lightUp(anchorId) {
  clearHints();
  const anchor = anchorById(anchorId);
  if (!anchor) return;
  const mark = document.querySelector(`[data-anchor="${CSS.escape(anchorId)}"]`);
  const fig = document.querySelector(`.img-block[data-id="${CSS.escape(anchor.target)}"]`);
  if (!mark || !fig) return;
  mark.classList.add('anchor-lit');
  fig.classList.add('anchor-lit');
  const pin = anchor.pin && fig.querySelector(`.img-pin[data-id="${CSS.escape(anchor.pin)}"]`);
  if (pin) pin.classList.add('pin-lit');
  connect(mark, pin || fig);
}

function lightUpImage(blockId, pinId) {
  clearHints();
  const links = anchorsOf().filter((a) => a.target === blockId && (!pinId || a.pin === pinId));
  if (!links.length) return;
  const fig = document.querySelector(`.img-block[data-id="${CSS.escape(blockId)}"]`);
  fig?.classList.add('anchor-lit');
  document.querySelector('.page-sheet')?.classList.add('anchors-dim');
  for (const link of links) {
    const mark = document.querySelector(`[data-anchor="${CSS.escape(link.id)}"]`);
    if (!mark) continue;
    mark.classList.add('anchor-lit');
    connect(mark, pinId ? fig.querySelector(`.img-pin[data-id="${CSS.escape(pinId)}"]`) || fig : fig);
  }
}

function connect(from, to) {
  const plane = document.querySelector('.page-plane');
  const svg = $('#page-links');
  if (!plane || !svg || !from || !to) return;
  const base = plane.getBoundingClientRect();
  let z = 1;
  try { z = new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { /* keep 1 */ }

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const leftward = b.left + b.width / 2 < a.left;

  const x1 = ((leftward ? a.left : a.right) - base.left) / z;
  const y1 = (a.top + a.height / 2 - base.top) / z;
  const x2 = ((leftward ? b.right : b.left) - base.left) / z;
  const y2 = (b.top + b.height / 2 - base.top) / z;
  const bend = Math.max(28, Math.abs(x2 - x1) * .45);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${x1 + (leftward ? -bend : bend)} ${y1}, ${x2 + (leftward ? bend : -bend)} ${y2}, ${x2} ${y2}`);
  path.setAttribute('class', 'link-path');
  svg.append(path);

  const len = path.getTotalLength?.() || 200;
  path.style.strokeDasharray = len;
  path.style.strokeDashoffset = len;
  animate(path, [{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 320, fill: 'forwards' });

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', x2); dot.setAttribute('cy', y2); dot.setAttribute('r', 4);
  dot.setAttribute('class', 'link-dot');
  svg.append(dot);
}
