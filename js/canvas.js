/* the map — an infinite plane you can write directly on.

   every card here is a real page; the difference is you can drop them
   anywhere, type on them in place, branch one off another, and zoom out
   until the whole session is one shape you can read.
*/

import { $, $$, h, clear, clamp, uid, rafThrottle, previewOf, stripHtml, debounce } from './util.js?v=5aab9d9b3f';
import { icon } from './icons.js?v=5aab9d9b3f';
import { mediaUrl } from './api.js?v=5aab9d9b3f';
import { state, card, commit, quietly, childrenOf, cardTitle, makeCard, deleteCard, reparentCard, matchesFilter, filterActive, allTags, bus } from './store.js?v=5aab9d9b3f';
import { registerSurface, go, openCardPage, toggleMap } from './nav.js?v=5aab9d9b3f';
import { contextMenu, toast, confirmDialog } from './ui.js?v=5aab9d9b3f';
import { animate, stagger, EASE, ping } from './motion.js?v=5aab9d9b3f';

let host = null, world = null, linksSvg = null, viewport = null;
let view = { x: 0, y: 0, z: 1 };
let parentId = null;
let selected = null;
let query = '';

registerSurface('board', {
  mount(el) { host = el; render(); },
  unmount() { host = null; },
});

bus.on('replace', () => { if (host) render(); });

export const repaint = () => { if (host) paintNodes(); };

/* ---------------------------------------------------------------- render */

function render() {
  if (!host) return;
  parentId = state.cardId;
  clear(host);

  viewport = h('div.map-viewport');
  world = h('div.map-world');
  linksSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  linksSvg.setAttribute('class', 'map-links');

  world.append(linksSvg);
  viewport.append(world);
  host.append(viewport, mapBar(), filterBar(), hintBar());

  const stored = card(parentId)?.view;
  view = stored ? { ...stored } : { x: 0, y: 0, z: 1 };

  paintNodes();
  applyView();
  bindViewport();

  if (!stored) fit(false);
}

function paintNodes() {
  for (const el of $$('.node', world)) el.remove();
  const kids = childrenOf(parentId);

  host.querySelector('.map-empty')?.remove();
  if (!kids.length) {
    host.append(h('div.map-empty',
      h('div.art', icon('cards', { size: 34 })),
      h('h3', { text: 'empty plane' }),
      h('p', { text: 'double-click anywhere to drop a card and start typing on it. tab branches a new one off whatever is selected.' })));
  }

  for (const kid of kids) world.append(nodeEl(kid));
  paintLinks();
  applyQuery();
  stagger($$('.node', world).slice(0, 16), { step: 16, distance: 8 });
}

