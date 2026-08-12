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

const DB_NAME = 'vodpad-web';
const STORE = 'kv';
const ITERATIONS = 600000;

/* same starting point as the desktop build */
const DEFAULT_SETTINGS = {
  theme: 'ember', accent: '', font: 'sans', textSize: 16, lineHeight: 1.65,
  pageWidth: 76, density: 'comfortable', radius: 14, motion: 'full', motionSpeed: 1,
  spellcheck: true, markdownShortcuts: true, autosaveMs: 400,
  gridSnap: true, snapSize: 8, lodThreshold: 0.42, sidebar: true, focusMode: false,
};

let users = null;          // from users.json
let who = null;            // logged-in username
let key = null;            // aes-gcm CryptoKey, memory only
let db = null;
const mediaCache = new Map();   // "media/xyz.png" -> object url

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
  for (const url of mediaCache.values()) URL.revokeObjectURL(url);
  mediaCache.clear();
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
        blocks: [{ id: `b-${stamp}`, type: 'p', html: '' }], free: [], children: [],
      },
    },
  };
}

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

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
    doc.updated = Date.now();
    await put(mine(`board:${id}`), await sealJson(doc));
    return { ok: true, updated: doc.updated, meta: boardMeta(id, doc) };
  },

  async deleteBoard(id) {
    await del(mine(`board:${id}`));
    for (const k of await keysWith(`${who}/media:${id}:`)) await del(k);
    return { ok: true };
  },

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
  reveal: async () => ({ ok: false }),
  quit: async () => ({ ok: false }),

  async upload(boardId, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const type = blob.type || 'image/png';
    const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'png';
    const name = `${(await sha256hex(bytes)).slice(0, 24)}.${ext}`;
    const src = `media/${name}`;
    await put(mine(`media:${boardId}:${name}`), { ...(await seal(bytes)), type });
    mediaCache.set(src, URL.createObjectURL(new Blob([bytes], { type })));
    return { ok: true, src, bytes: bytes.length };
  },
};

async function loadMediaFor(boardId) {
  for (const url of mediaCache.values()) URL.revokeObjectURL(url);
  mediaCache.clear();
  for (const k of await keysWith(`${who}/media:${boardId}:`)) {
    try {
      const rec = await get(k);
      const bytes = await unseal(rec);
      const name = k.split(`media:${boardId}:`)[1];
      mediaCache.set(`media/${name}`, URL.createObjectURL(new Blob([bytes], { type: rec.type || 'image/png' })));
    } catch { /* a corrupt blob shouldn't take the page down */ }
  }
}

export function localMediaUrl(src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  return mediaCache.get(src.startsWith('media/') ? src : `media/${src}`) || '';
}

// hand the resolver to api.js so mediaUrl() stays synchronous everywhere else
import('./api.js').then((m) => m.registerStaticMedia(localMediaUrl));

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
