/* the entrance. sessions, the drill list, and what you've been getting wrong. */

import { $, h, clear, fmtRel, fmtDate, previewOf, escapeHtml, debounce } from './util.js';
import { icon } from './icons.js';
import { mediaUrl, api, mode } from './api.js';
import { state, bus, createBoard, deleteBoard, refreshBoards, cardTitle, saveSettings } from './store.js';
import { registerSurface, go } from './nav.js';
import { toast, contextMenu, promptDialog, confirmDialog } from './ui.js';
import { stagger, countUp, animate, EASE } from './motion.js';
import { allCards } from './corpus.js';
import { openGear } from './settings.js';

let view = { kind: 'all', tag: null };
let query = '';
let host = null;

registerSurface('dash', {
  mount(el) { host = el; render(); },
  unmount() { host = null; },
});

bus.on('boards', () => { if (host) render(); });

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 5) return 'still up';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
};

/* ---------------------------------------------------------------- render */

function render() {
  if (!host) return;
  clear(host);
  host.append(h('div.dash', rail(), main()));
  paintGrid();                       // after it's in the dom — paintGrid looks itself up
}

function rail() {
  const items = [
    { kind: 'all', label: 'all sessions', ico: 'cards' },
    { kind: 'recent', label: 'recent', ico: 'clock' },
    { kind: 'starred', label: 'starred', ico: 'star' },
    { kind: 'drill', label: 'drill list', ico: 'drill' },
  ];
  const tags = tagCounts().slice(0, 9);

  return h('aside.dash-rail',
    h('div.rail-brand',
      h('span.rail-mark', icon('sparkle', { size: 18 })),
      h('span.rail-name', { text: 'vodpad' })),

    h('nav.rail-nav', ...items.map((it) => h('button.rail-item', {
      class: view.kind === it.kind ? 'on' : '',
      on: { click: () => { view = { kind: it.kind, tag: null }; render(); } },
    }, icon(it.ico, { size: 16 }), h('span', { text: it.label }),
       it.kind === 'drill' ? h('span.rail-count', { text: String(totals().drill || '') }) : null))),

    tags.length ? h('div.rail-group',
      h('div.rail-label', { text: 'tags' }),
      ...tags.map(([tag, n]) => h('button.rail-item.small', {
        class: view.kind === 'tag' && view.tag === tag ? 'on' : '',
        on: { click: () => { view = { kind: 'tag', tag }; render(); } },
      }, h('span.rail-hash', { text: '#' }), h('span', { text: tag }), h('span.rail-count', { text: String(n) })))) : null,

    h('div.rail-foot',
      h('button.rail-item.small', { on: { click: () => openGear() } }, icon('gear', { size: 15 }), h('span', { text: 'settings' })),
      h('button.rail-item.small', { on: { click: () => api.reveal('data').catch(() => toast('could not open the folder', { kind: 'error' })) } },
        icon('folder', { size: 15 }), h('span', { text: 'open notes folder' })),
    ),
  );
}

function main() {
  const el = h('main.dash-main');
  const t = totals();

  el.append(h('header.dash-head',
    h('div.dash-hello',
      h('h1', { text: greeting() }),
      h('p', { text: state.boards.length
        ? `${state.boards.length} session${state.boards.length === 1 ? '' : 's'} · last touched ${fmtRel(state.boards[0]?.updated)}`
        : 'nothing here yet — make your first session' })),
    h('div.dash-actions',
      h('div.dash-search',
        icon('search', { size: 15 }),
        h('input.dash-search-input', {
          placeholder: 'filter sessions…', value: query, spellcheck: false,
          on: { input: debounce((e) => { query = e.target.value; paintGrid(); }, 120) },
        })),
      h('button.btn', { tip: 'bring in a .vodpad session file from another device or another person',
        on: { click: async () => (await import('./transfer.js')).pickSessionFile() } }, icon('upload', { size: 15 }), 'import'),
      h('button.btn.btn-primary', { on: { click: newSession } }, icon('plus', { size: 15 }), 'new session')),
  ));

  const stats = h('div.stats-strip',
    statTile('sessions', t.sessions, 'cards'),
    statTile('notes', t.notes, 'page'),
    statTile('screenshots', t.shots, 'image'),
    statTile('still costing games', t.drill, 'severity', 'sev-2'),
  );
  el.append(stats);

  el.append(h('div.dash-body#dash-body'));
  requestAnimationFrame(() => stagger(Array.from(stats.children), { step: 40, distance: 12 }));
  return el;
}

function statTile(label, value, ico, cls = '') {
  const num = h('div.stat-num', { text: String(value) });
  requestAnimationFrame(() => countUp(num, value));
  return h('div.stat-tile', { class: cls },
    h('div.stat-ico', icon(ico, { size: 16 })),
    h('div.stat-meat', num, h('div.stat-label', { text: label })));
}

