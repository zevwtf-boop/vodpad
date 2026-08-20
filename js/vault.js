/* the web build's storage: everything in this browser, everything encrypted.

   there is no server on github pages, so notes and screenshots live in
   indexeddb — sealed with aes-gcm under a key derived from your password
   (pbkdf2-sha256, 600k rounds). the site itself only ever ships a salt and a
   sealed sentinel per user, never the password and never a reversible copy of
   anything you write.

   be clear-eyed about what this is: it stops anyone who opens the page (or
   digs through the browser's storage) from reading your notes. it is not a
   sync service and it is not protection against someone who has already
   installed something on your machine.
*/

import { mediaNamesOf } from './api.js?v=d258d51ea6';

const DB_NAME = 'vodpad-web';
const STORE = 'kv';
const ITERATIONS = 600000;

/* same starting point as the desktop build */
const DEFAULT_SETTINGS = {
  theme: 'graphite', accent: '', font: 'sans', textSize: 16, lineHeight: 1.7,
  pageWidth: 72, density: 'comfortable', radius: 14, motion: 'full', motionSpeed: 1,
  spellcheck: true, markdownShortcuts: true, autosaveMs: 400,
  gridSnap: true, snapSize: 8, lodThreshold: 0.42, sidebar: true, focusMode: false,
};

const CACHED_BOARDS = 6;   // how many boards keep their blob urls alive at once

let users = null;          // from users.json
let who = null;            // logged-in username
let key = null;            // aes-gcm CryptoKey, memory only
let db = null;

/** boardId -> Map("media/xyz.png" -> object url). one shelf per board and the
 *  oldest board evicted first, so reading every session to build the drill list
 *  no longer revokes the pictures on the page you have open. */
const media = new Map();

export const currentUser = () => who;
export const unlocked = () => !!key;

/* ---------------------------------------------------------------- bytes */

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------------------------------------------------------- crypto */

async function deriveKey(password, saltB64) {
  const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv: b64(iv), ct: b64(ct) };
}

async function unseal(rec, withKey = key) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(rec.iv) }, withKey, unb64(rec.ct));
  return new Uint8Array(plain);
}

const sealJson = (obj) => seal(enc.encode(JSON.stringify(obj)));
const unsealJson = async (rec) => JSON.parse(dec.decode(await unseal(rec)));

/* ---------------------------------------------------------------- indexeddb */

function openDb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'k' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(mode = 'readonly') {
  return openDb().then((d) => d.transaction(STORE, mode).objectStore(STORE));
}

