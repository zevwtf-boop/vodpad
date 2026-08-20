/* loot routes — plan a drop and a rotation on the real island.

   the island picture comes from fortnite-api.com (public, no key, exists to be
   consumed) via `api.lootmap()`. the markers ship with the app in
   `app/lootmap/markers-s<season>.json`: 4,023 points and 95 segments across 33
   layers, captured once a season by hand — see the lootmap-capture skill.
   **nothing here ever touches fortnite.gg at runtime**; it is behind a bot
   challenge and that is a deliberate manual step.

   everything you draw is stored on the board document, so a route syncs and
   shares with the session it belongs to and needs no schema of its own.

   coordinates: markers are kept in **epic world units**, not fractions of the
   image, so the file stays checkable against epic's own numbers and one
   calibration fix re-places all of them at once. the world -> image mapping
   lives in `map.calib` and can be nudged if a season ships a different crop.
*/

import { $, h, clear, clamp, uid, download, fmtClock, parseClock } from './util.js?v=7cc5d8f531';
import { icon } from './icons.js?v=7cc5d8f531';
import { api } from './api.js?v=7cc5d8f531';
import { state, commit, quietly } from './store.js?v=7cc5d8f531';
import { toast, contextMenu, promptDialog, confirmDialog, openModal, pushLayer, dropLayer } from './ui.js?v=7cc5d8f531';
import { animate, EASE } from './motion.js?v=7cc5d8f531';

/* the island image covers a 270,000-unit square centred on the origin. this is
   the community convention and matches the capture's own note ("worst residual
   5.7 world units on a 270,000-unit island"). it is a default, not a law —
   `map.calib` overrides it, and the nudge control writes there. */
const DEFAULT_CALIB = { minX: -135000, maxY: 135000, span: 270000 };

/* 1 world unit is 1 cm, so 100 units is a metre. sprinting is about 7.3 m/s,
   which is 730 units/second. it is an estimate and the ui says so. */
const SPRINT = 730;

const KINDS = {
  drop:     { label: 'drop here',      colour: '#e5484d', shape: 'pin' },
  chest:    { label: 'chest',          colour: '#e6a23c', shape: 'diamond' },
  gold:     { label: 'gold bar',       colour: '#f5c451', shape: 'diamond' },
  register: { label: 'cash register',  colour: '#3aa981', shape: 'square' },
  ammo:     { label: 'ammo box',       colour: '#7f9bd4', shape: 'square' },
  vault:    { label: 'vault',          colour: '#b57edc', shape: 'hex' },
  medkit:   { label: 'heals',          colour: '#5ec5a0', shape: 'cross' },
  vehicle:  { label: 'car / boat',     colour: '#8f8f96', shape: 'circle' },
  launch:   { label: 'launch pad',     colour: '#5ab0e0', shape: 'tri' },
  death:    { label: 'died here',      colour: '#ff4d5e', shape: 'x' },
  note:     { label: 'just a note',    colour: '#9b9da5', shape: 'circle' },
};

/* which captured layers are worth having on by default. all 33 at once is 4,000
   dots and unreadable. */
const DEFAULT_LAYERS = ['chests', 'rare_chests'];

let host = null;
let closeFn = null;
let data = null;          // the captured markers file
let island = null;        // {island: url, pois: []}
let svgEl = null;         // the overlay, kept so edits redraw it alone
let sideEl = null;
let ghosts = null;        // death markers from every other session, or null

/* ---------------------------------------------------------------- the doc */

const maps = () => state.board?.maps || [];

/* a session with no plans yet gets one to look at, but it is NOT written to the
   document until you actually put something on it. opening the map to check
   where the chests are should not dirty the session or mint a version. */
let scratch = null;

function blankMap(name) {
  const now = Date.now();
  return {
    id: uid('map'), name, created: now, updated: now,
    season: data?.season ? `s${data.season}` : '',
    calib: { ...DEFAULT_CALIB },
    layers: [...DEFAULT_LAYERS],
    markers: [], routes: [],
  };
}

function currentMap() {
  const all = maps();
  if (!all.length) return scratch;
  scratch = null;
  return all.find((m) => m.id === state.board.openMapId) || all[0];
}

function newMap(name) {
  const map = blankMap(name);
  commit('new loot map', (b) => {
    (b.maps ||= []).push(map);
    b.openMapId = map.id;
  });
  scratch = null;
  return map;
}

/** the first real edit is what turns the scratch plan into a saved one */
function anchorScratch() {
  if (!scratch) return;
  const map = scratch;
  scratch = null;
  commit('new loot map', (b) => {
    (b.maps ||= []).push(map);
    b.openMapId = map.id;
  });
}

