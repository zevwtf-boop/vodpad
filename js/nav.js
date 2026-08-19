/* router + top bar chrome. three surfaces, one history stack. */

import { $, $$, h, clear } from './util.js?v=44ebe426f1';
import { icon } from './icons.js?v=44ebe426f1';
import { state, bus, openBoard, closeBoard, saveNow, pathTo, cardTitle, card, forceSave } from './store.js?v=44ebe426f1';
import { ghostTo } from './motion.js?v=44ebe426f1';
import { toast, openModal } from './ui.js?v=44ebe426f1';

const SURFACE = { dash: '#surface-dash', board: '#surface-board', page: '#surface-page' };
const mounts = {};

export function registerSurface(name, fns) { mounts[name] = fns; }

let busy = false;

/**
 * go({name:'page', boardId, cardId}, {from: HTMLElement})
 * `from` enables the shared-element flight into the new surface.
 */
export async function go(route, opts = {}) {
  if (busy) return;
  busy = true;
  try {
    const prev = state.route;
    if (route.boardId && state.board?.id !== route.boardId) {
      await saveNow();
      await openBoard(route.boardId);
    }
    if (route.name !== 'dash' && route.cardId && !card(route.cardId)) {
      route = { ...route, cardId: state.board.rootId };
    }
    if (route.name === 'dash') {
      await saveNow();
    } else if (state.board) {
      state.cardId = route.cardId || state.board.rootId;
      state.board.openCardId = state.cardId;
    }
    state.route = route;

    const targetSel = SURFACE[route.name];
    const target = $(targetSel);

    if (opts.from) {
      const box = target.getBoundingClientRect();
      ghostTo(opts.from, { left: box.left + box.width * .12, top: box.top + box.height * .1, width: box.width * .76, height: box.height * .8 });
    }

    for (const [name, sel] of Object.entries(SURFACE)) {
      if (name === route.name) continue;
      const el = $(sel);
      if (!el.hidden) { mounts[name]?.unmount?.(); el.hidden = true; }
    }

    target.hidden = false;
    target.classList.remove('enter');
    void target.offsetWidth;
    target.classList.add('enter');
    mounts[route.name]?.mount?.(target, route, prev);

    paintChrome();
    document.title = route.name === 'dash' ? 'vodpad'
      : `${state.board?.title || 'session'} — vodpad`;
  } catch (err) {
    console.error(err);
    toast(String(err.message || err), { kind: 'error' });
  } finally {
    busy = false;
  }
}

export function back() {
  const r = state.route;
  if (r.name === 'dash') return;
  if (r.name === 'board') return go({ name: 'page', boardId: r.boardId, cardId: r.cardId });
  const cur = card(r.cardId);
  if (cur?.parent) return go({ name: 'page', boardId: r.boardId, cardId: cur.parent });
  return go({ name: 'dash' });
}

export function openCardPage(cardId, from) {
  return go({ name: 'page', boardId: state.board.id, cardId }, { from });
}

export function toggleMap() {
  const r = state.route;
  if (r.name === 'board') return go({ name: 'page', boardId: r.boardId, cardId: r.cardId });
  if (r.name === 'page') return go({ name: 'board', boardId: r.boardId, cardId: r.cardId });
}

/* ---------------------------------------------------------------- chrome */

export function paintChrome() {
  const r = state.route;
  const onDash = r.name === 'dash';
  bus.emit('route', r);

  $('#tb-back').hidden = onDash;
  $('#tb-map').hidden = onDash;
  $('#tb-map').classList.toggle('on', r.name === 'board');
  $('#tb-read').hidden = onDash;
  $('#tb-video').hidden = onDash;
  $('#tb-title').textContent = onDash ? 'vodpad' : (state.board?.title || '');
  paintOwner(onDash ? null : state.boards.find((b) => b.id === r.boardId));

  const crumbs = clear($('#crumbs'));
  if (onDash) return;

  crumbs.append(h('button.crumb', {
    tip: 'all sessions',
    on: { click: () => go({ name: 'dash' }) },
  }, icon('home', { size: 14 })));

  const chain = pathTo(state.cardId);
  chain.forEach((c, i) => {
    const last = i === chain.length - 1;
    crumbs.append(h('span.crumb-sep', { text: '›' }));
    crumbs.append(h('button.crumb', {
      class: last ? 'here' : '',
      text: i === 0 ? (state.board.title || 'session') : cardTitle(c),
      on: { click: () => go({ name: 'page', boardId: state.board.id, cardId: c.id }) },
    }));
  });
  if (r.name === 'board') {
    crumbs.append(h('span.crumb-sep', { text: '›' }));
    crumbs.append(h('span.crumb.here', { text: 'map' }));
  }
}

/** an admin editing someone else's notes should never be in any doubt about it */
function paintOwner(meta) {
  const el = $('#tb-owner');
  if (!el) return;
  if (!meta || meta.mine !== false) { el.hidden = true; return; }
  clear(el);
  el.append(icon('user', { size: 12 }), h('span', { text: meta.owner }));
  el.dataset.tip = `this session belongs to ${meta.owner} — anything you type here lands in their copy`;
  el.hidden = false;
}

/* save light */

const SAVE_WORD = {
  error: 'not saved', conflict: 'clash', saved: 'saved', dirty: 'saving…', saving: 'saving…',
};

bus.on('save', (save) => {
  const el = $('#save-state');
  if (!el) return;
  el.classList.toggle('dirty', save.status === 'dirty' || save.status === 'saving');
  el.classList.toggle('error', save.status === 'error' || save.status === 'conflict');
  el.classList.toggle('show', state.route.name !== 'dash');
  el.querySelector('span').textContent = SAVE_WORD[save.status] || 'saving…';
});

/* two people in one session.
   the worker turns down a save built on an older copy rather than letting the
   last writer flatten the other one in silence. that only leaves a choice, and
   it is not ours to make — so ask, and say plainly what each answer costs. */
let askingAboutClash = false;

bus.on('conflict', async () => {
  if (askingAboutClash || !state.board) return;
  askingAboutClash = true;
  const route = state.route;
  const meta = state.boards.find((b) => b.id === state.board.id);
  const who = meta && meta.mine === false ? meta.owner : 'someone else';

  try {
    const pick = await openModal({
      title: 'this session changed underneath you',
      width: 470,
      body: h('div',
        h('p.modal-text', { text: `${who} saved this session while you had it open, so your copy `
          + 'and theirs have drifted apart. there is no way to keep both — one of them wins.' }),
        h('p.modal-text.dim', { text: 'nothing is written until you pick. closing this leaves your '
          + 'copy on screen, unsaved.' })),
      actions: [
        { label: 'see earlier versions', value: 'history' },
        { label: 'take theirs', value: 'theirs' },
        { label: 'keep mine', value: 'mine', kind: 'danger' },
      ],
    });

    if (pick === 'history') {
      // looking does not resolve the clash, so leave the door open to come back
      await (await import('./history.js?v=44ebe426f1')).openHistory();
      askingAboutClash = false;
      bus.emit('conflict', {});
      return;
    }

    if (pick === 'mine') {
      await forceSave();
      toast('saved over their copy', { kind: 'ok' });
    } else if (pick === 'theirs') {
      const id = state.board.id;
      closeBoard();
      await go({ ...route, boardId: id });
      toast('reloaded their copy', { kind: 'ok' });
    }
  } catch (err) {
    toast(String(err.message || err), { kind: 'error' });
  } finally {
    askingAboutClash = false;
  }
});
