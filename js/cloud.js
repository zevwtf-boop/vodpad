/* the synced backend: talks to your cloudflare worker.

   the slow half of the password check happens here, in the browser —
   600k rounds of pbkdf2 against a salt the worker hands out — and only the
   derived key crosses the wire. the worker stores a sha-256 of that key, so
   what's in the database can't be walked back to a password.
*/

import { mediaNamesOf } from './api.js?v=d258d51ea6';

const KEY_TOKEN = 'vodpad:token';
const KEY_USER = 'vodpad:user';
const MAX_UPLOAD = 1_300_000;          // keep under the worker's limit
const CACHED_BOARDS = 6;               // how many boards keep their blob urls alive

let base = '';
let token = localStorage.getItem(KEY_TOKEN) || null;
let user = localStorage.getItem(KEY_USER) || null;

/** boardId -> Map(src -> blob url). one cache per board, oldest board evicted
 *  first, so reading somebody else's session for the drill list can no longer
 *  revoke the pictures on the page you have open. */
const media = new Map();

export const cloudUser = () => user;
export const cloudBase = () => base;
export function configure(url) { base = String(url || '').replace(/\/+$/, ''); }

/* ---------------------------------------------------------------- transport */

async function call(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, opts);
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('json') ? await res.json() : await res.text();

  if (res.status === 401 && !path.startsWith('/login')) {
    signedOut();
    throw new Error('your session expired — sign in again');
  }
  if (!res.ok) throw new Error((payload && payload.error) || `${res.status} ${res.statusText}`);
  return payload;
}

function signedOut() {
  token = null;
  user = null;
  localStorage.removeItem(KEY_TOKEN);
  localStorage.removeItem(KEY_USER);
  forgetAllMedia();
}

/* ---------------------------------------------------------------- sign in */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const ITERATIONS = 600000;

/** the expensive half of the handshake. 600k rounds is deliberately slow —
 *  it is what makes a stolen database useless — so it runs here, not in the
 *  worker, which gets about 10ms of cpu per request. */
async function derive(password, saltB64, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations, hash: 'SHA-256' },
    material, 256,
  );
  return b64(bits);
}

function took(res) {
  token = res.token;
  user = res.user;
  localStorage.setItem(KEY_TOKEN, token);
  localStorage.setItem(KEY_USER, user);
  return user;
}

export async function login(name, password) {
  const start = await call('POST', '/login/start', { name });
  const proof = await derive(password, start.salt, start.iterations || ITERATIONS);
  return took(await call('POST', '/login/finish', { name, proof }));
}

/** live "is this name free / is this code good" for the signup form */
export const checkSignup = (name, code) => call('POST', '/signup/check', { name, code });

/** make the account. the browser mints its own salt and derives against it, so
 *  the password never leaves this machine — same shape as login, in reverse. */
export async function signup(name, code, password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const proof = await derive(password, salt);
  return took(await call('POST', '/signup', { name, code, salt, proof }));
}

/** a reset code re-keys one account. nobody can look a password up, so this is
 *  the whole recovery story — and it signs you straight back in afterwards. */
export async function resetPassword(code, password) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const proof = await derive(password, salt);
  return took(await call('POST', '/signup/reset', { code, salt, proof }));
}

export async function logout() {
  try { await call('POST', '/logout'); } catch { /* the token dies either way */ }
  signedOut();
}

/** true when the stored token still opens the door */
export async function resume() {
  if (!token) return false;
  try { await call('GET', '/api/boards'); return true; } catch { return false; }
}

/* ---------------------------------------------------------------- admin */

export const adminApi = {
  accounts: () => call('GET', '/api/admin/accounts'),
  patchAccount: (name, patch) => call('POST', `/api/admin/account/${encodeURIComponent(name)}`, patch),
  deleteAccount: (name) => call('DELETE', `/api/admin/account/${encodeURIComponent(name)}`),
  makeInvite: (opts) => call('POST', '/api/admin/invites', opts),
  patchInvite: (code, patch) => call('POST', `/api/admin/invite/${encodeURIComponent(code)}`, patch),
  dropInvite: (code) => call('DELETE', `/api/admin/invite/${encodeURIComponent(code)}`),
};

/* ---------------------------------------------------------------- pictures */

/** the cache for one board, moved to the front of the eviction queue */
function shelf(boardId) {
  const existing = media.get(boardId);
  if (existing) {                       // re-insert so it counts as recently used
    media.delete(boardId);
    media.set(boardId, existing);
    return existing;
  }
  const fresh = new Map();
  media.set(boardId, fresh);
  while (media.size > CACHED_BOARDS) {
    const oldest = media.keys().next().value;
    forgetMedia(oldest);
  }
  return fresh;
}

