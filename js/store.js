/* the single source of truth: state, mutations, undo, autosave.
   nothing renders from here — surfaces subscribe to the bus and redraw. */

import { api } from './api.js';
import { emitter, uid, debounce, stripHtml } from './util.js';

export const bus = emitter();

export const state = {
  ready: false,
  user: null,                       // signed-in account, on the hosted builds
  admin: false,                     // this account sees every account's sessions
  settings: {},
  boards: [],                       // lightweight meta for the dashboard
  board: null,                      // the open session document
  cardId: null,                     // card open on the page surface
  route: { name: 'dash' },          // dash | board | page
  filter: { tags: new Set(), sev: null, mode: 'dim' },
  save: { status: 'saved', at: 0 },
  video: { open: false, kind: null, token: null, url: null, label: '', time: 0, duration: 0 },
};

/* ---------------------------------------------------------------- boot */

export async function boot() {
  const data = await api.boards();
  takeBoards(data);
  state.settings = data.settings || {};
  state.ready = true;
  bus.emit('boards');
  return state;
}

export async function refreshBoards() {
  takeBoards(await api.boards());
  bus.emit('boards');
}

/** the synced worker also tells us who we are and whether we're an admin.
 *  the desktop server and the local vault send neither, so both stay falsy. */
function takeBoards(data) {
  state.boards = data.boards || [];
  if (data.user) state.user = data.user;
  state.admin = !!data.admin;
}

/** boards belonging to somebody else — only ever non-empty for an admin */
export const isForeign = (meta) => meta.mine === false;