/** every write to a map goes through here so `updated` and the open-map pointer
 *  stay honest, and so old boards with no `maps` key never blow up */
function editMap(label, mutate, { full = false } = {}) {
  anchorScratch();                    // first real edit puts it on the document
  const open = currentMap();
  if (!open) return;
  commit(label, (b) => {
    const m = (b.maps || []).find((x) => x.id === open.id);
    if (!m) return;
    mutate(m);
    m.updated = Date.now();
  });
  // dropping a marker used to rebuild the whole surface: the island <img>, the
  // top bar and all 1,396 captured dots. only the overlay and the panel change.
  if (full) paint(); else redraw();
}

/* ---------------------------------------------------------------- geometry */

const calibOf = (map) => ({ ...DEFAULT_CALIB, ...(map?.calib || {}) });

/** world units -> 0..1000 svg units */
function toSvg(map, x, y) {
  const c = calibOf(map);
  return [((x - c.minX) / c.span) * 1000, ((c.maxY - y) / c.span) * 1000];
}

/** 0..1000 svg units -> world units */
function toWorld(map, sx, sy) {
  const c = calibOf(map);
  return [c.minX + (sx / 1000) * c.span, c.maxY - (sy / 1000) * c.span];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** world units -> a readable distance */
const metres = (u) => (u >= 100000 ? `${(u / 100000).toFixed(1)} km` : `${Math.round(u / 100)} m`);
const seconds = (u) => `${Math.round(u / SPRINT)}s`;

/* ---------------------------------------------------------------- opening */

export async function openLootmap() {
  if (!state.board) return;
  if (closeFn) return;

  const wrap = $('#lootmap-wrap');
  host = clear($('#lootmap'));
  wrap.hidden = false;

  host.append(h('div.lm-loading', { text: 'fetching the island…' }));
  animate(wrap, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });

  try {
    if (!data) data = await loadMarkers();
    if (!island) island = await api.lootmap();
  } catch (err) {
    clear(host);
    host.append(h('div.lm-loading', { text: `could not load the map: ${err.message}` }));
  }

  if (!maps().length && !scratch) scratch = blankMap('my drop');
  paint();

  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); shut(); } };
  document.addEventListener('keydown', onKey, true);
  closeFn = () => {
    document.removeEventListener('keydown', onKey, true);
    dropLayer(closeFn);
    closeFn = null;
    animate(wrap, [{ opacity: 1 }, { opacity: 0 }], { duration: 150 }).finished
      ?.then(() => { wrap.hidden = true; }) ?? (wrap.hidden = true);
  };
  pushLayer(closeFn);
  wrap.onclick = (e) => { if (e.target === wrap) shut(); };
}

function shut() { closeFn?.(); }
export const closeLootmap = () => closeFn?.();

async function loadMarkers() {
  // the season is in the filename; try the newest we ship and fall back
  for (const season of [41]) {
    try {
      const res = await fetch(`lootmap/markers-s${season}.json`, { cache: 'force-cache' });
      if (res.ok) return await res.json();
    } catch { /* try the next */ }
  }
  throw new Error('no captured markers shipped with this build');
}

/* ---------------------------------------------------------------- view */

const view = { z: 1, x: 0, y: 0 };
let linking = null;          // route id currently being chained

function paint() {
  if (!host) return;
  const map = currentMap();
  clear(host);
  if (!map) return;

  sideEl = sidePanel(map);
  host.append(
    topBar(map),
    h('div.lm-body',
      stage(map),
      sideEl),
  );
  applyView();
}

/** everything that changes when you drop a marker or edit a route, and nothing
 *  that does not: the island picture and the top bar stay where they are. */
let layerSig = '';

function redraw() {
  const map = currentMap();
  if (!host || !map || !svgEl) return paint();

  // the captured layers are thousands of nodes and only change when you toggle
  // one. keep them unless the set actually moved.
  const sig = (map.layers || DEFAULT_LAYERS).join(',') + '|' + JSON.stringify(calibOf(map));
  if (sig !== layerSig) {
    svgEl.querySelector('.lm-layers')?.remove();
    drawLayers(svgEl, map);
    svgEl.prepend(svgEl.querySelector('.lm-layers'));
    layerSig = sig;
  }
  for (const cls of ['.lm-ghosts', '.lm-routes', '.lm-markers', '.lm-pois']) svgEl.querySelector(cls)?.remove();
  drawGhosts(svgEl, map);
  drawRoutes(svgEl, map);
  drawMarkers(svgEl, map);
  drawPois(svgEl, map);

  const fresh = sidePanel(map);
  sideEl?.replaceWith(fresh);
  sideEl = fresh;
}

