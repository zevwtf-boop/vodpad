/* the synced backend: talks to your cloudflare worker.

   the slow half of the password check happens here, in the browser —
   600k rounds of pbkdf2 against a salt the worker hands out — and only the
   derived key crosses the wire. the worker stores a sha-256 of that key, so
   what's in the database can't be walked back to a password.
*/

const KEY_TOKEN = 'vodpad:token';
const KEY_USER = 'vodpad:user';
const MAX_UPLOAD = 1_300_000;          // keep under the worker's limit

let base = '';
let token = localStorage.getItem(KEY_TOKEN) || null;
let user = localStorage.getItem(KEY_USER) || null;
const mediaCache = new Map();

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
}

/* ---------------------------------------------------------------- sign in */

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function login(name, password) {
  const start = await call('POST', '/login/start', { name });
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(start.salt), iterations: start.iterations || 600000, hash: 'SHA-256' },
    material, 256,
  );
  const res = await call('POST', '/login/finish', { name, proof: b64(bits) });
  token = res.token;
  user = res.user;
  localStorage.setItem(KEY_TOKEN, token);
  localStorage.setItem(KEY_USER, user);
  return user;
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

/* ---------------------------------------------------------------- pictures */

function mediaNames(doc) {
  const names = new Set();
  for (const card of Object.values(doc.cards || {})) {
    for (const block of card.blocks || []) {
      if (block.type === 'image' && block.src) names.add(String(block.src).replace(/^media\//, ''));
    }
  }
  return [...names];
}

async function loadMedia(boardId, doc) {
  for (const url of mediaCache.values()) URL.revokeObjectURL(url);
  mediaCache.clear();
  await Promise.all(mediaNames(doc).map(async (name) => {
    try {
      const res = await fetch(`${base}/api/media/${boardId}/${name}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      mediaCache.set(`media/${name}`, URL.createObjectURL(await res.blob()));
    } catch { /* one missing picture shouldn't stop the page */ }
  }));
}

export function cloudMediaUrl(src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  return mediaCache.get(src.startsWith('media/') ? src : `media/${src}`) || '';
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
  deleteBoard: (id) => call('DELETE', `/api/board/${id}`),
  setShared: (id, shared) => call('POST', `/api/board/${id}/share`, { shared }),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (patch) => call('POST', '/api/settings', patch),
  videos: async () => ({ roots: [], files: [], local: true }),
  reveal: async () => ({ ok: false }),
  quit: async () => ({ ok: false }),

  async upload(boardId, blob) {
    const fitted = await fitForUpload(blob);
    const res = await call('POST', `/api/media/${boardId}`, await fitted.blob.arrayBuffer(), {
      'X-Ext': fitted.ext, 'Content-Type': 'application/octet-stream',
    });
    mediaCache.set(res.src, URL.createObjectURL(fitted.blob));
    return res;
  },
};
