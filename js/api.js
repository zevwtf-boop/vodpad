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

/** every picture a document still points at, as bare filenames.
 *  all three backends need this to sweep up deleted screenshots. */
export function mediaNamesOf(doc) {
  const names = new Set();
  // a data: or http: src is a preset picture or a remote one — it is not a
  // file in this board's media folder, and adding it here would put a whole
  // svg in the keep-list and have the blob cache try to fetch it
  const keep = (src) => {
    if (!src || /^(data:|https?:|blob:)/.test(src)) return;
    names.add(String(src).replace(/^media\//, ''));
  };
  for (const card of Object.values(doc?.cards || {})) {
    for (const block of card.blocks || []) {
      if (block.type === 'image') keep(block.src);
    }
    // pictures dropped into a box on the whiteboard are media too — leaving
    // them out here would have the next gc delete the file under them
    for (const shape of card.shapes || []) keep(shape.src);
  }
  return [...names];
}

const serverApi = {
  ping:         ()             => req('GET', '/api/ping'),
  boards:       ()             => req('GET', '/api/boards'),
  createBoard:  (title)        => req('POST', '/api/boards', { title }),
  board:        (id)           => req('GET', `/api/board/${id}`),
  saveBoard:    (id, doc)      => req('POST', `/api/board/${id}`, doc),
  deleteBoard:  (id)           => req('DELETE', `/api/board/${id}`),
  gc:           (id, doc)      => req('POST', `/api/board/${id}/gc`, { keep: mediaNamesOf(doc) }),
  history:      (id)           => req('GET', `/api/board/${id}/history`),
  version:      (id, stamp)    => req('GET', `/api/board/${id}/history/${Math.floor(stamp / 1000)}`),
  // the desktop build serves pictures off disk by path, so nothing needs warming
  warmThumb:    async ()       => '',
  settings:     ()             => req('GET', '/api/settings'),
  saveSettings: (patch)        => req('POST', '/api/settings', patch),
  videos:       ()             => req('GET', '/api/videos'),
  lootmap:      ()             => req('GET', '/api/lootmap'),
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
    const cloud = await import('./cloud.js?v=13c601f470');
    cloud.configure(config.api);
    api = cloud.cloudApi;
    registerStaticMedia(cloud.cloudMediaUrl);
    mode = 'cloud';
    return mode;
  }

  // 3. otherwise everything stays in this browser, encrypted
  const vault = await import('./vault.js?v=13c601f470');
  api = vault.localApi;
  registerStaticMedia(vault.localMediaUrl);
  mode = 'vault';
  return mode;
}

/* ---- one door, whichever backend is behind it ---- */

export async function alreadySignedIn() {
  if (mode !== 'cloud') return false;
  const cloud = await import('./cloud.js?v=13c601f470');
  return cloud.resume();
}

export async function signIn(name, password) {
  if (mode === 'cloud') {
    const cloud = await import('./cloud.js?v=13c601f470');
    await cloud.login(name, password);
    return cloud.cloudUser();
  }
  const vault = await import('./vault.js?v=13c601f470');
  return (await vault.unlock(name, password)) ? vault.currentUser() : null;
}

export async function signOut() {
  if (mode === 'cloud') (await import('./cloud.js?v=13c601f470')).logout();
  else (await import('./vault.js?v=13c601f470')).lock();
  location.reload();
}

export async function whoAmI() {
  if (mode === 'cloud') return (await import('./cloud.js?v=13c601f470')).cloudUser();
  if (mode === 'vault') return (await import('./vault.js?v=13c601f470')).currentUser();
  return null;
}

/* ------------------------------------------------------------------
   making accounts.

   only the synced build can: an account is a row in the worker's database,
   and creating one needs an invite code an admin generated. the desktop build
   has no accounts at all, and the browser-only vault's accounts are baked into
   users.json at build time, so neither can grow one at runtime. both say so
   rather than showing a form that cannot work.
   ------------------------------------------------------------------ */

export const canSignUp = () => mode === 'cloud';

/** live "is that name free / is that code good", for the signup form */
export async function checkSignup(name, code) {
  if (mode !== 'cloud') return { name: { ok: false, why: '' }, code: { ok: false, why: '' } };
  return (await import('./cloud.js?v=13c601f470')).checkSignup(name, code);
}

export async function signUp(name, code, password) {
  if (mode !== 'cloud') throw new Error('this copy cannot make accounts');
  return (await import('./cloud.js?v=13c601f470')).signup(name, code, password);
}

export async function resetPassword(code, password) {
  if (mode !== 'cloud') throw new Error('this copy cannot reset passwords');
  return (await import('./cloud.js?v=13c601f470')).resetPassword(code, password);
}

/** the admin-only calls, or null when this build has no notion of accounts */
export async function adminApi() {
  if (mode !== 'cloud') return null;
  return (await import('./cloud.js?v=13c601f470')).adminApi;
}

/** media path stored in a board ("media/ab12.png") -> a url the browser can load.
 *
 *  boardId is threaded all the way through to the blob cache on purpose. it used
 *  to be dropped here, which forced cloud and vault mode to keep one global
 *  cache and wipe it on every board open — so building the drill list or the
 *  cross-session search (both of which read every board) blanked the pictures on
 *  the page you were actually looking at. */
export function mediaUrl(boardId, src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:)/.test(src)) return src;
  if (isStatic) return staticMedia(boardId, src);
  return src.startsWith('/') ? src : `/m/${boardId}/${src.replace(/^media\//, '')}`;
}

let staticMediaFn = () => '';
export function registerStaticMedia(fn) { staticMediaFn = fn; }
const staticMedia = (boardId, src) => staticMediaFn(boardId, src);

export const videoUrl = (token) => (isStatic ? token : `/v/${token}`);

/* ------------------------------------------------------------------
   the loot map's island picture.

   the markers themselves ship with the app (app/lootmap/), so every backend
   reads those from the same relative path and none of them needs a route for
   it. the island art is the part that changes each season, so it comes from
   fortnite-api.com — public, no key, permissive CORS, and it exists to be
   consumed. the desktop server caches it to disk so the app still works with
   no network; the hosted builds have nowhere to cache it, so they point the
   <img> straight at the api and let the browser's own http cache do the job.

   nothing here ever touches fortnite.gg. that is behind a bot challenge and is
   a deliberate once-a-season manual capture — see the lootmap-capture skill.
   ------------------------------------------------------------------ */

const ISLAND_API = 'https://fortnite-api.com/v1/map';
let islandCache = null;

export async function fetchIslandDirect() {
  if (islandCache && Date.now() - islandCache.fetched < 24 * 3600 * 1000) return islandCache;
  try {
    const doc = await (await fetch(ISLAND_API, { cache: 'no-store' })).json();
    const data = doc.data || {};
    islandCache = {
      ok: true,
      island: data.images?.blank || null,
      fetched: Date.now(),
      pois: (data.pois || [])
        .filter((p) => p.location && typeof p.location.x === 'number')
        .map((p) => ({ name: p.name, world: [p.location.x, p.location.y] })),
    };
    return islandCache;
  } catch (err) {
    // keep the last good copy rather than blanking the map on one bad request
    if (islandCache) return islandCache;
    return { ok: false, island: null, pois: [], error: String(err.message || err) };
  }
}