/* ---- top bar ---- */

function topBar(map) {
  // the scratch plan is not on the document yet, but it still needs a tab —
  // otherwise you are looking at something with no name on it
  const all = maps().length ? maps() : [map];
  return h('div.lm-top',
    h('button.icon-btn', { tip: 'close (esc)', on: { click: shut } }, icon('close', { size: 16 })),

    h('div.lm-maps',
      ...all.map((m) => h('button.lm-map-tab', {
        class: m.id === map.id ? 'on' : '',
        text: m.name,
        on: {
          click: () => { quietly((b) => { b.openMapId = m.id; }); paint(); },
          contextmenu: (e) => { e.preventDefault(); mapMenu(m, e.clientX, e.clientY); },
        },
      })),
      h('button.lm-map-add', {
        tip: 'another plan — a different drop, or an endgame rotation',
        on: { click: async () => {
          const name = await promptDialog({ title: 'name this plan', placeholder: 'e.g. endgame west rotate', okLabel: 'create' });
          if (name) { newMap(name); paint(); }
        } },
      }, icon('plus', { size: 14 }))),

    h('div.lm-tools',
      h('span.lm-season', { text: data?.season ? `season ${data.season} · ${data.counts?.points ?? 0} markers` : '' }),
      h('button.icon-btn', { tip: 'fit the island', on: { click: () => { view.z = 1; view.x = 0; view.y = 0; applyView(); } } }, icon('fit', { size: 15 })),
      h('button.icon-btn', { tip: 'what you can do here', on: { click: (e) => helpMenu(e.currentTarget) } }, icon('dots', { size: 15 }))),
  );
}

function mapMenu(m, x, y) {
  contextMenu([
    { header: m.name },
    { label: 'rename', icon: 'pen', onPick: async () => {
      const name = await promptDialog({ title: 'rename plan', value: m.name, okLabel: 'rename' });
      if (name) { commit('rename map', (b) => { const t = b.maps.find((z) => z.id === m.id); if (t) t.name = name; }); paint(); }
    } },
    { label: 'duplicate', icon: 'copy', onPick: () => {
      commit('duplicate map', (b) => {
        const copy = JSON.parse(JSON.stringify(m));
        copy.id = uid('map');
        copy.name = `${m.name} copy`;
        b.maps.push(copy);
        b.openMapId = copy.id;
      });
      paint();
    } },
    { label: 'export as json', icon: 'download', onPick: () => download(`${m.name.replace(/[^a-z0-9]+/gi, '-')}.lootmap.json`, JSON.stringify(m, null, 1), 'application/json') },
    { sep: true },
    { label: 'delete this plan', icon: 'trash', danger: true, onPick: async () => {
      if (!(await confirmDialog({ title: `delete "${m.name}"?`, body: 'the markers and routes on it go too.', okLabel: 'delete', danger: true }))) return;
      commit('delete map', (b) => {
        b.maps = (b.maps || []).filter((z) => z.id !== m.id);
        if (b.openMapId === m.id) b.openMapId = b.maps[0]?.id || null;
      });
      // deleting the last plan leaves a scratch one to look at, not a saved one
      if (!maps().length) scratch = blankMap('my drop');
      paint();
    } },
  ], { x, y, width: 240 });
}

function helpMenu(anchor) {
  contextMenu([
    { header: 'loot routes' },
    { label: 'click the map to drop a marker', icon: 'pin', disabled: true },
    { label: 'click markers in order to chain a route', icon: 'link', disabled: true },
    { label: 'right-click a marker to change or delete it', icon: 'dots', disabled: true },
    { sep: true },
    { label: 'nudge the island alignment', icon: 'target', onPick: () => nudgeDialog() },
  ], { anchor, align: 'end', width: 290 });
}

/* ---- the map itself ---- */