export function ownerCounts() {
  const counts = new Map();
  for (const b of state.boards) counts.set(b.owner || '', (counts.get(b.owner || '') || 0) + 1);
  counts.delete('');
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/* ---------------------------------------------------------------- undo */

const undoStack = [];
const redoStack = [];
const UNDO_MAX = 160;
let coalesceKey = null;
let coalesceAt = 0;

const cloneDoc = (doc) => JSON.parse(JSON.stringify(doc));

/**
 * every change goes through here so undo, autosave and the dirty light
 * behave identically whether you typed a word or dragged a card.
 * pass `coalesce` to fold rapid changes (typing) into one undo step.
 */
export function commit(label, mutate, opts = {}) {
  if (!state.board) return;
  const now = Date.now();
  const key = opts.coalesce || null;
  const merge = key !== null && key === coalesceKey && now - coalesceAt < 1400;

  if (!merge) {
    undoStack.push({ label, doc: cloneDoc(state.board) });
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  coalesceKey = key;
  coalesceAt = now;

  mutate(state.board);
  state.board.updated = now;
  scheduleSave();
  bus.emit('mutate', { label });
  return state.board;
}

/** use when a change shouldn't be undoable (viewport, ui prefs stored in the doc) */
export function quietly(mutate) {
  if (!state.board) return;
  mutate(state.board);
  scheduleSave();
}

export function undo() { return step(undoStack, redoStack, 'undo'); }
export function redo() { return step(redoStack, undoStack, 'redo'); }

function step(from, to, kind) {
  if (!from.length || !state.board) return false;
  const entry = from.pop();
  to.push({ label: entry.label, doc: cloneDoc(state.board) });
  state.board = entry.doc;
  coalesceKey = null;
  if (state.cardId && !state.board.cards[state.cardId]) state.cardId = state.board.rootId;
  scheduleSave();
  bus.emit('replace', { kind, label: entry.label });
  return entry.label;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/* ---------------------------------------------------------------- saving */

let saveTimer = null;
let saving = false;
let again = false;

export function scheduleSave() {
  setStatus('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, state.settings.autosaveMs || 400);
}

export async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.board) return;
  if (saving) { again = true; return; }
  saving = true;
  setStatus('saving');
  try {
    const res = await api.saveBoard(state.board.id, state.board);
    if (res.meta) {
      const i = state.boards.findIndex((b) => b.id === res.meta.id);
      if (i >= 0) state.boards[i] = res.meta; else state.boards.unshift(res.meta);
      bus.emit('boards');
    }
    setStatus('saved');
  } catch (err) {
    console.error('save failed', err);
    setStatus('error');
  } finally {
    saving = false;
    if (again) { again = false; scheduleSave(); }
  }
}

function setStatus(status) {
  state.save.status = status;
  if (status === 'saved') state.save.at = Date.now();
  bus.emit('save', state.save);
}

window.addEventListener('beforeunload', () => {
  if (state.save.status !== 'saved' && state.board) {
    navigator.sendBeacon?.(`/api/board/${state.board.id}`,
      new Blob([JSON.stringify(state.board)], { type: 'application/json' }));
  }
});

/* ---------------------------------------------------------------- boards */

export async function openBoard(id) {
  const doc = await api.board(id);
  state.board = doc;
  state.cardId = doc.openCardId && doc.cards[doc.openCardId] ? doc.openCardId : doc.rootId;
  undoStack.length = redoStack.length = 0;
  coalesceKey = null;
  setStatus('saved');
  bus.emit('board:open', doc);
  return doc;
}

export function closeBoard() {
  state.board = null;
  state.cardId = null;
  undoStack.length = redoStack.length = 0;
}

export async function createBoard(title) {
  const res = await api.createBoard(title);
  await refreshBoards();
  return res.board;
}

export async function deleteBoard(id) {
  await api.deleteBoard(id);
  if (state.board?.id === id) closeBoard();
  await refreshBoards();
}

/* ---------------------------------------------------------------- cards */

export const card = (id) => state.board?.cards?.[id] || null;
export const rootCard = () => card(state.board?.rootId);
export const openCard = () => card(state.cardId);

export function childrenOf(id) {
  const parent = card(id);
  if (!parent) return [];
  return (parent.children || []).map(card).filter(Boolean);
}

export function pathTo(id) {
  const out = [];
  let cur = card(id);
  let guard = 0;
  while (cur && guard++ < 64) { out.unshift(cur); cur = cur.parent ? card(cur.parent) : null; }
  return out;
}

export function newBlock(type = 'p', extra = {}) {
  return { id: uid('b'), type, html: '', ...extra };
}

export function makeCard(parentId, patch = {}) {
  const id = uid('c');
  const now = Date.now();
  const parent = card(parentId);
  const sibs = childrenOf(parentId);
  const doc = {
    id,
    parent: parentId,
    x: patch.x ?? (sibs.length % 3) * 300 + 40,
    y: patch.y ?? Math.floor(sibs.length / 3) * 230 + 40,
    w: patch.w ?? 260,
    h: patch.h ?? 180,
    title: patch.title ?? '',
    tags: patch.tags ?? [],
    severity: patch.severity ?? 0,
    t: patch.t ?? null,
    created: now,
    updated: now,
    blocks: patch.blocks ?? [newBlock('p')],
    free: [],
    children: [],
  };
  commit('new card', (b) => {
    b.cards[id] = doc;
    if (parent) (b.cards[parentId].children ||= []).push(id);
  });
  return doc;
}

export function deleteCard(id) {
  const target = card(id);
  if (!target || !target.parent) return;
  const doomed = [];
  (function walk(cid) { doomed.push(cid); for (const kid of card(cid)?.children || []) walk(kid); })(id);
  commit('delete card', (b) => {
    for (const cid of doomed) delete b.cards[cid];
    const parent = b.cards[target.parent];
    if (parent) parent.children = (parent.children || []).filter((c) => c !== id);
    b.links = (b.links || []).filter((l) => !doomed.includes(l.from) && !doomed.includes(l.to));
  });
  if (doomed.includes(state.cardId)) state.cardId = target.parent;
}

/** move a card under a new parent, keeping its subtree */
export function reparentCard(id, newParentId, pos = {}) {
  if (id === newParentId) return;
  const moving = card(id);
  if (!moving || !newParentId) return;
  for (const anc of pathTo(newParentId)) if (anc.id === id) return;   // no loops
  commit('move card', (b) => {
    const oldParent = b.cards[moving.parent];
    if (oldParent) oldParent.children = (oldParent.children || []).filter((c) => c !== id);
    b.cards[id].parent = newParentId;
    if (pos.x !== undefined) b.cards[id].x = pos.x;
    if (pos.y !== undefined) b.cards[id].y = pos.y;
    (b.cards[newParentId].children ||= []).push(id);
  });
}

/* ---------------------------------------------------------------- titles + tags */

export function cardTitle(c) {
  if (!c) return '';
  if (c.title?.trim()) return c.title.trim();
  for (const block of c.blocks || []) {
    const text = stripHtml(block.html).trim();
    if (text) return text.length > 60 ? text.slice(0, 60) + '…' : text;
  }
  return 'untitled';
}

const TAG_RE = /(^|[\s(>])#([a-z0-9][a-z0-9_-]{0,28})/gi;

export function tagsInCard(c) {
  const found = new Set(c.tags || []);
  for (const block of c.blocks || []) {
    const text = stripHtml(block.html);
    for (const m of text.matchAll(TAG_RE)) found.add(m[2].toLowerCase());
    for (const pin of block.pins || []) for (const m of String(pin.text || '').matchAll(TAG_RE)) found.add(m[2].toLowerCase());
  }
  for (const box of c.free || []) for (const m of stripHtml(box.html).matchAll(TAG_RE)) found.add(m[2].toLowerCase());
  return [...found];
}

/** keep card.tags in step with what's written inside it */
export function syncTags(cardId) {
  const c = card(cardId);
  if (!c) return;
  const next = tagsInCard(c);
  const same = next.length === (c.tags || []).length && next.every((t) => c.tags.includes(t));
  if (!same) quietly((b) => { b.cards[cardId].tags = next; });
}

export function allTags() {
  const counts = new Map();
  for (const c of Object.values(state.board?.cards || {})) {
    for (const tag of c.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function matchesFilter(c) {
  const { tags, sev } = state.filter;
  if (!tags.size && sev === null) return true;
  if (sev !== null && (c.severity || 0) !== sev) return false;
  if (tags.size && ![...tags].every((t) => (c.tags || []).includes(t))) return false;
  return true;
}

export const filterActive = () => state.filter.tags.size > 0 || state.filter.sev !== null;

/* ---------------------------------------------------------------- settings */

export const saveSettings = debounce(async (patch) => {
  Object.assign(state.settings, patch);
  try { await api.saveSettings(patch); } catch (e) { console.warn('settings save failed', e); }
  bus.emit('settings', state.settings);
}, 180);

export function setSetting(key, value) {
  state.settings[key] = value;
  bus.emit('settings', state.settings);
  saveSettings({ [key]: value });
}
