/* preset structures — one click and the page is arranged a known way.

   the page has always *been able* to do these: any block can be dragged out of
   the column and left anywhere on the plane. the problem was that getting to a
   useful arrangement meant dragging fifteen things by hand every time, so
   nobody ever did it twice. these are the four arrangements that were worth
   the dragging, as buttons.

   they only ever move what is already on the page — nothing is inserted and
   nothing is deleted, so applying one is always safe and always undoable in a
   single ctrl+z. "back to a column" is the way out of any of them.
*/

import { h, clear } from './util.js?v=66fb115653';
import { icon } from './icons.js?v=66fb115653';
import { state, card, commit } from './store.js?v=66fb115653';
import { openModal, toast } from './ui.js?v=66fb115653';

const GAP = 26;
const COL_W = 380;

/** measured height of a block as it currently sits, or a sane guess */
function heightOf(blockId, fallback = 130) {
  const el = document.querySelector('.blk[data-id="' + CSS.escape(blockId) + '"]');
  const h2 = el?.getBoundingClientRect().height;
  return h2 && h2 > 8 ? Math.round(h2) : fallback;
}

/** where the paper ends, in plane coordinates — everything floats to its right */
function sheetEdge() {
  const sheet = document.querySelector('.page-sheet');
  const plane = document.querySelector('.page-plane');
  if (!sheet || !plane) return { right: 900, top: 0 };
  let z = 1;
  try { z = new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { /* keep 1 */ }
  const s = sheet.getBoundingClientRect();
  const p = plane.getBoundingClientRect();
  return {
    right: Math.round((s.right - p.left) / z),
    top: Math.round((s.top - p.top) / z),
  };
}

export const LAYOUTS = [
  {
    id: 'column',
    name: 'back to a column',
    blurb: 'everything returns to the flow, in order. the way out of any of the others.',
    apply(c) {
      for (const b of c.blocks || []) delete b.float;
    },
  },
  {
    id: 'beside',
    name: 'notes beside the picture',
    blurb: 'pictures stay in the column; the writing under each one moves out to sit level with it. what this app is actually for.',
    apply(c) {
      const edge = sheetEdge();
      const blocks = c.blocks || [];
      let lastShotY = edge.top;
      let seenShot = false;

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === 'image') {
          delete b.float;                       // pictures hold the column
          const el = document.querySelector('.blk[data-id="' + CSS.escape(b.id) + '"]');
          const plane = document.querySelector('.page-plane');
          if (el && plane) {
            let z = 1;
            try { z = new DOMMatrixReadOnly(getComputedStyle(plane).transform).a || 1; } catch { /* keep 1 */ }
            lastShotY = Math.round((el.getBoundingClientRect().top - plane.getBoundingClientRect().top) / z);
          }
          seenShot = true;
          continue;
        }
        if (!seenShot) { delete b.float; continue; }   // anything above the first picture stays put
        b.float = { x: edge.right + GAP, y: lastShotY, w: COL_W };
        lastShotY += heightOf(b.id, 90) + 10;
      }
    },
  },
  {
    id: 'gallery',
    name: 'pictures in a grid',
    blurb: 'every screenshot moves out into a two-wide grid beside the page, so you can see the whole session at once. the writing keeps the column.',
    apply(c) {
      const edge = sheetEdge();
      const shots = (c.blocks || []).filter((b) => b.type === 'image');
      const cellW = 330;
      shots.forEach((b, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        b.float = {
          x: edge.right + GAP + col * (cellW + 18),
          y: edge.top + row * 250,
          w: cellW,
        };
      });
      for (const b of c.blocks || []) if (b.type !== 'image') delete b.float;
    },
  },
  {
    id: 'spread',
    name: 'spread out to draw on',
    blurb: 'every block becomes its own card out on the plane, spaced apart and ready to join up with lines. press c to start drawing between them.',
    apply(c) {
      const edge = sheetEdge();
      const blocks = (c.blocks || []).filter((b) => (b.html || '').trim() || b.type === 'image');
      const perCol = Math.max(3, Math.ceil(blocks.length / 3));
      blocks.forEach((b, i) => {
        const col = Math.floor(i / perCol);
        const row = i % perCol;
        b.float = {
          x: edge.right + GAP + col * (COL_W + 60),
          y: edge.top + row * 170,
          w: COL_W,
        };
      });
    },
  },
];

