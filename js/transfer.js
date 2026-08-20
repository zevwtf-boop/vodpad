/* moving a session between places.

   a .vodpad file is one session, whole: the notes, the drawings, the pins, and
   every screenshot embedded inside it. it is plain json, so it imports into the
   desktop app, the browser-only site or the synced site — whichever you happen
   to be looking at — and it's how you hand a session to someone else when you
   aren't using sync.
*/

import { h, download, stripHtml } from './util.js?v=13c601f470';
import { api, mediaUrl, mode } from './api.js?v=13c601f470';
import { state, refreshBoards, cardTitle } from './store.js?v=13c601f470';
import { toast, openModal } from './ui.js?v=13c601f470';
import { icon } from './icons.js?v=13c601f470';

const KIND = 'vodpad-session';

/* ---------------------------------------------------------------- out */

function mediaNamesIn(doc) {
  const names = new Set();
  for (const card of Object.values(doc.cards || {})) {
    const real = (src) => src && !/^(data:|https?:|blob:)/.test(src);
    for (const block of card.blocks || []) {
      if (block.type === 'image' && real(block.src)) names.add(String(block.src));
    }
    // a preset picture is already inside the document as a data: url, so it
    // travels with the json and needs no bundling
    for (const shape of card.shapes || []) if (real(shape.src)) names.add(String(shape.src));
  }
  return [...names];
}

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
  fr.onerror = reject;
  fr.readAsDataURL(blob);
});

export async function exportSession(boardId, { quiet = false } = {}) {
  const id = boardId || state.board?.id;
  if (!id) return;
  const doc = state.board?.id === id ? JSON.parse(JSON.stringify(state.board)) : await api.board(id);

  const media = {};
  let skipped = 0;
  for (const src of mediaNamesIn(doc)) {
    const url = mediaUrl(id, src);
    if (!url) { skipped++; continue; }
    try {
      const blob = await (await fetch(url)).blob();
      media[src] = { mime: blob.type || 'image/png', data: await toBase64(blob) };
    } catch { skipped++; }
  }

  const bundle = {
    kind: KIND, version: 1,
    exported: Date.now(),
    from: document.body.dataset.user || 'desktop',
    title: doc.title || id,
    board: doc,
    media,
  };

  const name = `${(doc.title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session'}.vodpad`;
  download(name, JSON.stringify(bundle), 'application/json');
  if (!quiet) {
    const shots = Object.keys(media).length;
    toast(`${name} saved — ${shots} picture${shots === 1 ? '' : 's'} packed in${skipped ? `, ${skipped} could not be read` : ''}`,
      { kind: 'ok', ms: 4000 });
  }
  return bundle;
}

/* ---------------------------------------------------------------- in */

export function pickSessionFile() {
  const input = h('input', { type: 'file', accept: '.vodpad,application/json,.json', multiple: true, style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.remove();
    for (const file of files) {
      try { await importSessionFile(file); } catch (err) { toast(err.message || 'that file could not be read', { kind: 'error' }); }
    }
  });
  input.click();
}

export async function importSessionFile(file) {
  const bundle = JSON.parse(await file.text());
  if (bundle.kind !== KIND || !bundle.board?.cards) throw new Error('that is not a vodpad session file');

  const doc = bundle.board;
  const title = `${bundle.title || doc.title || 'imported session'}`;
  const dismiss = toast(`bringing in "${title}"…`, { ms: 20000 });

  // a fresh session in whatever backend is live right now
  const created = await api.createBoard(title);
  const newId = created.board.id;

  // screenshots first, so the notes can point at the new copies
  const remap = {};
  for (const [src, blob] of Object.entries(bundle.media || {})) {
    try {
      const bytes = Uint8Array.from(atob(blob.data), (c) => c.charCodeAt(0));
      const res = await api.upload(newId, new Blob([bytes], { type: blob.mime || 'image/png' }));
      remap[src] = res.src;
    } catch { /* a picture that won't upload shouldn't lose the notes */ }
  }

  doc.id = newId;
  doc.title = title;
  doc.updated = Date.now();
  for (const card of Object.values(doc.cards)) {
    for (const block of card.blocks || []) {
      if (block.type === 'image' && block.src && remap[block.src]) block.src = remap[block.src];
    }
    for (const shape of card.shapes || []) {
      if (shape.src && remap[shape.src]) shape.src = remap[shape.src];
    }
  }
  await api.saveBoard(newId, doc);
  await refreshBoards();

  dismiss();
  toast(`"${title}" is in — ${Object.keys(remap).length} picture${Object.keys(remap).length === 1 ? '' : 's'}`, { kind: 'ok' });
  return newId;
}

/* ---------------------------------------------------------------- explainer */

export function transferHelp() {
  const line = (what, how) => h('div.help-row', h('b', { text: what }), h('span', { text: how }));
  return openModal({
    title: 'moving notes around',
    width: 520,
    body: h('div.help-box',
      h('p.modal-text', { text: 'two different things, depending on whether sync is on:' }),
      line('sharing (sync only)',
        'the ⋯ menu on a session card → share with the other accounts. they open it from their own dashboard and can edit it; only you can delete or unshare it. nothing is copied — you are all looking at the same session.'),
      line('handing over a copy',
        'the ⋯ menu → export session file. that .vodpad file holds the notes and every screenshot. send it however you like; they use import a session and get their own copy to scribble on.'),
      line('between your own devices',
        'with sync on, nothing to do — it is already there. without it, export on one and import on the other.'),
      h('p.modal-text', { style: { marginTop: '14px' }, text: 'a session file is plain json, so it imports anywhere: the desktop app, the site, or the synced site.' }),
    ),
    actions: [{ label: 'got it', value: true, kind: 'primary' }],
  });
}
