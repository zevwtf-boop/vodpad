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
export let isStatic = false;

export async function chooseBackend() {
  try {
    const res = await fetch('api/ping', { cache: 'no-store' });
    if (res.ok) { api = serverApi; isStatic = false; return 'server'; }
  } catch { /* no server: hosted build */ }
  const vault = await import('./vault.js');
  api = vault.localApi;
  isStatic = true;
  return 'static';
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
