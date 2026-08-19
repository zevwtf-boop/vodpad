/* small helpers everything else leans on. no dependencies. */

/* ---------------------------------------------------------------- dom */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * h('div.card#main', {text, html, tip, on:{click}, style:{}, data:{}}, ...kids)
 */
export function h(spec, props = null, ...kids) {
  // second argument is only props when it's a plain object — anything else
  // (a node, a string, an array) is the first child
  if (props !== null && props !== undefined
      && (props.nodeType !== undefined || typeof props !== 'object' || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }

  let tag = 'div', cls = [], id = '';
  const m = String(spec).match(/^([a-zA-Z0-9-]*)((?:[.#][^.#]+)*)$/);
  if (m) {
    tag = m[1] || 'div';
    for (const bit of (m[2] || '').split(/(?=[.#])/)) {
      if (!bit) continue;
      if (bit[0] === '.') cls.push(bit.slice(1)); else id = bit.slice(1);
    }
  } else tag = spec;

  const el = document.createElement(tag);
  if (cls.length) el.className = cls.join(' ');
  if (id) el.id = id;

  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'tip') el.dataset.tip = v;
    // custom properties have to go through setProperty — Object.assign drops
    // any key starting with "--" without a word of complaint
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k in el && k !== 'list' && typeof v !== 'object') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }

  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function frag(...kids) {
  const f = document.createDocumentFragment();
  for (const k of kids.flat(4)) if (k) f.append(k.nodeType ? k : document.createTextNode(String(k)));
  return f;
}

export function on(el, ev, fn, opts) {
  el.addEventListener(ev, fn, opts);
  return () => el.removeEventListener(ev, fn, opts);
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/* ---------------------------------------------------------------- misc */

let seq = 0;
export const uid = (p = 'x') => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const lerp = (a, b, t) => a + (b - a) * t;

export function debounce(fn, ms = 200) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export function rafThrottle(fn) {
  let queued = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}

export function emitter() {
  const map = new Map();
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(fn);
      return () => map.get(name).delete(fn);
    },
    emit(name, payload) {
      for (const fn of map.get(name) || []) { try { fn(payload); } catch (e) { console.error(e); } }
      for (const fn of map.get('*') || []) { try { fn(name, payload); } catch (e) { console.error(e); } }
    },
  };
}

/* ---------------------------------------------------------------- format */

export function fmtClock(seconds) {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
           : `${m}:${String(sec).padStart(2, '0')}`;
}

export function parseClock(text) {
  const bits = String(text).trim().split(':').map(Number);
  if (bits.some(isNaN) || !bits.length) return null;
  return bits.reduce((acc, n) => acc * 60 + n, 0);
}

export function fmtRel(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function fmtDate(ms) {
  return new Date(ms || Date.now()).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtBytes(n) {
  if (!n) return '0 b';
  const units = ['b', 'kb', 'mb', 'gb'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/* ---------------------------------------------------------------- text */

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function stripHtml(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || '').replace(/ /g, ' ');
}

/** first meaningful line of a block list — used for titles and previews */
export function previewOf(blocks, max = 90) {
  for (const b of blocks || []) {
    if (b.type === 'image') continue;
    const t = stripHtml(b.html).trim();
    if (t) return t.length > max ? t.slice(0, max) + '…' : t;
  }
  return '';
}

/* ---------------------------------------------------------------- sanitising

   pasted html is untrusted and, from google docs, absolutely filthy.
   we keep a tiny semantic whitelist and translate inline styles that
   carry meaning (bold / italic / underline / strike) into real tags.
*/

const OK_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'CODE', 'A', 'MARK', 'SPAN', 'BR']);
const TAG_MAP = { STRIKE: 'S', DEL: 'S', STRONG: 'B', EM: 'I' };

export function sanitizeInline(html) {
  const host = document.createElement('div');
  host.innerHTML = String(html || '');
  walkClean(host);
  return host.innerHTML
    .replace(/<span>\s*<\/span>/g, '')
    .replace(/(&nbsp;| )/g, ' ')
    .trim();
}

function walkClean(node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1) { child.remove(); continue; }

    const el = /** @type {HTMLElement} */ (child);
    walkClean(el);

    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') { el.remove(); continue; }

    // pull meaning out of inline styles before we throw them away
    const style = el.getAttribute('style') || '';
    const wraps = [];
    if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(style)) wraps.push('b');
    if (/font-style\s*:\s*italic/i.test(style)) wraps.push('i');
    if (/text-decoration[^;]*underline/i.test(style)) wraps.push('u');
    if (/text-decoration[^;]*line-through/i.test(style)) wraps.push('s');

    let target;
    if (OK_TAGS.has(el.tagName)) {
      if (TAG_MAP[el.tagName]) {
        target = document.createElement(TAG_MAP[el.tagName].toLowerCase());
        while (el.firstChild) target.append(el.firstChild);
        el.replaceWith(target);
      } else {
        target = el;
      }
      const href = target.tagName === 'A' ? target.getAttribute('href') : null;
      const keep = {
        anchor: target.getAttribute('data-anchor'),
        hl: target.getAttribute('data-hl'),
        c: target.getAttribute('data-c'),
      };
      for (const attr of Array.from(target.attributes)) target.removeAttribute(attr.name);
      if (target.tagName === 'A') {
        if (href && /^(https?:|mailto:|#)/i.test(href)) {
          target.setAttribute('href', href);
          target.setAttribute('target', '_blank');
          target.setAttribute('rel', 'noreferrer');
        } else { unwrap(target); target = null; }
      }
      if (target) {
        if (keep.anchor) target.setAttribute('data-anchor', keep.anchor);
        if (keep.hl) target.setAttribute('data-hl', keep.hl);
        if (keep.c) target.setAttribute('data-c', keep.c);
      }
    } else {
      // disallowed tag: keep the words, drop the wrapper (via a scratch span)
      target = document.createElement('span');
      while (el.firstChild) target.append(el.firstChild);
      el.replaceWith(target);
    }

    if (target && wraps.length) {
      let inner = target;
      for (const tag of wraps) {
        if (inner.tagName.toLowerCase() === tag) continue;
        const w = document.createElement(tag);
        inner.replaceWith(w);
        w.append(inner);
        inner = w;
      }
    }
    if (target && target.tagName === 'SPAN' && target.attributes.length === 0) unwrap(target);
  }
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ---------------------------------------------------------------- search */

/** cheap subsequence fuzzy score; higher is better, 0 means no match */
export function fuzzy(query, text) {
  const q = query.toLowerCase().trim(), t = String(text || '').toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 1000 - t.indexOf(q);
  let qi = 0, score = 0, streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { qi++; streak++; score += 4 + streak; }
    else streak = 0;
  }
  return qi === q.length ? score : 0;
}

export function highlight(text, query) {
  const t = String(text || '');
  if (!query) return escapeHtml(t);
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return escapeHtml(t);
  return escapeHtml(t.slice(0, i)) + '<mark>' + escapeHtml(t.slice(i, i + query.length)) + '</mark>' + escapeHtml(t.slice(i + query.length));
}

/* ---------------------------------------------------------------- files */

export function download(filename, data, mime = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const isMac = navigator.platform.toLowerCase().includes('mac');
export const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);