function stage(map) {
  const img = h('img.lm-island', { src: island?.island || '', alt: '', draggable: 'false' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'lm-svg');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('preserveAspectRatio', 'none');

  const plane = h('div.lm-plane', img, svg);
  const stageEl = h('div.lm-stage#lm-stage', plane);
  svgEl = svg;
  layerSig = (map.layers || DEFAULT_LAYERS).join(',') + '|' + JSON.stringify(calibOf(map));

  drawLayers(svg, map);
  drawGhosts(svg, map);
  drawRoutes(svg, map);
  drawMarkers(svg, map);
  drawPois(svg, map);

  let moved = false;
  stageEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = stageEl.getBoundingClientRect();
    const px = e.clientX - box.left - box.width / 2;
    const py = e.clientY - box.top - box.height / 2;
    const next = clamp(view.z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.6, 14);
    const ratio = next / view.z;
    view.x = px - (px - view.x) * ratio;
    view.y = py - (py - view.y) * ratio;
    view.z = next;
    applyView();
  }, { passive: false });

  stageEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.lm-marker')) return;
    moved = false;
    // capture is a nicety — losing it must not take the whole drag with it
    try { stageEl.setPointerCapture(e.pointerId); } catch { /* carry on */ }
    stageEl.classList.add('dragging');
    const from = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    const move = (ev) => {
      if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) > 3) moved = true;
      view.x = from.vx + (ev.clientX - from.x);
      view.y = from.vy + (ev.clientY - from.y);
      applyView();
    };
    const up = (ev) => {
      stageEl.classList.remove('dragging');
      stageEl.removeEventListener('pointermove', move);
      stageEl.removeEventListener('pointerup', up);
      if (!moved) dropMarker(ev, stageEl, map);
    };
    stageEl.addEventListener('pointermove', move);
    stageEl.addEventListener('pointerup', up);
  });

  return stageEl;
}

function applyView() {
  const plane = document.querySelector('.lm-plane');
  if (!plane) return;
  plane.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  // markers are drawn in svg units, so counter-scale them to stay legible
  plane.style.setProperty('--lm-inv', String(1 / view.z));
}

/** where on the island did that click land */
function pointAt(e, stageEl, map) {
  const plane = stageEl.querySelector('.lm-plane');
  const box = plane.getBoundingClientRect();
  const sx = ((e.clientX - box.left) / box.width) * 1000;
  const sy = ((e.clientY - box.top) / box.height) * 1000;
  if (sx < 0 || sx > 1000 || sy < 0 || sy > 1000) return null;
  return toWorld(map, sx, sy);
}

function dropMarker(e, stageEl, map) {
  const world = pointAt(e, stageEl, map);
  if (!world) return;
  const id = uid('mk');
  editMap('drop marker', (m) => {
    m.markers.push({ id, kind: lastKind, x: Math.round(world[0]), y: Math.round(world[1]), note: '' });
    // dropping while chaining adds the new marker straight to the route
    if (linking) {
      const route = m.routes.find((r) => r.id === linking);
      if (route) route.stops.push(id);
    }
  });
}

let lastKind = 'drop';

/* ---- drawing ---- */

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
};

/** the captured layers: thousands of points, so they are plain small dots */
function drawLayers(svg, map) {
  const on = map.layers || DEFAULT_LAYERS;
  const g = el('g', { class: 'lm-layers' });
  for (const id of on) {
    const layer = data?.layers?.[id];
    if (!layer) continue;
    const colour = layerColour(id);
    for (const group of layer.groups || []) {
      for (const p of group.points || []) {
        const [x, y] = toSvg(map, p[0], p[1]);
        g.append(el('circle', { cx: x.toFixed(2), cy: y.toFixed(2), r: 2.4, fill: colour, class: 'lm-dot' }));
      }
      for (const s of group.segments || []) {
        const a = toSvg(map, s[0][0], s[0][1]);
        const b = toSvg(map, s[1][0], s[1][1]);
        g.append(el('line', {
          x1: a[0].toFixed(2), y1: a[1].toFixed(2), x2: b[0].toFixed(2), y2: b[1].toFixed(2),
          stroke: colour, 'stroke-width': 1.4, class: 'lm-seg',
        }));
      }
    }
  }
  svg.append(g);
}

const LAYER_COLOURS = {
  chests: '#e6a23c', rare_chests: '#f5c451', ammo_boxes: '#7f9bd4', vaults: '#b57edc',
  cash_registers: '#3aa981', launchpads: '#5ab0e0', reboot_vans: '#5ec5a0',
  ziplines: '#8f8f96', teleporters: '#b57edc', vending_machines: '#3aa981',
};
const layerColour = (id) => LAYER_COLOURS[id] || '#6c6e77';