async function put(k, value) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ k, v: value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function get(k) {
  const store = await tx();
  return new Promise((resolve, reject) => {
    const req = store.get(k);
    req.onsuccess = () => resolve(req.result?.v ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function del(k) {
  const store = await tx('readwrite');
  return new Promise((resolve) => { store.delete(k).onsuccess = () => resolve(); });
}

async function keysWith(prefix) {
  const store = await tx();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      if (String(cur.key).startsWith(prefix)) out.push(String(cur.key));
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

const mine = (suffix) => `${who}/${suffix}`;

/* ---------------------------------------------------------------- accounts */

export async function loadUsers() {
  if (users) return users;
  const res = await fetch('users.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('users.json is missing from the site');
  users = await res.json();
  return users;
}

export const userNames = () => (users?.users || []).map((u) => u.name);

/** returns true when the password is right; derives the data key as a side effect */
export async function unlock(name, password) {
  await loadUsers();
  const user = (users.users || []).find((u) => u.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!user) return false;
  const candidate = await deriveKey(password, user.salt);
  try {
    const proof = await unseal(user.check, candidate);
    if (dec.decode(proof) !== 'vodpad') return false;
  } catch {
    return false;                       // wrong password: the tag fails to verify
  }
  key = candidate;
  who = user.name;
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  return true;
}

export function lock() {
  key = null;
  who = null;
  for (const id of [...media.keys()]) forgetMedia(id);
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
}

/* ---------------------------------------------------------------- picture cache */

function shelf(boardId) {
  const existing = media.get(boardId);
  if (existing) {                       // re-insert so it counts as recently used
    media.delete(boardId);
    media.set(boardId, existing);
    return existing;
  }
  const fresh = new Map();
  media.set(boardId, fresh);
  while (media.size > CACHED_BOARDS) forgetMedia(media.keys().next().value);
  return fresh;
}

function forgetMedia(boardId) {
  const shelfFor = media.get(boardId);
  if (!shelfFor) return;
  for (const url of shelfFor.values()) URL.revokeObjectURL(url);
  media.delete(boardId);
}

/* ---------------------------------------------------------------- meta */

function boardMeta(id, doc) {
  const cards = doc.cards || {};
  let notes = 0, shots = 0, thumb = null;
  const tags = {};
  const severities = [0, 0, 0, 0];
  for (const c of Object.values(cards)) {
    const sev = Number(c.severity || 0);
    if (sev >= 0 && sev < 4) severities[sev]++;
    for (const tag of c.tags || []) tags[tag] = (tags[tag] || 0) + 1;
    for (const block of c.blocks || []) {
      if (block.type === 'image') { shots++; if (!thumb && block.src) thumb = block.src; }
      else if ((block.html || '').trim()) notes++;
    }
    // a session made entirely on the whiteboard still has notes and pictures
    for (const shape of c.shapes || []) {
      const real = shape.src && !/^(data:|https?:)/.test(shape.src);
      if (real) { shots++; if (!thumb) thumb = shape.src; }
      else if ((shape.html || '').trim()) notes++;
    }
  }
  return {
    id, title: doc.title || id,
    created: doc.created || 0, updated: doc.updated || 0,
    starred: !!doc.starred,
    cardCount: Object.keys(cards).length,
    noteCount: notes, shotCount: shots,
    tags, severities, thumb,
    video: doc.video?.label || null,
  };
}

function blankBoard(id, title) {
  const stamp = Date.now();
  return {
    id, title, created: stamp, updated: stamp, starred: false,
    view: { x: 0, y: 0, z: 1 }, rootId: 'c-root', openCardId: 'c-root',
    video: null, tagDefs: {}, links: [],
    cards: {
      'c-root': {
        id: 'c-root', parent: null, x: 0, y: 0, w: 520, h: 340,
        title, tags: [], severity: 0, t: null, created: stamp, updated: stamp,
        blocks: [], free: [], children: [],
      },
    },
  };
}

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

/* ---------------------------------------------------------------- history

   the browser-only twin of the desktop build's .history folder. snapshots are
   sealed like everything else, throttled so typing does not mint one per
   keystroke, and capped so indexeddb's quota stays somebody else's problem. */

const HISTORY_KEEP = 12;
const HISTORY_EVERY = 5 * 60 * 1000;
const lastSnap = new Map();

async function snapshot(boardId) {
  const now = Date.now();
  if (now - (lastSnap.get(boardId) || 0) < HISTORY_EVERY) return;
  lastSnap.set(boardId, now);
  try {
    const current = await get(mine(`board:${boardId}`));
    if (!current) return;                       // nothing to snapshot yet
    await put(mine(`hist:${boardId}:${now}`), current);
    const keys = (await keysWith(`${who}/hist:${boardId}:`))
      .sort((a, b) => Number(b.split(':').pop()) - Number(a.split(':').pop()));
    for (const stale of keys.slice(HISTORY_KEEP)) await del(stale);
  } catch { /* a snapshot is a nicety — never fail the save over one */ }
}

/* ---------------------------------------------------------------- the adapter */

export const localApi = {
  ping: async () => ({ ok: true, local: true }),

  async boards() {
    const keys = await keysWith(`${who}/board:`);
    const boards = [];
    for (const k of keys) {
      try { boards.push(boardMeta(k.split('board:')[1], await unsealJson(await get(k)))); } catch { /* skip */ }
    }
    boards.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const stored = await get(mine('settings'));
    const settings = stored ? await unsealJson(stored) : {};
    return { boards, settings };
  },

  async createBoard(title) {
    const name = (title || '').trim() || new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' session';
    let id = slug(name), n = 2;
    while (await get(mine(`board:${id}`))) id = `${slug(name)}-${n++}`;
    const doc = blankBoard(id, name);
    await put(mine(`board:${id}`), await sealJson(doc));
    return { ok: true, board: doc, meta: boardMeta(id, doc) };
  },

  async board(id) {
    const rec = await get(mine(`board:${id}`));
    if (!rec) throw new Error('no such board');
    const doc = await unsealJson(rec);
    await loadMediaFor(id);
    return doc;
  },

  async saveBoard(id, doc) {
    // snapshot what is being replaced, before replacing it
    await snapshot(id);
    doc.updated = Date.now();
    await put(mine(`board:${id}`), await sealJson(doc));
    return { ok: true, updated: doc.updated, meta: boardMeta(id, doc) };
  },

  async history(id) {
    const versions = [];
    for (const k of await keysWith(`${who}/hist:${id}:`)) {
      try {
        const doc = await unsealJson(await get(k));
        const meta = boardMeta(id, doc);
        versions.push({
          stamp: Number(k.split(`hist:${id}:`)[1]),
          bytes: 0, title: meta.title,
          cards: meta.cardCount, notes: meta.noteCount, shots: meta.shotCount,
        });
      } catch { /* skip an unreadable snapshot */ }
    }
    versions.sort((a, b) => b.stamp - a.stamp);
    return { versions };
  },

  async version(id, stamp) {
    const rec = await get(mine(`hist:${id}:${stamp}`));
    if (!rec) throw new Error('no such version');
    return unsealJson(rec);
  },

  async deleteBoard(id) {
    await del(mine(`board:${id}`));
    for (const k of await keysWith(`${who}/media:${id}:`)) await del(k);
    for (const k of await keysWith(`${who}/hist:${id}:`)) await del(k);
    forgetMedia(id);
    return { ok: true };
  },

  /** drop the sealed blobs for pictures the document no longer references.
   *  indexeddb has a quota like anything else, and a deleted screenshot used to
   *  sit in it forever. */
  async gc(id, doc) {
    const live = new Set(mediaNamesOf(doc));
    let freed = 0, bytes = 0;
    for (const k of await keysWith(`${who}/media:${id}:`)) {
      const name = k.split(`media:${id}:`)[1];
      if (live.has(name)) continue;
      const rec = await get(k);
      bytes += Math.round((rec?.ct?.length || 0) * 0.75);
      await del(k);
      freed++;
    }
    if (freed) forgetMedia(id);
    return { ok: true, freed, bytes };
  },

  warmThumb,

  async settings() {
    const rec = await get(mine('settings'));
    return { ...DEFAULT_SETTINGS, ...(rec ? await unsealJson(rec) : {}) };
  },

  async saveSettings(patch) {
    const current = await localApi.settings();
    const next = { ...current, ...patch };
    await put(mine('settings'), await sealJson(next));
    return next;
  },

  videos: async () => ({ roots: [], files: [], local: true }),
  // same as cloud: nothing local to cache into, so the api url goes straight
  // into the <img> and the browser cache does the work
  lootmap: async () => (await import('./api.js?v=d258d51ea6')).fetchIslandDirect(),
  reveal: async () => ({ ok: false }),
  quit: async () => ({ ok: false }),

  async upload(boardId, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = blob.type || 'image/png';
    const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'png';
    const name = `${(await sha256hex(bytes)).slice(0, 24)}.${ext}`;
    const src = `media/${name}`;
    await put(mine(`media:${boardId}:${name}`), { ...(await seal(bytes)), type });
    shelf(boardId).set(src, URL.createObjectURL(new Blob([bytes], { type })));
    return { ok: true, src, bytes: bytes.length };
  },
};

async function loadMediaFor(boardId) {
  const into = shelf(boardId);
  for (const k of await keysWith(`${who}/media:${boardId}:`)) {
    const name = k.split(`media:${boardId}:`)[1];
    if (into.has(`media/${name}`)) continue;
    try {
      const rec = await get(k);
      const bytes = await unseal(rec);
      into.set(`media/${name}`, URL.createObjectURL(new Blob([bytes], { type: rec.type || 'image/png' })));
    } catch { /* a corrupt blob shouldn't take the page down */ }
  }
}

/* dashboard tiles get their own small cache. warming twenty of them through the
   per-board shelves would create twenty shelves and evict the open session. */
const thumbs = new Map();
const THUMB_CACHE = 60;

/** one picture, for a dashboard tile, without unsealing the whole session */
async function warmThumb(boardId, src) {
  if (!who || !src) return '';
  const name = src.replace(/^media\//, '');
  const key2 = `${boardId}/${name}`;
  if (thumbs.has(key2)) return thumbs.get(key2);
  try {
    const rec = await get(mine(`media:${boardId}:${name}`));
    if (!rec) return '';
    const url = URL.createObjectURL(new Blob([await unseal(rec)], { type: rec.type || 'image/png' }));
    thumbs.set(key2, url);
    while (thumbs.size > THUMB_CACHE) {
      const oldest = thumbs.keys().next().value;
      URL.revokeObjectURL(thumbs.get(oldest));
      thumbs.delete(oldest);
    }
    return url;
  } catch { return ''; }
}

export function localMediaUrl(boardId, src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  const name = src.replace(/^media\//, '');
  return media.get(boardId)?.get(`media/${name}`) || thumbs.get(`${boardId}/${name}`) || '';
}

// hand the resolver to api.js so mediaUrl() stays synchronous everywhere else
import('./api.js?v=d258d51ea6').then((m) => m.registerStaticMedia(localMediaUrl));

/* ---------------------------------------------------------------- backups

   the notes live in one browser, so getting them out matters. the backup is
   the sealed records exactly as stored — it is useless to anyone without the
   password, and it restores into any browser you log into.
*/

export async function exportVault() {
  const out = { kind: 'vodpad-vault', user: who, exported: Date.now(), records: {} };
  for (const k of await keysWith(`${who}/`)) out.records[k] = await get(k);
  return out;
}

export async function importVault(file) {
  const data = JSON.parse(await file.text());
  if (data.kind !== 'vodpad-vault') throw new Error('that is not a vodpad backup');
  let n = 0;
  for (const [k, v] of Object.entries(data.records || {})) {
    const suffix = k.split('/').slice(1).join('/');
    await put(mine(suffix), v);
    n++;
  }
  return n;
}

export async function vaultSize() {
  const keys = await keysWith(`${who}/`);
  let bytes = 0;
  for (const k of keys) {
    const rec = await get(k);
    bytes += (rec?.ct?.length || 0) * 0.75;
  }
  return { records: keys.length, bytes: Math.round(bytes) };
}
