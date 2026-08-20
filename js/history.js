/* earlier versions of a session.

   the desktop build has been writing snapshots to `data/boards/<id>/.history/`
   since the very first version and nothing could read them back — months of
   safety net that existed only as files on disk. this is the window onto them,
   and the worker and the browser vault now keep the same thing so all three
   builds can answer the question.

   restoring goes through `commit()`, so it lands on the undo stack like any
   other edit: change your mind and ctrl+z puts it back. */

import { h, clear, fmtRel, fmtDate, fmtBytes, stripHtml } from './util.js?v=d258d51ea6';
import { icon } from './icons.js?v=d258d51ea6';
import { api } from './api.js?v=d258d51ea6';
import { state, commit, saveNow } from './store.js?v=d258d51ea6';
import { openModal, toast, confirmDialog } from './ui.js?v=d258d51ea6';

/** counts for the document as it stands, to compare a version against */
function nowCounts() {
  const cards = Object.values(state.board?.cards || {});
  let notes = 0, shots = 0;
  for (const c of cards) {
    for (const b of c.blocks || []) {
      if (b.type === 'image') shots++;
      else if ((b.html || '').trim()) notes++;
    }
  }
  return { cards: cards.length, notes, shots };
}

const delta = (was, is) => {
  const d = was - is;
  if (!d) return null;
  return d > 0 ? `+${d}` : String(d);
};

export async function openHistory() {
  if (!state.board) return;
  const boardId = state.board.id;

  if (!api.history) {
    toast('this build does not keep earlier versions', { kind: 'warn' });
    return;
  }

  const list = h('div.ver-list', h('div.skel', { style: { height: '54px' } }),
    h('div.skel', { style: { height: '54px', marginTop: '6px' } }));
  const foot = h('p.modal-text.dim');

  let close = () => {};
  const modal = openModal({
    title: 'earlier versions',
    width: 560,
    body: h('div', list, foot),
    actions: [{ label: 'close', value: null }],
    onMount: (_box, done) => { close = done; },
  });

  let versions = [];
  try {
    versions = (await api.history(boardId)).versions || [];
  } catch (err) {
    clear(list);
    list.append(h('div.empty.empty-inline',
      h('div.art', icon('history', { size: 30 })),
      h('h3', { text: 'could not read the history' }),
      h('p', { text: err.message })));
    return modal;
  }

  clear(list);
  if (!versions.length) {
    list.append(h('div.empty.empty-inline',
      h('div.art', icon('history', { size: 30 })),
      h('h3', { text: 'no earlier versions yet' }),
      h('p', { text: 'a snapshot is taken every few minutes while you are editing, and the '
        + 'last dozen are kept. come back after a session of writing.' })));
    return modal;
  }

  const now = nowCounts();
  for (const v of versions) list.append(row(v, now, boardId, close));
  foot.textContent = `${versions.length} kept · the newest is taken before your most recent save, `
    + 'so it is what the session looked like just before that';
  return modal;
}

function row(v, now, boardId, close) {
  const bits = [
    `${v.cards} page${v.cards === 1 ? '' : 's'}`,
    `${v.notes} notes`,
    v.shots ? `${v.shots} shots` : null,
    v.bytes ? fmtBytes(v.bytes) : null,
  ].filter(Boolean).join(' · ');

  // what taking this one would cost or bring back, in plain numbers
  const moves = [
    ['pages', delta(v.cards, now.cards)],
    ['notes', delta(v.notes, now.notes)],
    ['shots', delta(v.shots, now.shots)],
  ].filter(([, d]) => d);

  return h('div.ver-row',
    h('div.ver-when',
      h('b', { text: fmtRel(v.stamp) }),
      h('span', { text: fmtDate(v.stamp) + ' ' + new Date(v.stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })),

    h('div.ver-meat',
      h('div.ver-title', { text: v.title || 'session' }),
      h('div.ver-sub', { text: bits })),

    moves.length
      ? h('div.ver-moves', ...moves.map(([label, d]) => h('span.ver-move', {
          class: d.startsWith('+') ? 'up' : 'down',
        }, h('b', { text: d }), h('span', { text: label }))))
      : h('div.ver-moves', h('span.ver-same', { text: 'same as now' })),

    h('div.ver-acts',
      h('button.btn.btn-sm', { tip: 'open it read-only, without touching what you have',
        on: { click: () => peek(boardId, v) } }, icon('eye', { size: 13 }), 'look'),
      h('button.btn.btn-sm', { tip: 'replace the session with this version',
        on: { click: () => restore(boardId, v, close) } }, icon('undo', { size: 13 }), 'restore')),
  );
}

/* ---------------------------------------------------------------- looking */

async function peek(boardId, v) {
  let doc;
  try { doc = await api.version(boardId, v.stamp); }
  catch (err) { toast(err.message, { kind: 'error' }); return; }

  const body = h('div.ver-peek');
  for (const c of Object.values(doc.cards || {})) {
    // stripHtml goes through a real element, so &amp; comes back as "&" —
    // a regex that only eats tags leaves the entities showing raw
    const lines = (c.blocks || [])
      .filter((b) => b.type !== 'image' && (b.html || '').trim())
      .map((b) => stripHtml(b.html).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const shots = (c.blocks || []).filter((b) => b.type === 'image').length;
    body.append(h('div.ver-peek-card',
      h('h4', { text: (c.title || '').trim() || lines[0]?.slice(0, 50) || 'untitled' }),
      shots ? h('span.ver-peek-shots', { text: `${shots} screenshot${shots === 1 ? '' : 's'}` }) : null,
      ...lines.slice(0, 12).map((l) => h('p', { text: l }))));
  }
  if (!body.children.length) body.append(h('p.modal-text.dim', { text: 'this version is empty.' }));

  await openModal({
    title: `as it was ${fmtRel(v.stamp)}`,
    width: 620,
    body,
    actions: [{ label: 'close', value: null }],
  });
}

/* ---------------------------------------------------------------- restoring */

async function restore(boardId, v, close) {
  const ok = await confirmDialog({
    title: `go back to ${fmtRel(v.stamp)}?`,
    body: 'everything written since then is replaced by that version. it lands on the undo stack, '
      + 'so ctrl+z brings the current one straight back — and a snapshot of what you have now is '
      + 'taken on the next save either way.',
    okLabel: 'restore this version',
    danger: true,
  });
  if (!ok) return;

  let doc;
  try { doc = await api.version(boardId, v.stamp); }
  catch (err) { toast(err.message, { kind: 'error' }); return; }

  // keep the identity and the position in the world; take everything else
  commit('restore version', (b) => {
    const keepId = b.id;
    for (const key of Object.keys(b)) delete b[key];
    Object.assign(b, doc, { id: keepId });
  });

  // the open page may not exist in the older version
  if (!state.board.cards[state.cardId]) state.cardId = state.board.rootId;

  await saveNow();
  close?.(null);

  const { go } = await import('./nav.js?v=d258d51ea6');
  await go({ name: 'page', boardId, cardId: state.cardId });
  toast(`restored the version from ${fmtRel(v.stamp)} · ctrl+z undoes it`, { kind: 'ok', ms: 5000 });
}