function drawPois(svg, map) {
  const g = el('g', { class: 'lm-pois' });
  for (const poi of island?.pois || []) {
    const [x, y] = toSvg(map, poi.world[0], poi.world[1]);
    const label = el('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'lm-poi' });
    label.textContent = poi.name;
    g.append(label);
  }
  svg.append(g);
}

function drawRoutes(svg, map) {
  const g = el('g', { class: 'lm-routes' });
  for (const route of map.routes || []) {
    if (route.hidden) continue;
    const pts = (route.stops || [])
      .map((id) => (map.markers || []).find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => toSvg(map, m.x, m.y));
    if (pts.length < 2) continue;
    g.append(el('polyline', {
      points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
      fill: 'none', stroke: route.colour || '#e5484d',
      'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      class: 'lm-route',
    }));
  }
  svg.append(g);
}

function drawMarkers(svg, map) {
  const g = el('g', { class: 'lm-markers' });
  // which route stop number, if any, each marker is
  const stopOf = new Map();
  for (const route of map.routes || []) {
    (route.stops || []).forEach((id, i) => { if (!stopOf.has(id)) stopOf.set(id, i + 1); });
  }

  for (const mk of map.markers || []) {
    const kind = KINDS[mk.kind] || KINDS.note;
    const [x, y] = toSvg(map, mk.x, mk.y);
    const node = el('g', { class: 'lm-marker', transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` });
    node.append(el('circle', { r: 8, fill: kind.colour, 'fill-opacity': .22, stroke: kind.colour, 'stroke-width': 1.6 }));
    node.append(shapeFor(kind.shape, kind.colour));
    const n = stopOf.get(mk.id);
    if (n) {
      const badge = el('text', { class: 'lm-stop', y: -11 });
      badge.textContent = String(n);
      node.append(badge);
    }
    const title = el('title');
    title.textContent = `${kind.label}${mk.note ? ` — ${mk.note}` : ''}`;
    node.append(title);

    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.addEventListener('click', (e) => { e.stopPropagation(); tapMarker(mk); });
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); markerMenu(mk, e.clientX, e.clientY); });
    g.append(node);
  }
  svg.append(g);
}

function shapeFor(shape, colour) {
  const common = { fill: colour, stroke: 'none' };
  if (shape === 'square') return el('rect', { x: -3.4, y: -3.4, width: 6.8, height: 6.8, ...common });
  if (shape === 'diamond') return el('polygon', { points: '0,-4.6 4.6,0 0,4.6 -4.6,0', ...common });
  if (shape === 'tri') return el('polygon', { points: '0,-4.8 4.4,3.4 -4.4,3.4', ...common });
  if (shape === 'hex') return el('polygon', { points: '0,-4.8 4.2,-2.4 4.2,2.4 0,4.8 -4.2,2.4 -4.2,-2.4', ...common });
  if (shape === 'cross') return el('path', { d: 'M-4 0 H4 M0 -4 V4', stroke: colour, 'stroke-width': 2, fill: 'none' });
  if (shape === 'x') return el('path', { d: 'M-3.2 -3.2 L3.2 3.2 M3.2 -3.2 L-3.2 3.2', stroke: colour, 'stroke-width': 2, fill: 'none' });
  if (shape === 'pin') return el('path', { d: 'M0 -6 C3.4 -6 4.6 -3.4 4.6 -1.6 C4.6 1.4 0 6 0 6 C0 6 -4.6 1.4 -4.6 -1.6 C-4.6 -3.4 -3.4 -6 0 -6 Z', ...common });
  return el('circle', { r: 3.6, ...common });
}

/** clicking a marker while a route is being chained adds it as the next stop */
function tapMarker(mk) {
  if (!linking) return;
  editMap('add stop', (m) => {
    const route = m.routes.find((r) => r.id === linking);
    if (route && route.stops.at(-1) !== mk.id) route.stops.push(mk.id);
  });
}

function markerMenu(mk, x, y) {
  contextMenu([
    { header: (KINDS[mk.kind] || KINDS.note).label },
    { label: 'what is here…', icon: 'pen', onPick: async () => {
      const note = await promptDialog({ title: 'note on this spot', value: mk.note || '', placeholder: 'usually 2 here, contested', okLabel: 'save' });
      if (note !== null) editMap('marker note', (m) => { const t = m.markers.find((z) => z.id === mk.id); if (t) t.note = note; });
    } },
    { label: 'change what it is', icon: 'layers', subWidth: 220,
      sub: Object.entries(KINDS).map(([key, k]) => ({
        label: k.label, icon: 'pin', checked: mk.kind === key,
        onPick: () => { lastKind = key; editMap('marker kind', (m) => { const t = m.markers.find((z) => z.id === mk.id); if (t) t.kind = key; }); },
      })) },
    { sep: true },
    { label: 'delete this marker', icon: 'trash', danger: true, onPick: () => editMap('delete marker', (m) => {
      m.markers = m.markers.filter((z) => z.id !== mk.id);
      for (const r of m.routes) r.stops = (r.stops || []).filter((s) => s !== mk.id);
    }) },
  ], { x, y, width: 250 });
}

/* ---- the right-hand panel ---- */

function sidePanel(map) {
  return h('aside.lm-side',
    h('div.lm-sec',
      h('div.lm-sec-head', h('h3', { text: 'what you are dropping' })),
      h('div.lm-kinds', ...Object.entries(KINDS).map(([key, k]) => h('button.lm-kind', {
        class: key === lastKind ? 'on' : '',
        tip: `click the map to drop a ${k.label}`,
        on: { click: (e) => {
          lastKind = key;
          for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget);
        } },
      }, h('i', { style: { background: k.colour } }), h('span', { text: k.label }))))),

    routesSection(map),
    deathsSection(),
    layersSection(map),
  );
}

function routesSection(map) {
  const rows = (map.routes || []).map((route) => {
    const stops = (route.stops || [])
      .map((id) => (map.markers || []).find((m) => m.id === id))
      .filter(Boolean);
    let total = 0;
    for (let i = 1; i < stops.length; i++) total += dist([stops[i - 1].x, stops[i - 1].y], [stops[i].x, stops[i].y]);

    const runFor = total / SPRINT;
    // "route timing vs storm", without inventing storm data: you say how long
    // you have, it says whether the rotation fits
    const verdict = route.window && stops.length > 1
      ? (route.window >= runFor
        ? { text: `makes it with ${Math.round(route.window - runFor)}s spare`, cls: 'good' }
        : { text: `${Math.round(runFor - route.window)}s short`, cls: 'bad' })
      : null;

    return h('div.lm-route-row', { class: linking === route.id ? 'chaining' : '' },
      h('span.lm-route-dot', { style: { background: route.colour } }),
      h('div.lm-route-meat',
        h('div.lm-route-name',
          h('span', { text: route.name }),
          route.t !== null && route.t !== undefined
            ? h('button.lm-route-t', { tip: 'jump the vod to where you ran this',
                on: { click: async () => { try { (await import('./video.js?v=7cc5d8f531')).seekTo(route.t); } catch { /* no panel is fine */ } } },
              }, fmtClock(route.t))
            : null),
        h('div.lm-route-sub', { text: stops.length < 2
          ? (linking === route.id ? 'click markers on the map, in order' : 'needs at least two stops')
          : `${stops.length} stops · ${metres(total)} · about ${seconds(total)} sprinting` }),
        verdict ? h('div.lm-route-verdict', { class: verdict.cls, text: verdict.text }) : null),
      h('button.icon-btn', {
        tip: linking === route.id ? 'stop adding stops' : 'add stops by clicking the map',
        class: linking === route.id ? 'on' : '',
        on: { click: () => { linking = linking === route.id ? null : route.id; paint(); } },
      }, icon(linking === route.id ? 'check' : 'link', { size: 14 })),
      h('button.icon-btn', {
        tip: 'more', on: { click: (e) => routeMenu(route, e.currentTarget) },
      }, icon('dots', { size: 14 })));
  });

  return h('div.lm-sec',
    h('div.lm-sec-head',
      h('h3', { text: 'routes' }),
      h('button.btn.btn-sm', { on: { click: addRoute } }, icon('plus', { size: 13 }), 'add')),
    rows.length ? h('div.lm-routes-list', ...rows)
      : h('p.lm-empty', { text: 'a route is markers in order. add one, press the link button, then click your markers in the order you would run them.' }));
}

const ROUTE_COLOURS = ['#e5484d', '#5ab0e0', '#3aa981', '#e6a23c', '#b57edc'];

function addRoute() {
  const map = currentMap();
  const id = uid('rt');
  editMap('add route', (m) => {
    m.routes.push({
      id, name: `route ${m.routes.length + 1}`,
      colour: ROUTE_COLOURS[m.routes.length % ROUTE_COLOURS.length],
      stops: [], hidden: false,
    });
  });
  linking = id;
  paint();
  toast('now click your markers in the order you would run them', { kind: 'ok', ms: 4000 });
}

function routeMenu(route, anchor) {
  contextMenu([
    { header: route.name },
    { label: 'rename', icon: 'pen', onPick: async () => {
      const name = await promptDialog({ title: 'rename route', value: route.name, okLabel: 'rename' });
      if (name) editMap('rename route', (m) => { const t = m.routes.find((r) => r.id === route.id); if (t) t.name = name; });
    } },
    { label: route.hidden ? 'show it' : 'hide it', icon: 'eye',
      onPick: () => editMap('toggle route', (m) => { const t = m.routes.find((r) => r.id === route.id); if (t) t.hidden = !t.hidden; }) },
    { label: 'how long have you got?', icon: 'clock', hint: route.window ? `${route.window}s` : '',
      onPick: async () => {
        const answer = await promptDialog({
          title: 'how long to make this rotation?',
          value: route.window ? String(route.window) : '',
          placeholder: 'seconds, or 1:30',
          okLabel: 'set it',
        });
        if (answer === null) return;
        const secs = answer.includes(':') ? parseClock(answer) : Number(answer);
        editMap('route window', (m) => {
          const t = m.routes.find((r) => r.id === route.id);
          if (t) t.window = Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
        });
      } },
    { label: 'this is the route i ran at…', icon: 'video',
      onPick: async () => {
        // take the vod's current position if the panel is open, otherwise ask
        let t = null;
        try {
          const vid = await import('./video.js?v=7cc5d8f531');
          t = vid.currentTime();
        } catch { /* no panel */ }
        if (!t) {
          const typed = await promptDialog({ title: 'when did you run it?', placeholder: '4:12', okLabel: 'link it' });
          if (typed === null) return;
          t = parseClock(typed);
        }
        editMap('route moment', (m) => {
          const r = m.routes.find((z) => z.id === route.id);
          if (r) r.t = Number.isFinite(t) ? Number(t.toFixed(1)) : null;
        });
      } },
    { label: 'colour', icon: 'palette', subWidth: 180,
      sub: ROUTE_COLOURS.map((c) => ({
        label: c, icon: 'pin', checked: route.colour === c,
        onPick: () => editMap('route colour', (m) => { const t = m.routes.find((r) => r.id === route.id); if (t) t.colour = c; }),
      })) },
    { label: 'clear the stops', icon: 'eraser',
      onPick: () => editMap('clear stops', (m) => { const t = m.routes.find((r) => r.id === route.id); if (t) t.stops = []; }) },
    { sep: true },
    { label: 'delete this route', icon: 'trash', danger: true,
      onPick: () => { if (linking === route.id) linking = null; editMap('delete route', (m) => { m.routes = m.routes.filter((r) => r.id !== route.id); }); } },
  ], { anchor, align: 'end', width: 230 });
}

function layersSection(map) {
  const on = new Set(map.layers || DEFAULT_LAYERS);
  const known = Object.entries(data?.layers || {});
  return h('div.lm-sec',
    h('div.lm-sec-head', h('h3', { text: 'what to show' }),
      h('span.lm-sec-note', { text: `${known.length} captured layers` })),
    h('div.lm-layers-list', ...known.map(([id, layer]) => {
      const count = (layer.groups || []).reduce((n, g) => n + (g.points?.length || 0) + (g.segments?.length || 0), 0);
      return h('button.lm-layer', {
        class: on.has(id) ? 'on' : '',
        tip: layer.note || '',
        on: { click: () => editMap('map layers', (m) => {
          const set = new Set(m.layers || DEFAULT_LAYERS);
          if (set.has(id)) set.delete(id); else set.add(id);
          m.layers = [...set];
        }) },
      },
        h('i', { style: { background: layerColour(id) } }),
        h('span', { text: layer.name || id }),
        h('b', { text: String(count) }));
    })));
}

/* ---------------------------------------------------------------- every session

   a plan lives on one session, which is right — it is that night's plan. but
   "died here" is the one marker whose whole value is cumulative: one death is
   bad luck, the same corner four weeks running is a habit. this reads the death
   markers out of every session you can see and lays them over the island at
   once, so the map answers the same question the pattern finder does, spatially.
*/

async function loadGhosts() {
  const { loadCorpus } = await import('./corpus.js?v=7cc5d8f531');
  const docs = await loadCorpus();
  const out = [];
  for (const doc of docs) {
    for (const m of doc.maps || []) {
      for (const mk of m.markers || []) {
        if (mk.kind !== 'death') continue;
        out.push({
          x: mk.x, y: mk.y, note: mk.note || '',
          boardId: doc.id, boardTitle: doc.title || doc.id,
          when: m.updated || doc.updated || 0,
          mine: doc.id === state.board?.id,
        });
      }
    }
  }
  out.sort((a, b) => b.when - a.when);
  return out;
}

async function toggleGhosts() {
  if (ghosts) { ghosts = null; redraw(); return; }
  ghosts = [];
  redraw();
  try {
    ghosts = await loadGhosts();
    if (!ghosts.length) {
      toast('no "died here" markers anywhere yet — drop a few and this becomes a heatmap', { kind: 'warn', ms: 5000 });
    }
  } catch (err) {
    ghosts = null;
    toast(err.message, { kind: 'error' });
  }
  redraw();
}

/** overlapping translucent blobs make their own heatmap — no binning needed */
function drawGhosts(svg, map) {
  if (!ghosts?.length) return;
  const g = el('g', { class: 'lm-ghosts' });
  for (const d of ghosts) {
    const [x, y] = toSvg(map, d.x, d.y);
    const node = el('g', { class: `lm-ghost${d.mine ? ' mine' : ''}`, transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` });
    node.append(el('circle', { r: 14, class: 'lm-ghost-heat' }));
    node.append(el('circle', { r: 3, class: 'lm-ghost-dot' }));
    const title = el('title');
    title.textContent = `died here — ${d.boardTitle}${d.note ? ` — ${d.note}` : ''}`;
    node.append(title);
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (d.boardId === state.board?.id) return;
      shut();
      import('./nav.js?v=7cc5d8f531').then((n) => n.go({ name: 'page', boardId: d.boardId }));
    });
    node.addEventListener('pointerdown', (e) => e.stopPropagation());
    g.append(node);
  }
  svg.append(g);
}

