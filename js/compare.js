/* two screenshots side by side, with the zoom and the pan locked together.

   what you did against what you should have done, or the same fight from two
   angles. the whole point is that both panes move as one — comparing two
   pictures you have to line up by hand is not comparing, it is squinting.

   annotations come along: each pane draws the same stroke layer the page does,
   so arrows and boxes stay where they were put. */

import { h, clear, clamp, stripHtml } from './util.js?v=5aab9d9b3f';
import { icon } from './icons.js?v=5aab9d9b3f';
import { mediaUrl } from './api.js?v=5aab9d9b3f';
import { state, card, cardTitle } from './store.js?v=5aab9d9b3f';
import { strokeLayer } from './images.js?v=5aab9d9b3f';
import { openModal, toast } from './ui.js?v=5aab9d9b3f';

const MIN_Z = 0.2;
const MAX_Z = 8;

/** every picture in the session, so the picker is not limited to this page */
function everyShot() {
  const out = [];
  for (const c of Object.values(state.board?.cards || {})) {
    for (const b of c.blocks || []) {
      if (b.type !== 'image' || !b.src) continue;
      out.push({
        block: b,
        cardId: c.id,
        page: cardTitle(c),
        caption: stripHtml(b.caption || '').trim(),
      });
    }
  }
  return out;
}

/** open the comparer on `blockId`, asking which picture to put beside it */
export async function compareWith(blockId) {
  const shots = everyShot();
  const left = shots.find((s) => s.block.id === blockId);
  if (!left) return;

  const others = shots.filter((s) => s.block.id !== blockId);
  if (!others.length) {
    toast('there is only one picture in this session so far', { kind: 'warn' });
    return;
  }

  const picked = await pickOne(others);
  if (!picked) return;
  openCompare(left, picked);
}

function pickOne(shots) {
  return new Promise((resolve) => {
    let answered = false;
    const grid = h('div.cmp-pick', ...shots.map((s) => {
      const tile = h('button.cmp-pick-tile',
        h('img', { src: mediaUrl(state.board.id, s.block.src), loading: 'lazy', alt: '' }),
        h('span.cmp-pick-label', { text: s.caption || s.page }));
      tile.onclick = () => { answered = true; done(null); resolve(s); };
      return tile;
    }));

    let done = () => {};
    openModal({
      title: 'compare with which one?',
      width: 640,
      body: h('div', h('p.modal-text.dim', { text: 'zoom and pan stay locked together once both are open.' }), grid),
      actions: [{ label: 'cancel', value: null }],
      onMount: (_box, finish) => { done = finish; },
    }).then(() => { if (!answered) resolve(null); });
  });
}

/* ---------------------------------------------------------------- the view */

function openCompare(a, b) {
  // one view per pane. locked keeps them equal; unlocked lets each one move on
  // its own, which is what you want when the two shots are framed differently.
  const views = [{ z: 1, x: 0, y: 0 }, { z: 1, x: 0, y: 0 }];
  let locked = true;
  const panes = [pane(a), pane(b)];

  const apply = () => {
    panes.forEach((p, i) => {
      const v = views[i];
      p.inner.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    });
    zoomLabel.textContent = `${Math.round(views[0].z * 100)}%`;
  };

  /** a change to one pane goes to both while they are locked */
  const touch = (i, mutate) => {
    mutate(views[i]);
    if (locked) {
      const other = i === 0 ? 1 : 0;
      views[other] = { ...views[i] };
    }
    apply();
  };

  const reset = () => {
    views[0] = { z: 1, x: 0, y: 0 };
    views[1] = { z: 1, x: 0, y: 0 };
    apply();
  };

  const zoomLabel = h('span.cmp-zoom', { text: '100%' });
  const lockBtn = h('button.btn.btn-sm.on', { tip: 'when this is off, each side scrolls on its own' },
    icon('link', { size: 13 }), 'locked together');
  lockBtn.onclick = () => {
    locked = !locked;
    lockBtn.classList.toggle('on', locked);
    clear(lockBtn);
    lockBtn.append(icon(locked ? 'link' : 'close', { size: 13 }), locked ? 'locked together' : 'moving separately');
    // re-locking snaps the second pane back onto the first, rather than leaving
    // them out of step with a button that claims they are together
    if (locked) { views[1] = { ...views[0] }; apply(); }
  };

  panes.forEach((p, i) => {
    // wheel zooms about the pointer, so you can drive into a corner of the frame
    p.stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const box = p.stage.getBoundingClientRect();
      const px = e.clientX - box.left - box.width / 2;
      const py = e.clientY - box.top - box.height / 2;
      touch(i, (v) => {
        const next = clamp(v.z * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_Z, MAX_Z);
        const ratio = next / v.z;
        v.x = px - (px - v.x) * ratio;
        v.y = py - (py - v.y) * ratio;
        v.z = next;
      });
    }, { passive: false });

    p.stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // capture is a nicety — losing it must not take the whole drag with it
      try { p.stage.setPointerCapture(e.pointerId); } catch { /* carry on */ }
      p.stage.classList.add('dragging');
      const from = { x: e.clientX, y: e.clientY, vx: views[i].x, vy: views[i].y };
      const move = (ev) => touch(i, (v) => {
        v.x = from.vx + (ev.clientX - from.x);
        v.y = from.vy + (ev.clientY - from.y);
      });
      const up = () => {
        p.stage.classList.remove('dragging');
        p.stage.removeEventListener('pointermove', move);
        p.stage.removeEventListener('pointerup', up);
      };
      p.stage.addEventListener('pointermove', move);
      p.stage.addEventListener('pointerup', up);
    });
  });

  openModal({
    title: 'side by side',
    width: 'min(1180px, 94vw)',
    body: h('div.cmp',
      h('div.cmp-bar',
        lockBtn,
        h('div.cmp-zoomer',
          h('button.icon-btn', { tip: 'zoom out', on: { click: () => touch(0, (v) => { v.z = clamp(v.z / 1.25, MIN_Z, MAX_Z); }) } }, icon('zoomOut', { size: 15 })),
          zoomLabel,
          h('button.icon-btn', { tip: 'zoom in', on: { click: () => touch(0, (v) => { v.z = clamp(v.z * 1.25, MIN_Z, MAX_Z); }) } }, icon('zoomIn', { size: 15 }))),
        h('button.btn.btn-sm', { on: { click: reset } }, icon('fit', { size: 13 }), 'reset'),
        h('span.cmp-hint', { text: 'drag to move · wheel to zoom' })),
      h('div.cmp-panes', panes[0].el, panes[1].el)),
    actions: [{ label: 'close', value: null }],
    onMount: () => setTimeout(apply, 20),
  });
}

function pane(shot) {
  const img = h('img.cmp-img', { src: mediaUrl(state.board.id, shot.block.src), alt: '' });
  const inner = h('div.cmp-inner', img);

  // the same stroke layer the page draws, so arrows and boxes travel with it
  if ((shot.block.strokes || []).length) {
    const svg = strokeLayer(shot.block);
    svg.classList.add('cmp-strokes');
    inner.append(svg);
  }

  const stage = h('div.cmp-stage', inner);
  const el = h('div.cmp-pane',
    h('div.cmp-head',
      h('b', { text: shot.caption || shot.page }),
      shot.caption ? h('span', { text: shot.page }) : null),
    stage);
  return { el, stage, inner };
}
