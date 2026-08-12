/* every call to the local server lives here. */

async function req(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const ctype = res.headers.get('content-type') || '';
  const payload = ctype.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((payload && payload.error) || `${res.status} ${res.statusText}`);
  return payload;
}

const serverApi = {
  ping:         ()             => req('GET', '/api/ping'),
  boards:       ()             => req('GET', '/api/boards'),
  createBoard:  (title)        => req('POST', '/api/boards', { title }),
  board:        (id)           => req('GET', `/api/board/${id}`),
  saveBoard:    (id, doc)      => req('POST', `/api/board/${id}`, doc),
  deleteBoard:  (id)           => req('DELETE', `/api/board/${id}`),
  settings:     ()             => req('GET', '/api/settings'),
  saveSettings: (patch)        => req('POST', '/api/settings', patch),
  videos:       ()             => req('GET', '/api/videos'),
  reveal:       (what, board)  => req('POST', '/api/reveal', { what, board }),
  quit:         ()             => req('POST', '/api/quit'),
  upload:       (boardId, blob, ext = 'png') =>
                   req('POST', `/api/media/${boardId}`, blob, { 'X-Ext': ext, 'Content-Type': 'application/octet-stream' }),
};

/* ------------------------------------------------------------------
   two backends, one interface.

   run from vodpad.cmd and there's a local python server behind /api.
   run from github pages and there isn't — so everything falls back to the
   encrypted in-browser vault instead. picked once, at boot.
   ------------------------------------------------------------------ */

export let api = serverApi;
export let isStatic = false;      // no local python server behind us
export let mode = 'server';       // server | cloud | vault

export async function chooseBackend() {
  // 1. the desktop app: a python server is right there
  try {
    const res = await fetch('api/ping', { cache: 'no-store' });
    if (res.ok) { api = serverApi; isStatic = false; mode = 'server'; return mode; }
  } catch { /* hosted build, keep looking */ }

  isStatic = true;

  // 2. a hosted build pointed at a cloudflare worker: real accounts, synced
  let config = null;
  try { config = await (await fetch('config.json', { cache: 'no-store' })).json(); } catch { /* optional */ }
  if (config && config.api) {
    const cloud = await import('./cloud.js?v=440f02a293');
    cloud.configure(config.api);
    api = cloud.cloudApi;
    registerStaticMedia(cloud.cloudMediaUrl);
    mode = 'cloud';
    return mode;
  }

  // 3. otherwise everything stays in this browser, encrypted
  const vault = await import('./vault.js?v=440f02a293');
  api = vault.localApi;
  registerStaticMedia(vault.localMediaUrl);
  mode = 'vault';
  return mode;
}

/* ---- one door, whichever backend is behind it ---- */

export async function alreadySignedIn() {
  if (mode !== 'cloud') return false;
  const cloud = await import('./cloud.js?v=440f02a293');
  return cloud.resume();
}

export async function signIn(name, password) {
  if (mode === 'cloud') {
    const cloud = await import('./cloud.js?v=440f02a293');
    await cloud.login(name, password);
    return cloud.cloudUser();
  }
  const vault = await import('./vault.js?v=440f02a293');
  return (await vault.unlock(name, password)) ? vault.currentUser() : null;
}

export async function signOut() {
  if (mode === 'cloud') (await import('./cloud.js?v=440f02a293')).logout();
  else (await import('./vault.js?v=440f02a293')).lock();
  location.reload();
}

export async function whoAmI() {
  if (mode === 'cloud') return (await import('./cloud.js?v=440f02a293')).cloudUser();
  if (mode === 'vault') return (await import('./vault.js?v=440f02a293')).currentUser();
  return null;
}

/** media path stored in a board ("media/ab12.png") -> a url the browser can load */
export function mediaUrl(boardId, src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (isStatic) return staticMedia(src);
  return src.startsWith('/') ? src : `/m/${boardId}/${src.replace(/^media\//, '')}`;
}

let staticMediaFn = () => '';
export function registerStaticMedia(fn) { staticMediaFn = fn; }
const staticMedia = (src) => staticMediaFn(src);

export const videoUrl = (token) => (isStatic ? token : `/v/${token}`);