/** the clusters, as a list you can read */
function deathsSection() {
  if (!ghosts) {
    return h('div.lm-sec',
      h('div.lm-sec-head', h('h3', { text: 'where you die' })),
      h('button.btn.btn-sm.lm-wide', { on: { click: toggleGhosts } },
        icon('target', { size: 13 }), 'show every session'),
      h('p.lm-empty', { text: 'lays every "died here" marker from every session over the island at once. one death is bad luck; the same corner four weeks running is a habit.' }));
  }

  // cluster anything within ~4,000 world units of each other, so the list reads
  // as places rather than as one row per death
  const clusters = [];
  for (const d of ghosts) {
    const near = clusters.find((c) => dist([c.x, c.y], [d.x, d.y]) < 4000);
    if (near) { near.hits.push(d); near.x = (near.x + d.x) / 2; near.y = (near.y + d.y) / 2; }
    else clusters.push({ x: d.x, y: d.y, hits: [d] });
  }
  clusters.sort((a, b) => b.hits.length - a.hits.length);

  return h('div.lm-sec',
    h('div.lm-sec-head',
      h('h3', { text: 'where you die' }),
      h('button.btn.btn-sm', { on: { click: toggleGhosts } }, 'hide')),
    ghosts.length
      ? h('div.lm-deaths',
        ...clusters.slice(0, 8).map((c) => h('div.lm-death-row',
          h('b', { text: String(c.hits.length) }),
          h('div.lm-death-meat',
            h('div.lm-death-where', { text: nearestPoi(c.x, c.y) }),
            h('div.lm-death-sub', { text: [...new Set(c.hits.map((x) => x.boardTitle))].slice(0, 3).join(' · ') })))))
      : h('p.lm-empty', { text: 'nothing marked "died here" yet.' }));
}

