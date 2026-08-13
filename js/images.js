/* pictures: paste them in, put text beside them, pin notes onto them. */

import { h, $, $$, uid, clamp, debounce } from './util.js?v=58e76add28';
import { icon } from './icons.js?v=58e76add28';
import { api, mediaUrl } from './api.js?v=58e76add28';
import { state, card, commit, quietly, bus } from './store.js?v=58e76add28';
import { toast, contextMenu, popover, closePopover, confirmDialog } from './ui.js?v=58e76add28';
import { animate, EASE, ping } from './motion.js?v=58e76add28';

const LAYOUTS = [
  ['left', 'text on the right', 'alignLeft'],
  ['center', 'on its own', 'alignCenter'],
  ['right', 'text on the left', 'alignLeft'],
  ['full', 'full width', 'expand'],
];

/* ---------------------------------------------------------------- render */

export function renderImageBlock(block, cardId) {
  const fig = h('figure.img-block', {
    data: { layout: block.layout || 'center', id: block.id },
    style: { '--w': block.width ? `${block.width}%` : '100%' },
  });

  const img = h('img.img-el', {
    src: block.src ? mediaUrl(state.board.id, block.src) : (block.pending || ''),
    alt: block.caption || '',
    draggable: 'false',
    on: {
      load: () => { bus.emit('page:reflow'); if (!block.nat && img.naturalWidth) saveNat(block.id, img.naturalWidth, img.naturalHeight); },
      dblclick: () => openStudio(block.id),
    },
  });

  const tool = (ico, tip, run, on = false) => h('button.img-tool', {
    class: on ? 'on' : '', tip,
    on: {
      pointerdown: (e) => { e.preventDefault(); e.stopPropagation(); },
      click: (e) => { e.preventDefault(); e.stopPropagation(); selectImage(block.id); run(e); },
    },
  }, icon(ico, { size: 15 }));

  const frame = h('div.img-frame',
    img,
    strokeLayer(block),
    pinLayer(block, cardId),
    h('div.img-tools',
      ...LAYOUTS.map(([value, tip, ico]) => tool(ico, tip, () => setLayout(block.id, value), (block.layout || 'center') === value)),
      h('span.tb-sep'),
      tool('pen', 'draw on it · or double-click the picture', () => openStudio(block.id)),
      tool('pin', 'drop a numbered pin', () => armPin(block.id)),
      tool('link', 'link it to a line of text', async () => (await import('./anchors.js?v=58e76add28')).linkImageToLine(block.id)),
      tool('dots', 'everything else · or just right-click the picture', (e) => {
        e.currentTarget.closest('.img-block').dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, clientX: e.clientX, clientY: e.clientY,
        }));
      })),
    h('div.img-resize', { tip: 'drag to resize', on: { pointerdown: (e) => startResize(e, block.id, fig) } }),
  );

  // clicking the picture keeps its toolbar up — no more chasing a hover state
  frame.addEventListener('pointerdown', () => selectImage(block.id));

  fig.append(frame);
  fig.append(h('figcaption.img-cap', {
    contenteditable: 'true',
    html: block.caption || '',
    'data-ph': 'caption (optional)',
    on: {
      input: (e) => {
        const html = e.target.innerHTML;
        commit('caption', (b) => {
          const t = b.cards[cardId].blocks.find((x) => x.id === block.id);
          if (t) t.caption = html;
        }, { coalesce: `cap:${block.id}` });
      },
    },
  }));
  return fig;
}

function saveNat(blockId, w, hh) {
  const cardId = state.cardId;
  quietly((b) => {
    const t = b.cards[cardId]?.blocks.find((x) => x.id === blockId);
    if (t) t.nat = { w, h: hh };
  });
}

/* ---------------------------------------------------------------- strokes + pins */

