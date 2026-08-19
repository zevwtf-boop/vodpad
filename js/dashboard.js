/* the entrance. sessions, the drill list, and what you've been getting wrong. */

import { $, h, clear, fmtRel, fmtDate, previewOf, escapeHtml, debounce } from './util.js?v=5aab9d9b3f';
import { icon } from './icons.js?v=5aab9d9b3f';
import { mediaUrl, api, mode } from './api.js?v=5aab9d9b3f';
import { state, bus, createBoard, deleteBoard, refreshBoards, cardTitle, saveSettings, ownerCounts, isForeign } from './store.js?v=5aab9d9b3f';
import { registerSurface, go } from './nav.js?v=5aab9d9b3f';
import { toast, contextMenu, promptDialog, confirmDialog } from './ui.js?v=5aab9d9b3f';
import { stagger, countUp, animate, EASE } from './motion.js?v=5aab9d9b3f';
import { allCards } from './corpus.js?v=5aab9d9b3f';
import { openGear } from './settings.js?v=5aab9d9b3f';

let view = { kind: 'all', tag: null, owner: null };
let query = '';
let host = null;

const show = (kind, extra = {}) => { view = { kind, tag: null, owner: null, ...extra }; render(); };

/** switch the dashboard to one of its views from elsewhere (the command
 *  palette). only paints if the dashboard is the mounted surface — otherwise it
 *  just sets where you land next time. */
