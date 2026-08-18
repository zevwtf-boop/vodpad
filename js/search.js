/* ctrl+k — one box for every command and every note you have ever written. */

import { $, h, clear, debounce, fuzzy, highlight, stripHtml, previewOf, fmtRel } from './util.js?v=764fd7e397';
import { icon } from './icons.js?v=764fd7e397';
import { state, card, cardTitle, createBoard } from './store.js?v=764fd7e397';
import { pushLayer, dropLayer, toast } from './ui.js?v=764fd7e397';
import { popIn, popOut } from './motion.js?v=764fd7e397';
import { go, toggleMap } from './nav.js?v=764fd7e397';
import { allCards } from './corpus.js?v=764fd7e397';
import { openGear } from './settings.js?v=764fd7e397';
import { showView } from './dashboard.js?v=764fd7e397';

let close = null;
let rows = [];
let index = 0;
let scope = 'all';

export function openPalette(opts = {}) {
  if (close) return;
  scope = opts.scope || 'all';
  const wrap = $('#palette-wrap');
  const box = clear($('#palette'));
  wrap.hidden = false;

  const input = h('input.palette-input', {
    placeholder: scope === 'board' ? 'search this session…' : 'search notes, or type a command…',
    spellcheck: false,
  });
  const list = h('div.palette-list');

  box.append(
    h('div.palette-top', icon('search', { size: 17 }), input,
      h('span.kbd', { text: 'esc' })),
    list,
    h('div.palette-foot',
      h('span', { html: '<span class="kbd">↑</span> <span class="kbd">↓</span> to move' }),
      h('span', { html: '<span class="kbd">↵</span> to open' }),
      scope === 'board' ? h('span', { text: 'this session only' }) : null),
  );

  wrap.onclick = (e) => { if (e.target === wrap) shut(); };
  input.addEventListener('input', debounce(() => run(input.value, list), 90));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1, list); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1, list); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(); }
    else if (e.key === 'Escape') { e.preventDefault(); shut(); }
  });

  popIn(box, { origin: 'center top', duration: 200 });
  setTimeout(() => input.focus(), 30);
  run('', list);

  close = shut;
  pushLayer(shut);

  function shut() {
    dropLayer(shut);
    close = null;
    popOut(box, { duration: 140 }).then(() => { if (!close) wrap.hidden = true; });
  }
}

export const closePalette = () => close?.();

/* ---------------------------------------------------------------- rows */

function commands() {
  const inBoard = !!state.board && state.route.name !== 'dash';
  return [
    // starting a session goes through the same dialog as the dashboard button,
    // so the template picker is not something you can only find one way
    { id: 'new', title: 'new session', sub: 'start a fresh vod review', ico: 'plus', hint: 'n', run: async () => {
      const { askForNewSession, applyTemplate } = await import('./templates.js?v=764fd7e397');
      const picked = await askForNewSession();
      if (!picked) return;
      const board = await createBoard(picked.title);
      if (picked.template?.blocks?.length) {
        applyTemplate(board, picked.template);
        const { api } = await import('./api.js?v=764fd7e397');
        await api.saveBoard(board.id, board);
      }
      go({ name: 'page', boardId: board.id });
    } },
    { id: 'dash', title: 'go to the dashboard', sub: 'all your sessions', ico: 'home', run: () => go({ name: 'dash' }) },
    { id: 'patterns', title: 'what keeps costing you', sub: 'the same mistakes, read back across every session', ico: 'target',
      run: () => go({ name: 'dash' }).then(() => showView('patterns')) },
    { id: 'drill', title: 'drill list', sub: 'everything still costing you games', ico: 'drill',
      run: () => go({ name: 'dash' }).then(() => showView('drill')) },
    state.admin && { id: 'accounts', title: 'accounts and invite codes', sub: 'who can sign in, and the codes that let them', ico: 'users',
      run: () => go({ name: 'dash' }).then(() => showView('accounts')) },
    inBoard && { id: 'map', title: 'page ⇄ map', sub: 'see the sub-pages spatially', ico: 'grid', hint: 'ctrl+b', run: () => toggleMap() },
    inBoard && { id: 'read', title: 'read mode', sub: 'the whole branch as one document', ico: 'book', hint: 'ctrl+r', run: async () => (await import('./readmode.js?v=764fd7e397')).openReader() },
    inBoard && { id: 'sub', title: 'add a sub-page', sub: 'expand on the topic you are in', ico: 'cards', run: async () => (await import('./page.js?v=764fd7e397')).addSubPage(null) },
    inBoard && { id: 'box', title: 'floating text box', sub: 'drop text anywhere on the page', ico: 'textbox', hint: 'ctrl+shift+t', run: async () => (await import('./page.js?v=764fd7e397')).addFreeBox() },
    inBoard && { id: 'video', title: 'video panel', sub: 'a recording or a youtube link', ico: 'video', hint: 'v', run: async () => (await import('./video.js?v=764fd7e397')).toggleVideo() },
    inBoard && { id: 'frames', title: 'pick a frame', sub: 'the eight either side of where the vod is', ico: 'layers', hint: 'shift+s', run: async () => (await import('./video.js?v=764fd7e397')).pickFrame() },
    inBoard && { id: 'loot', title: 'loot routes', sub: 'plan a drop and a rotation on the real island', ico: 'target', run: async () => (await import('./lootmap.js?v=764fd7e397')).openLootmap() },
    inBoard && { id: 'history', title: 'earlier versions of this session', sub: 'look at one, or go back to it', ico: 'history', run: async () => (await import('./history.js?v=764fd7e397')).openHistory() },
    inBoard && { id: 'tpl', title: 'save this page as a template', sub: 'start future sessions from it', ico: 'copy', run: async () => {
      const { saveAsTemplate } = await import('./templates.js?v=764fd7e397');
      const { card } = await import('./store.js?v=764fd7e397');
      saveAsTemplate(card(state.cardId));
    } },
    inBoard && { id: 'md', title: 'export markdown', sub: 'this page and everything under it', ico: 'download', run: async () => (await import('./exporter.js?v=764fd7e397')).exportMarkdown(state.cardId) },
    inBoard && { id: 'html', title: 'export html', sub: 'self-contained, pictures included', ico: 'download', run: async () => (await import('./exporter.js?v=764fd7e397')).exportHtml(state.cardId) },
    inBoard && { id: 'clips', title: 'export the clip list', sub: 'every timestamp in the session, for an editor', ico: 'clock', hint: '.csv', run: async () => (await import('./exporter.js?v=764fd7e397')).exportClipList(state.board, { csv: true }) },
    { id: 'theme', title: 'change the theme', sub: 'colours, type, density', ico: 'palette', run: () => openGear('appearance') },
    { id: 'motion', title: 'animation settings', sub: 'full, subtle or off', ico: 'sparkle', run: () => openGear('motion') },
    { id: 'keys', title: 'keyboard shortcuts', sub: 'the whole list', ico: 'grid', run: () => openGear('keys') },
    { id: 'files', title: 'open the notes folder', sub: 'your json + png files on disk', ico: 'folder', run: async () => (await import('./api.js?v=764fd7e397')).api.reveal('data') },
  ].filter(Boolean);
}