export function strokeLayer(block) {
  const nat = block.nat || { w: 1600, h: 900 };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'img-strokes');
  svg.setAttribute('viewBox', `0 0 ${nat.w} ${nat.h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  paintStrokes(svg, block);
  return svg;
}

export function paintStrokes(svg, block) {
  const NS = 'http://www.w3.org/2000/svg';
  svg.innerHTML = '';
  const nat = block.nat || { w: 1600, h: 900 };
  const strokes = block.strokes || [];
  if (!strokes.length) return;

  const defs = document.createElementNS(NS, 'defs');
  defs.innerHTML = `
    <marker id="ah-${block.id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/>
    </marker>
    <filter id="bl-${block.id}"><feGaussianBlur stdDeviation="${Math.round(Math.max(nat.w, nat.h) / 90)}"/></filter>`;
  svg.append(defs);

  for (const s of strokes) {
    const color = `var(--ink-${s.color || 'rose'})`;
    const width = (s.size || 3) * (nat.w / 1000);
    let el;
    if (s.tool === 'pen') {
      el = document.createElementNS(NS, 'polyline');
      el.setAttribute('points', (s.pts || []).map((p) => p.join(',')).join(' '));
      el.setAttribute('fill', 'none');
    } else if (s.tool === 'arrow' || s.tool === 'line') {
      el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', s.x); el.setAttribute('y1', s.y);
      el.setAttribute('x2', s.x2); el.setAttribute('y2', s.y2);
      if (s.tool === 'arrow') el.setAttribute('marker-end', `url(#ah-${block.id})`);
    } else if (s.tool === 'box') {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', Math.min(s.x, s.x2)); el.setAttribute('y', Math.min(s.y, s.y2));
      el.setAttribute('width', Math.abs(s.x2 - s.x)); el.setAttribute('height', Math.abs(s.y2 - s.y));
      el.setAttribute('rx', width * 1.2);
      el.setAttribute('fill', 'none');
    } else if (s.tool === 'ellipse') {
      el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('cx', (s.x + s.x2) / 2); el.setAttribute('cy', (s.y + s.y2) / 2);
      el.setAttribute('rx', Math.abs(s.x2 - s.x) / 2); el.setAttribute('ry', Math.abs(s.y2 - s.y) / 2);
      el.setAttribute('fill', 'none');
    } else if (s.tool === 'blur') {
      const clip = document.createElementNS(NS, 'clipPath');
      clip.setAttribute('id', `clip-${s.id}`);
      const box = document.createElementNS(NS, 'rect');
      box.setAttribute('x', Math.min(s.x, s.x2));
      box.setAttribute('y', Math.min(s.y, s.y2));
      box.setAttribute('width', Math.abs(s.x2 - s.x));
      box.setAttribute('height', Math.abs(s.y2 - s.y));
      clip.append(box);
      defs.append(clip);
      const img = document.createElementNS(NS, 'image');
      img.setAttribute('href', mediaUrl(state.board.id, blockSrc(block)));
      img.setAttribute('x', 0); img.setAttribute('y', 0);
      img.setAttribute('width', nat.w); img.setAttribute('height', nat.h);
      img.setAttribute('preserveAspectRatio', 'none');
      img.setAttribute('filter', `url(#bl-${block.id})`);
      img.setAttribute('clip-path', `url(#clip-${s.id})`);
      img.dataset.id = s.id;
      svg.append(img);
      continue;
    } else if (s.tool === 'text') {
      el = document.createElementNS(NS, 'text');
      el.setAttribute('x', s.x); el.setAttribute('y', s.y);
      el.setAttribute('fill', color);
      el.setAttribute('font-size', (s.size || 3) * 9 * (nat.w / 1000));
      el.setAttribute('font-family', 'Segoe UI, system-ui, sans-serif');
      el.setAttribute('font-weight', '600');
      el.textContent = s.text || '';
      el.dataset.id = s.id;
      svg.append(el);
      continue;
    }
    if (!el) continue;
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', width);
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.dataset.id = s.id;
    svg.append(el);
  }
}

const blockSrc = (block) => block.src;