/* ---------------------------------------------------------------- grid */

async function paintGrid() {
  const body = $('#dash-body');
  if (!body) return;
  clear(body);

  if (view.kind === 'drill') return paintDrill(body);

  let list = state.boards.slice();
  if (view.kind === 'starred') list = list.filter((b) => b.starred);
  if (view.kind === 'recent') list = list.slice(0, 8);
  if (view.kind === 'tag') list = list.filter((b) => b.tags && b.tags[view.tag]);
  if (query.trim()) {
    const q = query.toLowerCase();
    list = list.filter((b) => b.title.toLowerCase().includes(q) || Object.keys(b.tags || {}).some((t) => t.includes(q)));
  }

  if (!list.length) {
    body.append(emptyState());
    return;
  }

  const grid = h('div.session-grid', ...list.map(sessionCard));
  body.append(h('div.dash-section',
    h('div.section-head', h('h2', { text: sectionTitle() }), h('span.section-count', { text: `${list.length}` })),
    grid));
  stagger(Array.from(grid.children), { step: 26, distance: 14 });
}

const sectionTitle = () => view.kind === 'tag' ? `#${view.tag}`
  : view.kind === 'starred' ? 'starred'
  : view.kind === 'recent' ? 'recently opened' : 'all sessions';

function sessionCard(meta) {
  const thumb = meta.thumb
    ? h('div.sc-thumb', h('img', { src: mediaUrl(meta.id, meta.thumb), loading: 'lazy', alt: '' }))
    : h('div.sc-thumb.sc-thumb-empty', icon('page', { size: 22 }));

  const tags = Object.entries(meta.tags || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);

  const card = h('article.session-card', { tabindex: '0' },
    thumb,
    h('div.sc-body',
      h('div.sc-title', { text: meta.title }),
      h('div.sc-meta',
        h('span', { text: fmtRel(meta.updated) }),
        h('span.dot', { text: '·' }),
        h('span', { text: `${meta.noteCount} notes` }),
        meta.shotCount ? h('span.dot', { text: '·' }) : null,
        meta.shotCount ? h('span', { text: `${meta.shotCount} shots` }) : null),
      h('div.sc-foot',
        h('div.sc-tags', ...tags.map(([t]) => h('span.chip.chip-tag', { text: t }))),
        h('div.sc-sev',
          ...[1, 2, 3].map((lvl) => (meta.severities?.[lvl]
            ? h('span.sev-pill', { class: `sev-${lvl}`, text: String(meta.severities[lvl]) })
            : null))))),
    h('button.sc-more.icon-btn', {
      tip: 'more', on: { click: (e) => { e.stopPropagation(); cardMenu(meta, e.currentTarget); } },
    }, icon('dots', { size: 15 })),
    meta.starred ? h('span.sc-star', icon('starOn', { size: 14 })) : null,
    meta.shared ? h('span.sc-shared', { tip: meta.mine === false ? `shared by ${meta.owner}` : 'shared with the other accounts' },
      icon('link', { size: 12 }), meta.mine === false ? meta.owner : 'shared') : null,
  );

  card.addEventListener('click', () => open(meta, card));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(meta, card); });
  card.addEventListener('contextmenu', (e) => { e.preventDefault(); cardMenu(meta, null, e.clientX, e.clientY); });
  return card;
}

function open(meta, from) {
  go({ name: 'page', boardId: meta.id }, { from });
}

function cardMenu(meta, anchor, x, y) {
  const synced = mode === 'cloud';
  const mine = !synced || meta.mine !== false;
  contextMenu([
    { label: 'open', icon: 'forward', onPick: () => open(meta) },
    { label: 'open the map', icon: 'grid', onPick: () => go({ name: 'board', boardId: meta.id }) },
    { sep: true },
    mine ? { label: 'rename', icon: 'pen', onPick: () => rename(meta) } : null,
    { label: meta.starred ? 'unstar' : 'star', icon: meta.starred ? 'starOn' : 'star', onPick: () => star(meta) },
    synced && mine ? {
      label: meta.shared ? 'stop sharing it' : 'share with the other accounts',
      icon: meta.shared ? 'eye' : 'link',
      onPick: async () => {
        try {
          await api.setShared(meta.id, !meta.shared);
          await refreshBoards();
          toast(meta.shared ? 'back to private' : 'shared — the others can open it now', { kind: 'ok' });
        } catch (err) { toast(err.message, { kind: 'error' }); }
      },
    } : null,
    !synced ? { label: 'show files', icon: 'folder', onPick: () => api.reveal('board', meta.id).catch(() => {}) } : null,
    { sep: true },
    { label: 'export session file', icon: 'download', hint: '.vodpad', onPick: async () => (await import('./transfer.js')).exportSession(meta.id) },
    { label: 'how do i send this to someone?', icon: 'link', onPick: async () => (await import('./transfer.js')).transferHelp() },
    mine ? { sep: true } : null,
    mine ? { label: 'delete session', icon: 'trash', danger: true, onPick: () => remove(meta) } : null,
  ].filter(Boolean), anchor ? { anchor, align: 'end' } : { x, y });
}