async function run(query, list) {
  const q = query.trim();
  rows = [];
  index = 0;

  const cmds = commands()
    .map((c) => ({ ...c, kind: 'cmd', score: q ? Math.max(fuzzy(q, c.title), fuzzy(q, c.sub) * 0.4) : 500 }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  rows.push(...cmds.slice(0, q ? 5 : 8));

  if (q.length >= 2) {
    paint(list, 'searching…');
    const cards = await allCards();
    const hits = [];
    for (const row of cards) {
      if (scope === 'board' && row.boardId !== state.board?.id) continue;
      const title = cardTitle(row.card);
      const text = (row.card.blocks || []).map((b) => stripHtml(b.html)).join(' ')
        + ' ' + (row.card.tags || []).map((t) => `#${t}`).join(' ');
      const score = Math.max(fuzzy(q, title) * 1.6, fuzzy(q, text));
      if (score > 0) hits.push({ ...row, title, text, score, kind: 'card' });
    }
    hits.sort((a, b) => b.score - a.score);
    rows.push(...hits.slice(0, 24));
  }

  paint(list, null, q);
}

function paint(list, note, q = '') {
  clear(list);
  if (note) { list.append(h('div.palette-empty', { text: note })); return; }
  if (!rows.length) {
    list.append(h('div.palette-empty', { text: q ? `nothing matches "${q}"` : 'start typing' }));
    return;
  }
  rows.forEach((row, i) => {
    const el = row.kind === 'cmd'
      ? h('div.palette-row', { class: i === index ? 'here' : '', on: { click: () => { index = i; pick(); }, mousemove: () => hover(i, list) } },
          h('span.pr-ico', icon(row.ico, { size: 16 })),
          h('div.pr-main',
            h('div.pr-title', { html: highlight(row.title, q) }),
            h('div.pr-sub', { text: row.sub })),
          row.hint ? h('span.pr-hint', { text: row.hint }) : null)
      : h('div.palette-row', { class: i === index ? 'here' : '', on: { click: () => { index = i; pick(); }, mousemove: () => hover(i, list) } },
          h('span.pr-ico', icon(row.card.severity === 2 ? 'severity' : 'page', { size: 16 })),
          h('div.pr-main',
            h('div.pr-title', { html: highlight(row.title, q) }),
            h('div.pr-sub', { html: `${row.boardTitle} · ${fmtRel(row.card.updated)} — ${highlight(snippet(row.text, q), q)}` })));
    list.append(el);
  });
}

function snippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 90);
  return (i > 24 ? '…' : '') + text.slice(Math.max(0, i - 24), i + 70);
}

function hover(i, list) {
  if (i === index) return;
  index = i;
  Array.from(list.children).forEach((el, j) => el.classList.toggle('here', j === index));
}

function move(delta, list) {
  if (!rows.length) return;
  index = (index + delta + rows.length) % rows.length;
  Array.from(list.children).forEach((el, j) => el.classList.toggle('here', j === index));
  list.children[index]?.scrollIntoView({ block: 'nearest' });
}

function pick() {
  const row = rows[index];
  if (!row) return;
  closePalette();
  if (row.kind === 'cmd') row.run();
  else go({ name: 'page', boardId: row.boardId, cardId: row.card.id });
}