export function forgetMedia(boardId) {
  const shelfFor = media.get(boardId);
  if (!shelfFor) return;
  for (const url of shelfFor.values()) URL.revokeObjectURL(url);
  media.delete(boardId);
}

function forgetAllMedia() {
  for (const id of [...media.keys()]) forgetMedia(id);
  for (const url of thumbs.values()) URL.revokeObjectURL(url);
  thumbs.clear();
}

async function fetchOne(boardId, name) {
  const res = await fetch(`${base}/api/media/${boardId}/${name}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

async function loadMedia(boardId, doc) {
  const into = shelf(boardId);
  await Promise.all(mediaNamesOf(doc).map(async (name) => {
    if (into.has(`media/${name}`)) return;
    try {
      const url = await fetchOne(boardId, name);
      if (url) into.set(`media/${name}`, url);
    } catch { /* one missing picture shouldn't stop the page */ }
  }));
}

/* dashboard tiles are their own small, long-lived cache rather than part of the
   per-board shelves above. warming twenty tiles would otherwise create twenty
   shelves and evict the session you actually have open. */
const thumbs = new Map();
const THUMB_CACHE = 60;

/** just the one picture a dashboard card shows, without pulling the session.
 *  the grid used to draw empty tiles on the hosted build because nothing had
 *  populated the cache yet. */
export async function warmThumb(boardId, src) {
  if (!src || !token) return '';
  const key = `${boardId}/${src.startsWith('media/') ? src : `media/${src}`}`;
  if (thumbs.has(key)) return thumbs.get(key);
  try {
    const url = await fetchOne(boardId, key.split('/media/')[1]);
    if (!url) return '';
    thumbs.set(key, url);
    while (thumbs.size > THUMB_CACHE) {
      const oldest = thumbs.keys().next().value;
      URL.revokeObjectURL(thumbs.get(oldest));
      thumbs.delete(oldest);
    }
    return url;
  } catch { return ''; }
}

export function cloudMediaUrl(boardId, src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  const key = src.startsWith('media/') ? src : `media/${src}`;
  return media.get(boardId)?.get(key) || thumbs.get(`${boardId}/${key}`) || '';
}

/** big pastes get re-encoded rather than rejected */
async function fitForUpload(blob) {
  if (blob.size <= MAX_UPLOAD) return { blob, ext: extFor(blob.type) };
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.9, 0.8, 0.68, 0.55]) {
    const webp = await new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
    if (webp && webp.size <= MAX_UPLOAD) return { blob: webp, ext: 'webp' };
  }
  const last = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.4));
  return { blob: last || blob, ext: 'webp' };
}

const extFor = (type = '') => (type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'png');

/* ---------------------------------------------------------------- the adapter */

export const cloudApi = {
  ping: () => call('GET', '/api/ping'),
  boards: () => call('GET', '/api/boards'),
  createBoard: (title) => call('POST', '/api/boards', { title }),

  async board(id) {
    const doc = await call('GET', `/api/board/${id}`);
    await loadMedia(id, doc);
    return doc;
  },

  saveBoard: (id, doc) => call('POST', `/api/board/${id}`, doc),

  deleteBoard(id) {
    forgetMedia(id);
    return call('DELETE', `/api/board/${id}`);
  },

  /** hand the worker the pictures still in the document; it drops the rest.
   *  deleting an image block used to leave its row in d1 forever, base64'd at
   *  133% of the original, against a free-tier size cap. */
  gc: (id, doc) => call('POST', `/api/board/${id}/gc`, { keep: mediaNamesOf(doc) }),
  history: (id) => call('GET', `/api/board/${id}/history`),
  version: (id, stamp) => call('GET', `/api/board/${id}/history/${stamp}`),
  warmThumb,
  setShared: (id, shared) => call('POST', `/api/board/${id}/share`, { shared }),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (patch) => call('POST', '/api/settings', patch),
  videos: async () => ({ roots: [], files: [], local: true }),
  // no disk to cache the island on, so point straight at the api and let the
  // browser's http cache carry it. the worker never proxies this.
  lootmap: async () => (await import('./api.js?v=d258d51ea6')).fetchIslandDirect(),
  reveal: async () => ({ ok: false }),
  quit: async () => ({ ok: false }),

  async upload(boardId, blob) {
    const fitted = await fitForUpload(blob);
    const res = await call('POST', `/api/media/${boardId}`, await fitted.blob.arrayBuffer(), {
      'X-Ext': fitted.ext, 'Content-Type': 'application/octet-stream',
    });
    shelf(boardId).set(res.src, URL.createObjectURL(fitted.blob));
    return res;
  },
};