async function rename(meta) {
  const name = await promptDialog({ title: 'rename session', value: meta.title, okLabel: 'rename' });
  if (!name) return;
  const doc = await api.board(meta.id);
  doc.title = name;
  if (doc.cards?.[doc.rootId]) doc.cards[doc.rootId].title = name;
  await api.saveBoard(meta.id, doc);
  if (state.board?.id === meta.id) { state.board.title = name; }
  await refreshBoards();
  toast('renamed', { kind: 'ok' });
}

async function star(meta) {
  const doc = await api.board(meta.id);
  doc.starred = !doc.starred;
  await api.saveBoard(meta.id, doc);
  await refreshBoards();
}

async function remove(meta) {
  const ok = await confirmDialog({
    title: `delete "${meta.title}"?`,
    body: 'it moves to data\\trash inside the vodpad folder, so it is recoverable — but it disappears from here.',
    okLabel: 'delete', danger: true,
  });
  if (!ok) return;
  await deleteBoard(meta.id);
  toast('session moved to trash', { kind: 'ok' });
}

async function newSession() {
  const suggested = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' session';
  const title = await promptDialog({ title: 'new session', value: suggested, placeholder: 'e.g. ranked trios — 09 aug', okLabel: 'create' });
  if (title === null) return;
  const board = await createBoard(title || suggested);
  toast('session created', { kind: 'ok' });
  go({ name: 'page', boardId: board.id });
}

/* ---------------------------------------------------------------- drill list */

async function paintDrill(body) {
  body.append(h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'drill list' }),
      h('span.section-note', { text: 'every note you marked as costing you games' })),
    h('div.drill-list', h('div.skel', { style: { height: '72px' } }), h('div.skel', { style: { height: '72px', marginTop: '10px' } }))));

  const cards = await allCards();
  const rows = cards.filter((row) => (row.card.severity || 0) === 2);
  const list = body.querySelector('.drill-list');
  clear(list);

  if (!rows.length) {
    list.append(h('div.empty',
      h('div.art', icon('drill', { size: 34 })),
      h('h3', { text: 'nothing on the drill list' }),
      h('p', { text: 'mark a note with severity 2 (press 3 on a card, or use the card menu) and it lands here across every session.' })));
    return;
  }

  for (const row of rows) {
    const preview = previewOf(row.card.blocks, 130);
    list.append(h('button.drill-row', {
      on: { click: () => go({ name: 'page', boardId: row.boardId, cardId: row.card.id }) },
    },
      h('span.drill-bar'),
      h('div.drill-meat',
        h('div.drill-title', { text: cardTitle(row.card) }),
        preview ? h('div.drill-preview', { text: preview }) : null,
        h('div.drill-meta',
          h('span', { text: row.boardTitle }),
          h('span.dot', { text: '·' }),
          h('span', { text: fmtRel(row.card.updated) }),
          ...(row.card.tags || []).slice(0, 3).map((t) => h('span.chip.chip-tag', { text: t })))),
      h('span.drill-go', icon('chevron', { size: 15 }))));
  }
  stagger(Array.from(list.children), { step: 22, distance: 10 });
}

/* ---------------------------------------------------------------- helpers */

function totals() {
  let notes = 0, shots = 0, drill = 0;
  for (const b of state.boards) {
    notes += b.noteCount || 0;
    shots += b.shotCount || 0;
    drill += b.severities?.[2] || 0;
  }
  return { sessions: state.boards.length, notes, shots, drill };
}

function tagCounts() {
  const map = new Map();
  for (const b of state.boards) {
    for (const [tag, n] of Object.entries(b.tags || {})) map.set(tag, (map.get(tag) || 0) + n);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function emptyState() {
  if (query.trim()) {
    return h('div.empty',
      h('div.art', icon('search', { size: 32 })),
      h('h3', { text: 'nothing matches that' }),
      h('p', { text: 'try a shorter word, or clear the filter.' }));
  }
  return h('div.empty',
    h('div.art', icon('sparkle', { size: 36 })),
    h('h3', { text: view.kind === 'starred' ? 'no starred sessions yet' : 'start your first session' }),
    h('p', { text: view.kind === 'starred'
      ? 'star a session from its ⋯ menu and it shows up here for one-click access.'
      : 'a session is one sitting of vod review. make one, paste screenshots into it, and write beside them.' }),
    view.kind === 'starred' ? null : h('button.btn.btn-primary', { on: { click: newSession } }, icon('plus', { size: 15 }), 'new session'));
}