function nodeEl(c) {
  const dim = filterActive() && !matchesFilter(c);
  const kids = childrenOf(c.id);
  const shot = (c.blocks || []).find((b) => b.type === 'image' && b.src);
  const firstText = (c.blocks || []).find((b) => ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote'].includes(b.type));

  const title = h('div.node-title', {
    contenteditable: 'true', spellcheck: 'false',
    'data-ph': 'name this one',
    text: c.title || '',
    on: {
      input: (e) => {
        const text = e.target.textContent.trim();
        commit('rename card', (b) => { b.cards[c.id].title = text; }, { coalesce: `nt:${c.id}` });
      },
      keydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.querySelector('.node-text')?.focus(); }
        if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      },
      focus: () => select(c.id),
    },
  });

  const text = h('div.node-text', {
    contenteditable: 'true',
    'data-ph': 'a line about it…',
    html: firstText?.html || '',
    on: {
      input: (e) => {
        const html = e.target.innerHTML;
        commit('write on card', (b) => {
          const target = b.cards[c.id];
          let block = (target.blocks || []).find((x) => x.id === firstText?.id);
          if (!block) {
            block = { id: uid('b'), type: 'p', html: '' };
            target.blocks = [block, ...(target.blocks || [])];
          }
          block.html = html;
        }, { coalesce: `nx:${c.id}` });
      },
      keydown: (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      },
      focus: () => select(c.id),
    },
  });

  const el = h('div.node', {
    class: [dim ? 'dim' : '', selected === c.id ? 'picked' : ''].filter(Boolean).join(' '),
    data: { id: c.id },
    style: { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w || 260}px` },
  },
    h('span.node-bar', { class: `sev-${c.severity || 0}` }),
    h('div.node-body',
      title,
      text,
      shot ? h('div.node-shot', h('img', { src: mediaUrl(state.board.id, shot.src), loading: 'lazy', alt: '' })) : null,
      h('div.node-foot',
        ...(c.tags || []).slice(0, 3).map((t) => h('span.chip.chip-tag', { text: t })),
        (c.blocks || []).length > 1 ? h('span.node-more', { text: `+${(c.blocks || []).length - 1} more` }) : null,
        kids.length ? h('span.node-kids', icon('cards', { size: 11 }), String(kids.length)) : null)),
    h('div.node-ghosts', ...kids.slice(0, 8).map((k) => h('span.ghost-block', { class: `sev-${k.severity || 0}` }))),
    h('div.node-tools',
      h('button.node-tool', { tip: 'open the full page', on: { click: (e) => { e.stopPropagation(); openCardPage(c.id, el); } } }, icon('expand', { size: 13 })),
      h('button.node-tool', { tip: 'branch a new card off this one · tab', on: { click: (e) => { e.stopPropagation(); branchFrom(c.id); } } }, icon('sparkle', { size: 13 })),
      h('button.node-tool', { tip: 'more · or right-click', on: { click: (e) => { e.stopPropagation(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: e.clientX, clientY: e.clientY })); } } }, icon('dots', { size: 13 }))),
    h('button.node-link', { tip: 'drag to another card to draw an arrow', on: { pointerdown: (e) => startLink(e, c.id) } }, icon('link', { size: 12 })),
  );

  el.addEventListener('pointerdown', (e) => {
    select(c.id);
    if (e.target.isContentEditable || e.target.closest('button')) return;
    startDrag(e, c.id, el);
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.isContentEditable) return;
    e.stopPropagation();
    openCardPage(c.id, el);
  });
  return el;
}

function select(id) {
  selected = id;
  for (const el of $$('.node', world)) el.classList.toggle('picked', el.dataset.id === id);
}

/* ---------------------------------------------------------------- making cards */

export function addNodeAt(clientX, clientY, focus = true) {
  const rect = viewport.getBoundingClientRect();
  const x = Math.round((clientX - rect.left - view.x) / view.z) - 120;
  const y = Math.round((clientY - rect.top - view.y) / view.z) - 40;
  const kid = makeCard(parentId, { x, y, title: '' });
  paintNodes();
  const el = world.querySelector(`.node[data-id="${kid.id}"]`);
  if (el) {
    animate(el, [{ transform: 'scale(.85)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 240, easing: EASE.snap });
    if (focus) el.querySelector('.node-title')?.focus();
  }
  select(kid.id);
  return kid;
}

export function branchFrom(id) {
  const from = card(id);
  if (!from) return;
  const siblings = childrenOf(parentId).filter((c) => c.id !== id);
  let y = from.y;
  const x = from.x + (from.w || 260) + 90;
  while (siblings.some((s) => Math.abs(s.x - x) < 200 && Math.abs(s.y - y) < 130)) y += 150;

  const kid = makeCard(parentId, { x, y, title: '' });
  commit('branch', (b) => { (b.links ||= []).push({ id: uid('l'), from: id, to: kid.id }); });
  paintNodes();
  const el = world.querySelector(`.node[data-id="${kid.id}"]`);
  if (el) {
    el.querySelector('.node-title')?.focus();
    ping(el);
  }
  select(kid.id);
  return kid;
}

export function duplicateNode(id) {
  const source = card(id);
  if (!source) return;
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = uid('c');
  copy.x = source.x + 40;
  copy.y = source.y + 40;
  copy.children = [];
  copy.blocks = (copy.blocks || []).map((b) => ({ ...b, id: uid('b') }));
  commit('duplicate card', (b) => {
    b.cards[copy.id] = copy;
    (b.cards[parentId].children ||= []).push(copy.id);
  });
  paintNodes();
}

export function editNodeTitle(id) {
  world.querySelector(`.node[data-id="${CSS.escape(id)}"] .node-title`)?.focus();
}

/* ---------------------------------------------------------------- links */

function paintLinks() {
  const links = (state.board.links || []).filter((l) => card(l.from)?.parent === parentId && card(l.to)?.parent === parentId);
  linksSvg.innerHTML = '';
  const bounds = worldBounds();
  linksSvg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
  linksSvg.style.left = `${bounds.x}px`;
  linksSvg.style.top = `${bounds.y}px`;
  linksSvg.style.width = `${bounds.w}px`;
  linksSvg.style.height = `${bounds.h}px`;

  const NS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = `<marker id="map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent-dim)"/></marker>`;
  linksSvg.append(defs);

  for (const link of links) {
    const a = card(link.from), b = card(link.to);
    const rightward = b.x >= a.x;
    const x1 = rightward ? a.x + (a.w || 260) : a.x;
    const y1 = a.y + 34;
    const x2 = rightward ? b.x : b.x + (b.w || 260);
    const y2 = b.y + 34;
    const bend = Math.max(40, Math.abs(x2 - x1) * .4) * (rightward ? 1 : -1);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
    path.setAttribute('class', 'map-link');
    path.setAttribute('marker-end', 'url(#map-arrow)');
    path.dataset.id = link.id;
    path.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextMenu([{ label: 'remove arrow', icon: 'trash', danger: true, onPick: () => {
        commit('remove arrow', (bd) => { bd.links = bd.links.filter((l) => l.id !== link.id); });
        paintLinks();
      } }], { x: e.clientX, y: e.clientY });
    });
    linksSvg.append(path);
  }
}

function startLink(e, fromId) {
  e.preventDefault();
  e.stopPropagation();
  document.body.classList.add('linking');
  const onUp = (ev) => {
    document.removeEventListener('pointerup', onUp, true);
    document.body.classList.remove('linking');
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    const toId = target?.dataset.id;
    if (!toId || toId === fromId) return;
    commit('draw arrow', (b) => { (b.links ||= []).push({ id: uid('l'), from: fromId, to: toId }); });
    paintLinks();
    toast('arrow drawn — right-click it to remove', { kind: 'ok', ms: 1800 });
  };
  document.addEventListener('pointerup', onUp, true);
}

/* ---------------------------------------------------------------- viewport */

function worldBounds() {
  const kids = childrenOf(parentId);
  if (!kids.length) return { x: 0, y: 0, w: 1200, h: 800 };
  const xs = kids.map((c) => c.x), ys = kids.map((c) => c.y);
  const xe = kids.map((c) => c.x + (c.w || 260)), ye = kids.map((c) => c.y + 240);
  return {
    x: Math.min(...xs) - 200, y: Math.min(...ys) - 200,
    w: Math.max(...xe) - Math.min(...xs) + 400,
    h: Math.max(...ye) - Math.min(...ys) + 400,
  };
}

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  world.dataset.lod = view.z < (state.settings.lodThreshold || 0.42) ? 'far' : view.z < 0.75 ? 'mid' : 'near';
  const label = $('.zoom-label', host);
  if (label) label.textContent = `${Math.round(view.z * 100)}%`;
}

const persistView = rafThrottle(() => {
  const id = parentId;
  quietly((b) => { if (b.cards[id]) b.cards[id].view = { ...view }; });
});

function zoomAt(clientX, clientY, factor) {
  const rect = viewport.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  const next = clamp(view.z * factor, 0.12, 2.6);
  const scale = next / view.z;
  view.x = px - (px - view.x) * scale;
  view.y = py - (py - view.y) * scale;
  view.z = next;
  applyView();
  persistView();
}

function bindViewport() {
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
    else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); persistView(); }
  }, { passive: false });

  viewport.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.node')) return;
    if (e.button !== 0 && e.button !== 1) return;
    select(null);
    const startX = e.clientX, startY = e.clientY;
    const ox = view.x, oy = view.y;
    viewport.classList.add('panning');
    const onMove = (ev) => { view.x = ox + (ev.clientX - startX); view.y = oy + (ev.clientY - startY); applyView(); };
    const onUp = () => {
      viewport.classList.remove('panning');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      persistView();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });

  viewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.node')) return;
    addNodeAt(e.clientX, e.clientY, true);
  });

  viewport.addEventListener('keydown', (e) => {
    const typing = document.activeElement?.isContentEditable;
    if (e.key === 'Tab' && selected) {
      e.preventDefault();
      branchFrom(selected);
      return;
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      const target = card(selected);
      confirmDialog({ title: `delete "${cardTitle(target)}"?`, okLabel: 'delete', danger: true })
        .then((ok) => { if (ok) { deleteCard(selected); selected = null; paintNodes(); } });
    }
  });
  viewport.tabIndex = 0;
}

function startDrag(e, cardId, el) {
  if (e.button !== 0 || e.target.closest('.node-link, .node-tool')) return;
  const c = card(cardId);
  const startX = e.clientX, startY = e.clientY;
  const ox = c.x, oy = c.y;
  let moved = false;
  const snap = state.settings.gridSnap !== false ? (state.settings.snapSize || 8) : 1;

  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / view.z;
    const dy = (ev.clientY - startY) / view.z;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) { moved = true; el.classList.add('dragging'); }
    const x = Math.round((ox + dx) / snap) * snap;
    const y = Math.round((oy + dy) / snap) * snap;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el._x = x; el._y = y;
    paintLinks();
  };
  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!moved) return;
    el.classList.remove('dragging');
    const over = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((n) => n.classList?.contains('node') && n.dataset.id !== cardId);
    if (over && ev.altKey) {
      reparentCard(cardId, over.dataset.id, { x: 40, y: 40 });
      toast(`moved inside "${cardTitle(card(over.dataset.id))}"`, { kind: 'ok' });
      paintNodes();
      return;
    }
    const nx = el._x, ny = el._y;
    commit('move card', (b) => { const t = b.cards[cardId]; if (t) { t.x = nx; t.y = ny; } });
    paintLinks();
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

export function fit(animateIt = true) {
  const kids = childrenOf(parentId);
  if (!kids.length || !viewport) { view = { x: 40, y: 40, z: 1 }; applyView(); return; }
  const b = worldBounds();
  const rect = viewport.getBoundingClientRect();
  const z = clamp(Math.min(rect.width / b.w, rect.height / b.h) * .92, 0.15, 1.2);
  view = { z, x: rect.width / 2 - (b.x + b.w / 2) * z, y: rect.height / 2 - (b.y + b.h / 2) * z };
  if (animateIt) world.style.transition = `transform 320ms ${EASE.emph}`;
  applyView();
  if (animateIt) setTimeout(() => { world.style.transition = ''; }, 360);
  persistView();
}

export function zoomBy(factor) {
  if (!viewport) return;
  const rect = viewport.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

/** centre the view on one card at a comfortable zoom */
export function zoomToCard(id, { scale = 1 } = {}) {
  const c = card(id);
  if (!c || !viewport) return;
  const rect = viewport.getBoundingClientRect();
  view.z = clamp(scale, 0.15, 2.6);
  view.x = rect.width / 2 - (c.x + (c.w || 260) / 2) * view.z;
  view.y = rect.height / 2 - (c.y + 90) * view.z;
  world.style.transition = `transform 340ms ${EASE.emph}`;
  applyView();
  setTimeout(() => { world.style.transition = ''; }, 380);
  persistView();
}

/* ---------------------------------------------------------------- searching the plane */

export function focusMapSearch() {
  $('.map-search-input', host)?.focus();
}

function applyQuery() {
  const q = query.trim().toLowerCase();
  let first = null;
  for (const el of $$('.node', world)) {
    if (!q) { el.classList.remove('hit', 'miss'); continue; }
    const c = card(el.dataset.id);
    const hay = `${cardTitle(c)} ${(c.tags || []).join(' ')} ${(c.blocks || []).map((b) => stripHtml(b.html)).join(' ')}`.toLowerCase();
    const hit = hay.includes(q);
    el.classList.toggle('hit', hit);
    el.classList.toggle('miss', !hit);
    if (hit && !first) first = c.id;
  }
  return first;
}

/* ---------------------------------------------------------------- chrome */

function mapBar() {
  const search = h('input.map-search-input', {
    placeholder: 'find on this plane…', spellcheck: false,
    on: {
      input: debounce((e) => { query = e.target.value; applyQuery(); }, 120),
      keydown: (e) => {
        if (e.key === 'Enter') { const id = applyQuery(); if (id) { zoomToCard(id, { scale: 1 }); ping(world.querySelector(`.node[data-id="${id}"]`)); } }
        if (e.key === 'Escape') { e.target.value = ''; query = ''; applyQuery(); e.target.blur(); }
      },
    },
  });

  return h('div.map-bar',
    h('button.icon-btn', { tip: 'back to the page · ctrl+shift+b', on: { click: () => toggleMap() } }, icon('page')),
    h('span.tb-sep'),
    h('div.map-search', icon('search', { size: 14 }), search),
    h('span.tb-sep'),
    h('button.icon-btn', { tip: 'zoom out', on: { click: () => zoomBy(0.85) } }, icon('zoomOut')),
    h('span.zoom-label', { text: '100%' }),
    h('button.icon-btn', { tip: 'zoom in', on: { click: () => zoomBy(1.18) } }, icon('zoomIn')),
    h('button.icon-btn', { tip: 'fit everything · ctrl+0', on: { click: () => fit() } }, icon('fit')),
    h('span.tb-sep'),
    h('button.icon-btn', { tip: 'new card in the middle', on: { click: () => {
      const rect = viewport.getBoundingClientRect();
      addNodeAt(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
    } } }, icon('plus')),
  );
}

function hintBar() {
  return h('div.map-hint',
    h('span', h('span.kbd', { text: 'dbl-click' }), ' new card'),
    h('span', h('span.kbd', { text: 'tab' }), ' branch off'),
    h('span', h('span.kbd', { text: 'ctrl+wheel' }), ' zoom'),
    h('span', h('span.kbd', { text: 'alt+drag' }), ' nest inside'),
  );
}

function filterBar() {
  const tags = allTags();
  const wrap = h('div.map-filter');
  if (!tags.length) return wrap;

  wrap.append(h('span.filter-label', icon('filter', { size: 13 })));
  for (const [tag, n] of tags.slice(0, 12)) {
    wrap.append(h('button.chip.chip-tag', {
      class: state.filter.tags.has(tag) ? 'on' : '',
      text: `${tag} ${n}`,
      on: {
        click: () => {
          if (state.filter.tags.has(tag)) state.filter.tags.delete(tag); else state.filter.tags.add(tag);
          render();
        },
      },
    }));
  }
  for (const lvl of [1, 2, 3]) {
    wrap.append(h('button.chip.chip-sev', {
      class: `sev-${lvl} ${state.filter.sev === lvl ? 'on' : ''}`,
      tip: ['', 'working on it', 'costs me games', 'fixed'][lvl],
      on: { click: () => { state.filter.sev = state.filter.sev === lvl ? null : lvl; render(); } },
    }, h('span.sev-dot', { class: `sev-${lvl}` })));
  }
  if (filterActive()) {
    wrap.append(h('button.chip', { text: 'clear', on: { click: () => { state.filter.tags.clear(); state.filter.sev = null; render(); } } }));
  }
  return wrap;
}