/** the named place a point is closest to, for a human-readable row */
function nearestPoi(x, y) {
  let best = null;
  let bestD = Infinity;
  for (const poi of island?.pois || []) {
    const d = dist([x, y], poi.world);
    if (d < bestD) { bestD = d; best = poi.name; }
  }
  if (!best) return 'somewhere on the island';
  return bestD > 25000 ? `open ground near ${best}` : best;
}

/* ---------------------------------------------------------------- calibration */

/* the default assumes the island picture is a 270,000-unit square centred on
   the origin. that has held for a long time, but a season could ship a
   different crop, and one number here re-places every marker at once rather
   than needing a re-capture. */
async function nudgeDialog() {
  const map = currentMap();
  const c = calibOf(map);
  const minX = h('input.field', { value: String(c.minX), spellcheck: false });
  const maxY = h('input.field', { value: String(c.maxY), spellcheck: false });
  const span = h('input.field', { value: String(c.span), spellcheck: false });

  const out = await openModal({
    title: 'island alignment',
    width: 460,
    body: h('div',
      h('p.modal-text', { text: 'the picture is assumed to cover a 270,000-unit square centred on '
        + '(0,0). if a season ships a different crop the markers will sit off the landmarks — '
        + 'change these and they all move together.' }),
      h('label.gate-label', { text: 'world x at the left edge' }), minX,
      h('label.gate-label', { text: 'world y at the top edge' }), maxY,
      h('label.gate-label', { text: 'how many units across' }), span),
    actions: [
      { label: 'back to the default', value: 'reset' },
      { label: 'cancel', value: null },
      { label: 'use these', value: 'ok', kind: 'primary' },
    ],
  });
  if (!out) return;
  const next = out === 'reset' ? { ...DEFAULT_CALIB } : {
    minX: Number(minX.value) || DEFAULT_CALIB.minX,
    maxY: Number(maxY.value) || DEFAULT_CALIB.maxY,
    span: Number(span.value) || DEFAULT_CALIB.span,
  };
  editMap('island alignment', (m) => { m.calib = next; });
}