export const layoutById = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];

/* ---------------------------------------------------------------- applying */

export async function applyLayout(id) {
  const c = card(state.cardId);
  if (!c) return;
  const layout = layoutById(id);
  const cardId = state.cardId;

  // measured before the commit, because the commit is what re-renders
  commit('arrange: ' + layout.name, (b) => {
    const target = b.cards[cardId];
    if (target) layout.apply(target);
  });

  const pg = await import('./page.js?v=66fb115653');
  pg.refreshPage();
  toast(layout.id === 'column'
    ? 'back in one column · ctrl+z to undo'
    : layout.name + ' · ctrl+z to undo', { kind: 'ok', ms: 3200 });
}

/* ---------------------------------------------------------------- the picker */

export async function openLayouts() {
  if (!state.board) return;
  const c = card(state.cardId);
  if (!c) return;

  const shots = (c.blocks || []).filter((b) => b.type === 'image').length;
  const floated = (c.blocks || []).filter((b) => b.float).length;

  const list = h('div.layout-list', ...LAYOUTS.map((l) => {
    const useless = (l.id === 'beside' || l.id === 'gallery') && !shots;
    const row = h('button.layout-card', { class: useless ? 'off' : '' },
      h('div.layout-art', layoutArt(l.id)),
      h('div.layout-meat',
        h('div.layout-name', { text: l.name }),
        h('div.layout-blurb', { text: useless ? 'needs a screenshot on the page first' : l.blurb })));
    if (!useless) row.onclick = () => { done(l.id); };
    return row;
  }));

  let done = () => {};
  const picked = await openModal({
    title: 'arrange this page',
    width: 560,
    body: h('div',
      h('p.modal-text.dim', { text: floated
        ? floated + ' block' + (floated === 1 ? ' is' : 's are') + ' already out on the plane. picking one of these rearranges everything.'
        : 'these only move what is already here — nothing is added or thrown away, and one ctrl+z puts it back.' }),
      list),
    actions: [{ label: 'cancel', value: null }],
    onMount: (_box, finish) => { done = finish; },
  });

  if (picked) applyLayout(picked);
}

/** a tiny diagram of each arrangement, so the names are not the only clue */
function layoutArt(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 60 42');
  svg.setAttribute('class', 'layout-svg');
  const box = (x, y, w, hh, cls) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', w); r.setAttribute('height', hh);
    r.setAttribute('rx', '2');
    r.setAttribute('class', cls || 'la-text');
    svg.append(r);
  };
  if (id === 'column') {
    box(14, 4, 32, 5); box(14, 12, 32, 9, 'la-shot'); box(14, 24, 32, 5); box(14, 32, 24, 5);
  } else if (id === 'beside') {
    box(4, 6, 26, 12, 'la-shot'); box(34, 7, 22, 4); box(34, 13, 22, 4);
    box(4, 24, 26, 12, 'la-shot'); box(34, 25, 22, 4); box(34, 31, 18, 4);
  } else if (id === 'gallery') {
    box(4, 6, 16, 5); box(4, 14, 16, 5); box(4, 22, 12, 5);
    box(26, 4, 14, 11, 'la-shot'); box(43, 4, 14, 11, 'la-shot');
    box(26, 19, 14, 11, 'la-shot'); box(43, 19, 14, 11, 'la-shot');
  } else {
    box(4, 5, 15, 8); box(4, 18, 15, 8); box(4, 31, 15, 8);
    box(24, 11, 15, 8); box(24, 25, 15, 8);
    box(44, 18, 13, 8);
    for (const [x1, y1, x2, y2] of [[19, 9, 24, 15], [19, 22, 24, 15], [19, 35, 24, 29], [39, 15, 44, 22], [39, 29, 44, 22]]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2);
      p.setAttribute('class', 'la-wire');
      svg.append(p);
    }
  }
  return svg;
}
