/* read mode — the same notes, laid out as a document you can actually read
   start to finish. this is the "google doc" half of the app. */

import { $, h, clear } from './util.js?v=2e4abb3f3d';
import { icon } from './icons.js?v=2e4abb3f3d';
import { state, card, cardTitle } from './store.js?v=2e4abb3f3d';
import { pushLayer, dropLayer, toast } from './ui.js?v=2e4abb3f3d';
import { animate, stagger, settle, fadeOut, EASE } from './motion.js?v=2e4abb3f3d';
import { renderCardTree, exportMarkdown, exportHtml } from './exporter.js?v=2e4abb3f3d';

let close = null;

export function openReader({ cardId = null, print = false } = {}) {
  if (!state.board) return;
  const id = cardId || state.cardId || state.board.rootId;
  const wrap = $('#reader-wrap');
  const root = clear($('#reader'));
  wrap.hidden = false;

  const tree = renderCardTree(id);

  root.append(
    h('div.reader-bar',
      h('div.reader-left',
        h('button.icon-btn', { tip: 'back to editing · esc', on: { click: () => shut() } }, icon('back')),
        h('span.reader-title', { text: cardTitle(card(id)) })),
      h('div.reader-right',
        h('button.btn.btn-sm', { on: { click: () => window.print() } }, icon('page', { size: 14 }), 'print / pdf'),
        h('button.btn.btn-sm', { on: { click: () => exportMarkdown(id) } }, icon('download', { size: 14 }), 'markdown'),
        h('button.btn.btn-sm', { on: { click: () => exportHtml(id) } }, icon('download', { size: 14 }), 'html'))),
    h('div.reader-scroll', h('main.doc', tree)),
  );

  animate(root, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
  stagger(Array.from(tree.querySelectorAll('.doc-body > *')).slice(0, 14), { step: 16, distance: 8 });

  close = shut;
  pushLayer(shut);
  if (print) setTimeout(() => window.print(), 400);

  function shut() {
    dropLayer(shut);
    close = null;
    fadeOut(root, { duration: 160 }).then(() => { wrap.hidden = true; root.style.opacity = ''; });
  }
}

export const closeReader = () => close?.();