function pinLayer(block, cardId) {
  const layer = h('div.img-pins');
  (block.pins || []).forEach((pin, i) => {
    const el = h('button.img-pin', {
      style: { left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` },
      data: { id: pin.id },
      text: String(i + 1),
      tip: pin.text ? pin.text.slice(0, 60) : 'empty pin — click to write',
      on: {
        click: (e) => { e.stopPropagation(); openPin(block.id, pin.id, e.currentTarget); },
        pointerdown: (e) => dragPin(e, block.id, pin.id),
      },
    });
    layer.append(el);
  });
  return layer;
}

export function armPin(blockId) {
  const fig = document.querySelector(`.img-block[data-id="${CSS.escape(blockId)}"]`);
  if (!fig) return;
  fig.classList.add('arming');
  toast('click anywhere on the picture to drop the pin', { ms: 2400 });
  const frame = fig.querySelector('.img-frame');
  const place = (e) => {
    const r = frame.getBoundingClientRect();
    const nx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const ny = clamp((e.clientY - r.top) / r.height, 0, 1);
    addPin(blockId, nx, ny);
    cleanup();
  };
  const cleanup = () => {
    fig.classList.remove('arming');
    frame.removeEventListener('click', place, true);
  };
  frame.addEventListener('click', place, true);
  setTimeout(() => document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { cleanup(); document.removeEventListener('keydown', esc); }
  }), 0);
}

export function addPin(blockId, nx, ny) {
  const cardId = state.cardId;
  const pin = { id: uid('pin'), nx, ny, text: '' };
  commit('add pin', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) (t.pins ||= []).push(pin);
  });
  refreshImage(blockId);
  requestAnimationFrame(() => {
    const el = document.querySelector(`.img-pin[data-id="${pin.id}"]`);
    if (el) { animate(el, [{ transform: 'translate(-50%,-50%) scale(0)' }, { transform: 'translate(-50%,-50%) scale(1)' }], { duration: 260, easing: EASE.snap }); el.click(); }
  });
  return pin;
}

function openPin(blockId, pinId, anchor) {
  const block = card(state.cardId).blocks.find((x) => x.id === blockId);
  const pin = (block?.pins || []).find((p) => p.id === pinId);
  if (!pin) return;
  const index = block.pins.indexOf(pin) + 1;

  const area = h('textarea.field', { value: pin.text || '', placeholder: 'what happened here?', rows: 3 });
  area.addEventListener('input', debounce(() => {
    const cardId = state.cardId, text = area.value;
    commit('pin note', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
      const p = (t?.pins || []).find((x) => x.id === pinId);
      if (p) p.text = text;
    }, { coalesce: `pin:${pinId}` });
  }, 220));

  popover(h('div.pin-pop',
    h('div.pin-pop-head', h('span.pin-num', { text: String(index) }), h('span', { text: 'pin note' })),
    area,
    h('div.pin-pop-foot',
      h('button.btn.btn-sm.btn-ghost', {
        on: { click: async () => { closePopover(); (await import('./anchors.js?v=58e76add28')).linkPinToLine(blockId, pinId); } },
      }, icon('link', { size: 13 }), 'link to a line'),
      h('button.btn.btn-sm.btn-ghost.btn-danger', {
        on: { click: () => { removePin(blockId, pinId); closePopover(); } },
      }, icon('trash', { size: 13 }), 'delete')),
  ), { anchor, width: 268, onClose: () => refreshImage(blockId) });
  setTimeout(() => area.focus(), 60);
}

export function removePin(blockId, pinId) {
  const cardId = state.cardId;
  commit('remove pin', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.pins = (t.pins || []).filter((p) => p.id !== pinId);
  });
  refreshImage(blockId);
}

function dragPin(e, blockId, pinId) {
  if (e.button !== 0) return;
  const el = e.currentTarget;
  const frame = el.closest('.img-frame');
  let moved = false;
  const onMove = (ev) => {
    moved = true;
    const r = frame.getBoundingClientRect();
    const nx = clamp((ev.clientX - r.left) / r.width, 0, 1);
    const ny = clamp((ev.clientY - r.top) / r.height, 0, 1);
    el.style.left = `${nx * 100}%`;
    el.style.top = `${ny * 100}%`;
    el._nx = nx; el._ny = ny;
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!moved) return;
    const cardId = state.cardId;
    const nx = el._nx, ny = el._ny;
    commit('move pin', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
      const p = (t?.pins || []).find((x) => x.id === pinId);
      if (p) { p.nx = nx; p.ny = ny; }
    });
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------------------------------------------------------------- layout + size */

export function setLayout(blockId, layout) {
  const cardId = state.cardId;
  commit('picture layout', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) { t.layout = layout; if (layout === 'full') t.width = 100; else if (!t.width || t.width > 92) t.width = layout === 'center' ? 100 : 46; }
  });
  refreshImage(blockId);
  bus.emit('page:reflow');
}

export function setWidth(blockId, pct) {
  const cardId = state.cardId;
  commit('picture size', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.width = pct;
  });
  refreshImage(blockId);
  bus.emit('page:reflow');
}

export function clearStrokes(blockId) {
  const cardId = state.cardId;
  commit('clear drawings', (b) => {
    const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
    if (t) t.strokes = [];
  });
  refreshImage(blockId);
}

export function replacePicture(blockId) {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const src = await uploadImage(file);
      const cardId = state.cardId;
      commit('replace picture', (b) => {
        const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
        if (t) { t.src = src; t.nat = null; t.strokes = []; }
      });
      refreshImage(blockId);
      toast('picture replaced', { kind: 'ok' });
    } catch (err) {
      toast(`could not replace it: ${err.message}`, { kind: 'error' });
    }
  });
  input.click();
}

/** keep the toolbar up while a picture is the thing you're working on */
export function selectImage(blockId) {
  for (const el of document.querySelectorAll('.img-block.picked')) el.classList.remove('picked');
  const fig = document.querySelector(`.img-block[data-id="${CSS.escape(blockId)}"]`);
  fig?.classList.add('picked');
  pickedImage = blockId;
}

export function clearImageSelection() {
  for (const el of document.querySelectorAll('.img-block.picked')) el.classList.remove('picked');
  pickedImage = null;
}

let pickedImage = null;
export const imagePicked = () => pickedImage;

function startResize(e, blockId, fig) {
  e.preventDefault();
  const main = fig.closest('.page-main') || fig.parentElement;
  const total = main.clientWidth;
  const startX = e.clientX;
  const start = fig.getBoundingClientRect().width;
  const layout = fig.dataset.layout;
  const dir = layout === 'right' ? -1 : 1;
  fig.classList.add('resizing');

  const onMove = (ev) => {
    const px = start + (ev.clientX - startX) * dir;
    const pct = clamp(Math.round((px / total) * 100), 18, 100);
    fig.style.setProperty('--w', `${pct}%`);
    fig._pct = pct;
    bus.emit('page:reflow');
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    fig.classList.remove('resizing');
    const cardId = state.cardId, pct = fig._pct;
    if (!pct) return;
    commit('resize picture', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === blockId);
      if (t) t.width = pct;
    });
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

export function refreshImage(blockId) {
  const wasPicked = pickedImage === blockId;
  import('./editor.js?v=58e76add28').then((ed) => {
    ed.refreshBlock(blockId);
    if (wasPicked) selectImage(blockId);
  });
}

async function openStudio(blockId) {
  const { openAnnotator } = await import('./annotate.js?v=58e76add28');
  openAnnotator(blockId);
}

/* ---------------------------------------------------------------- getting pictures in */

export async function uploadImage(blob) {
  const type = blob.type || 'image/png';
  const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'png';
  const res = await api.upload(state.board.id, blob, ext);
  return res.src;
}

function measure(blobUrl) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
    probe.onerror = () => resolve({ w: 1600, h: 900 });
    probe.src = blobUrl;
  });
}

export async function insertImageFromFile(file, afterBlockId) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('that is not a picture', { kind: 'warn' }); return; }
  const ed = await import('./editor.js?v=58e76add28');
  const preview = URL.createObjectURL(file);
  const nat = await measure(preview);

  const block = ed.insertBlock(afterBlockId || card(state.cardId).blocks.at(-1)?.id,
    { type: 'image', pending: preview, nat, layout: 'center', width: 100, strokes: [], pins: [] }, false);

  try {
    const src = await uploadImage(file);
    const cardId = state.cardId;
    commit('add picture', (b) => {
      const t = b.cards[cardId].blocks.find((x) => x.id === block.id);
      if (t) { t.src = src; delete t.pending; }
    });
    refreshImage(block.id);
    const el = ed.blockElById(block.id);
    if (el) ping(el);
    toast('screenshot saved to disk', { kind: 'ok', ms: 1800 });
  } catch (err) {
    toast(`could not save the picture: ${err.message}`, { kind: 'error' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(preview), 5000);
  }
  bus.emit('boards');
  return block;
}

export function pickImageFile(afterBlockId) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    let anchor = afterBlockId;
    for (const file of Array.from(input.files || [])) {
      const made = await insertImageFromFile(file, anchor);
      if (made) anchor = made.id;
    }
    input.remove();
  });
  input.click();
}

/* ---------------------------------------------------------------- global capture */

document.addEventListener('paste', async (e) => {
  if (e.defaultPrevented) return;
  if (state.route.name !== 'page' || !state.board) return;
  const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const ed = await import('./editor.js?v=58e76add28');
  insertImageFromFile(item.getAsFile(), ed.currentBlockId());
});

document.addEventListener('dragover', (e) => {
  if (state.route.name !== 'page') return;
  if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
  e.preventDefault();
  document.body.classList.add('drop-armed');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('drop-armed');
});
document.addEventListener('drop', async (e) => {
  document.body.classList.remove('drop-armed');
  if (state.route.name !== 'page' || !state.board) return;
  const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  e.preventDefault();
  const ed = await import('./editor.js?v=58e76add28');
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.blk');
  let anchor = target?.dataset.id || ed.currentBlockId();
  for (const file of files) {
    const made = await insertImageFromFile(file, anchor);
    if (made) anchor = made.id;
  }
});