export function showView(kind, extra = {}) {
  view = { kind, tag: null, owner: null, ...extra };
  if (host) render();
}

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
    { kind: 'patterns', label: 'patterns', ico: 'target' },
  ];
  // only the synced build has accounts at all, and only an admin runs them
  if (state.admin && mode === 'cloud') items.push({ kind: 'accounts', label: 'accounts', ico: 'users' });
  const tags = tagCounts().slice(0, 9);
  const owners = state.admin ? ownerCounts() : [];

  return h('aside.dash-rail',
    h('div.rail-brand',
      h('span.rail-mark', icon('sparkle', { size: 18 })),
      h('span.rail-name', { text: 'vodpad' })),

    h('nav.rail-nav', ...items.map((it) => h('button.rail-item', {
      class: view.kind === it.kind ? 'on' : '',
      on: { click: () => show(it.kind) },
    }, icon(it.ico, { size: 16 }), h('span', { text: it.label }),
       it.kind === 'drill' ? h('span.rail-count', { text: String(totals().drill || '') }) : null))),

    owners.length > 1 ? h('div.rail-group',
      h('div.rail-label', { text: 'accounts' }),
      ...owners.map(([name, n]) => h('button.rail-item.small', {
        class: view.kind === 'owner' && view.owner === name ? 'on' : '',
        tip: name === state.user ? 'your own sessions' : `everything ${name} has written`,
        on: { click: () => show('owner', { owner: name }) },
      }, icon(name === state.user ? 'shield' : 'user', { size: 15 }),
         h('span', { text: name }), h('span.rail-count', { text: String(n) })))) : null,

    tags.length ? h('div.rail-group',
      h('div.rail-label', { text: 'tags' }),
      ...tags.map(([tag, n]) => h('button.rail-item.small', {
        class: view.kind === 'tag' && view.tag === tag ? 'on' : '',
        on: { click: () => show('tag', { tag }) },
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
      h('p', { text: helloLine() }),
      state.admin ? h('span.admin-badge', { tip: 'you can see and edit every account here' },
        icon('shield', { size: 12 }), 'admin') : null),
    h('div.dash-actions',
      h('div.dash-search',
        icon('search', { size: 15 }),
        h('input.dash-search-input', {
          placeholder: 'filter sessions…', value: query, spellcheck: false,
          on: { input: debounce((e) => { query = e.target.value; paintGrid(); }, 120) },
        })),
      h('button.btn', { tip: 'bring in a .vodpad session file from another device or another person',
        on: { click: async () => (await import('./transfer.js?v=5aab9d9b3f')).pickSessionFile() } }, icon('upload', { size: 15 }), 'import'),
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

function helloLine() {
  const n = state.boards.length;
  if (!n) return 'nothing here yet — make your first session';
  const bits = [`${n} session${n === 1 ? '' : 's'}`];
  if (state.admin) {
    const accounts = ownerCounts().length;
    if (accounts > 1) bits.push(`across ${accounts} accounts`);
  }
  bits.push(`last touched ${fmtRel(state.boards[0]?.updated)}`);
  return bits.join(' · ');
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
  if (view.kind === 'patterns') {
    const { paintPatterns } = await import('./patterns.js?v=5aab9d9b3f');
    return paintPatterns(body);
  }
  if (view.kind === 'accounts') {
    const { paintAccounts } = await import('./accounts.js?v=5aab9d9b3f');
    return paintAccounts(body, (owner) => show('owner', { owner }));
  }

  let list = state.boards.slice();
  if (view.kind === 'starred') list = list.filter((b) => b.starred);
  if (view.kind === 'recent') list = list.slice(0, 8);
  // starring already meant "this one matters"; make it mean "and keep it in
  // front of me" rather than letting it sink as other sessions are touched
  if (view.kind === 'all' || view.kind === 'tag' || view.kind === 'owner') {
    list.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
  }
  if (view.kind === 'tag') list = list.filter((b) => b.tags && b.tags[view.tag]);
  if (view.kind === 'owner') list = list.filter((b) => b.owner === view.owner);
  if (query.trim()) {
    const q = query.toLowerCase();
    list = list.filter((b) => b.title.toLowerCase().includes(q)
      || String(b.owner || '').toLowerCase().includes(q)
      || Object.keys(b.tags || {}).some((t) => t.includes(q)));
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
  : view.kind === 'owner' ? (view.owner === state.user ? 'your sessions' : `${view.owner}'s sessions`)
  : view.kind === 'starred' ? 'starred'
  : view.kind === 'recent' ? 'recently opened' : 'all sessions';

/* on the hosted builds a picture only has a url once something has fetched it,
   so a freshly loaded dashboard used to draw every tile empty. ask for the one
   picture the tile needs and drop it in when it lands. */
function thumbFor(meta) {
  if (!meta.thumb) return h('div.sc-thumb.sc-thumb-empty', icon('page', { size: 22 }));
  const known = mediaUrl(meta.id, meta.thumb);
  // never set src="" — the browser resolves that to the page itself and fetches it
  const img = h('img', { loading: 'lazy', alt: '' });
  if (known) img.src = known;
  else if (api.warmThumb) api.warmThumb(meta.id, meta.thumb).then((url) => { if (url) img.src = url; }).catch(() => {});
  return h('div.sc-thumb', img);
}

function sessionCard(meta) {
  const thumb = thumbFor(meta);

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
    isForeign(meta)
      ? h('span.sc-owner', {
          tip: meta.shared ? `${meta.owner} shared this with everyone` : `${meta.owner}'s session — you see it because you are an admin`,
        }, icon('user', { size: 12 }), meta.owner)
      : meta.shared
        ? h('span.sc-shared', { tip: 'shared with the other accounts' }, icon('link', { size: 12 }), 'shared')
        : null,
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
  const foreign = synced && isForeign(meta);
  // an admin has full control over everyone's sessions, not just their own
  const mine = !foreign || state.admin;
  contextMenu([
    foreign ? { header: `${meta.owner}'s session` } : null,
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
    { label: 'export session file', icon: 'download', hint: '.vodpad', onPick: async () => (await import('./transfer.js?v=5aab9d9b3f')).exportSession(meta.id) },
    {
      label: 'clip list for an editor', icon: 'clock',
      sub: [
        { label: 'plain lines — paste into a message', icon: 'copy',
          onPick: () => clips(meta, false) },
        { label: 'spreadsheet — one row per moment', icon: 'table', hint: '.csv',
          onPick: () => clips(meta, true) },
      ],
      subWidth: 280,
    },
    { label: 'how do i send this to someone?', icon: 'link', onPick: async () => (await import('./transfer.js?v=5aab9d9b3f')).transferHelp() },
    mine ? { sep: true } : null,
    mine ? { label: 'delete session', icon: 'trash', danger: true, onPick: () => remove(meta) } : null,
  ].filter(Boolean), anchor ? { anchor, align: 'end' } : { x, y });
}

/** every timestamp in the session, without having to open it first */
async function clips(meta, csv) {
  try {
    const doc = state.board?.id === meta.id ? state.board : await api.board(meta.id);
    const { exportClipList } = await import('./exporter.js?v=5aab9d9b3f');
    await exportClipList(doc, { csv });
  } catch (err) { toast(err.message, { kind: 'error' }); }
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
  const synced = mode === 'cloud';
  const ok = await confirmDialog({
    title: `delete "${meta.title}"?`,
    body: synced && isForeign(meta)
      ? `this one belongs to ${meta.owner}. deleting it here takes it off their dashboard too, and there is no undo.`
      : synced
        ? 'it is gone from the cloud for good — the hosted build has no trash folder.'
        : 'it moves to data\\trash inside the vodpad folder, so it is recoverable — but it disappears from here.',
    okLabel: 'delete', danger: true,
  });
  if (!ok) return;
  await deleteBoard(meta.id);
  toast('session moved to trash', { kind: 'ok' });
}

async function newSession() {
  const { askForNewSession, applyTemplate } = await import('./templates.js?v=5aab9d9b3f');
  const picked = await askForNewSession();
  if (!picked) return;

  const board = await createBoard(picked.title);
  // the template is stamped on after creation, so a backend that fails here
  // still leaves you with a real (empty) session rather than nothing
  if (picked.template?.blocks?.length) {
    try {
      applyTemplate(board, picked.template);
      await api.saveBoard(board.id, board);
      await refreshBoards();
    } catch (err) {
      toast(`session made, but the template did not stick: ${err.message}`, { kind: 'warn', ms: 5000 });
    }
  }
  toast('session created', { kind: 'ok' });
  go({ name: 'page', boardId: board.id });
}

/* ---------------------------------------------------------------- drill list */

async function paintDrill(body) {
  body.append(h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'drill list' }),
      h('span.section-note', { text: state.admin
        ? 'every note anyone marked as costing them games'
        : 'every note you marked as costing you games' })),
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

  const owners = new Map(state.boards.map((b) => [b.id, b.mine === false ? b.owner : null]));

  for (const row of rows) {
    const preview = previewOf(row.card.blocks, 130);
    const owner = owners.get(row.boardId);
    list.append(h('button.drill-row', {
      on: { click: () => go({ name: 'page', boardId: row.boardId, cardId: row.card.id }) },
    },
      h('span.drill-bar'),
      h('div.drill-meat',
        h('div.drill-title', { text: cardTitle(row.card) }),
        preview ? h('div.drill-preview', { text: preview }) : null,
        h('div.drill-meta',
          owner ? h('span.chip.chip-owner', icon('user', { size: 11 }), h('span', { text: owner })) : null,
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
