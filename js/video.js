/* the video panel — deliberately optional. every note feature works with this
   closed; it just saves you alt-tabbing while you review. */

import { $, h, clear, clamp, fmtClock, fmtBytes, parseClock } from './util.js?v=440f02a293';
import { icon } from './icons.js?v=440f02a293';
import { api, videoUrl } from './api.js?v=440f02a293';
import { state, card, commit, quietly, bus } from './store.js?v=440f02a293';
import { toast, contextMenu, promptDialog, popover, closePopover } from './ui.js?v=440f02a293';
import { animate, EASE } from './motion.js?v=440f02a293';

let panel = null;
let media = null;          // the <video> element when a local file is loaded
let frame = null;          // the youtube iframe when a link is loaded

/* ---------------------------------------------------------------- panel */

export function mountVideoPanel() {
  if (!state.video.open) return;
  ensurePanel();
}

export function toggleVideo() {
  state.video.open = !state.video.open;
  if (state.video.open) ensurePanel();
  else destroyPanel();
  $('#tb-video')?.classList.toggle('on', state.video.open);
}

function destroyPanel() {
  if (!panel) return;
  animate(panel, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.98)' }],
    { duration: 180, fill: 'forwards' }).finished?.then(() => { panel?.remove(); panel = null; media = null; frame = null; })
    ?? (panel.remove(), panel = null);
}

function ensurePanel() {
  if (panel) { panel.hidden = false; return panel; }
  panel = h('div.video-panel',
    h('div.video-head',
      icon('video', { size: 14 }),
      h('span.video-title', { text: state.video.label || 'video' }),
      h('button.icon-btn', { tip: 'pick a source', on: { click: (e) => sourceMenu(e.currentTarget) } }, icon('folder', { size: 14 })),
      h('button.icon-btn', { tip: 'close · v', on: { click: () => toggleVideo() } }, icon('close', { size: 14 }))),
    h('div.video-body#video-body'),
  );
  document.body.append(panel);
  dragPanel(panel.querySelector('.video-head'));
  paintBody();
  animate(panel, [{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }],
    { duration: 260, easing: EASE.emph });
  return panel;
}

function paintBody() {
  const body = $('#video-body');
  if (!body) return;
  clear(body);

  if (!state.video.kind) {
    body.append(h('div.video-empty',
      h('div', icon('video', { size: 26 })),
      h('div', { text: 'no video loaded' }),
      h('div', { style: { display: 'flex', gap: '7px' } },
        h('button.btn.btn-sm.btn-primary', { on: { click: pickLocal } }, icon('folder', { size: 13 }), 'your recordings'),
        h('button.btn.btn-sm', { on: { click: pickYoutube } }, icon('link', { size: 13 }), 'youtube link'))));
    return;
  }

  const stage = h('div.video-stage');
  if (state.video.kind === 'local') {
    media = h('video', {
      src: state.video.url, controls: false, preload: 'metadata',
      on: {
        loadedmetadata: () => { state.video.duration = media.duration; paintFoot(); },
        timeupdate: () => paintScrub(),
        click: () => togglePlay(),
      },
    });
    stage.append(media);
    frame = null;
  } else {
    frame = h('iframe', {
      src: `https://www.youtube-nocookie.com/embed/${state.video.token}?start=${Math.floor(state.video.time || 0)}&rel=0`,
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture',
      allowfullscreen: '',
    });
    stage.append(frame);
    media = null;
  }
  body.append(stage, footEl());
  paintScrub();
}

function footEl() {
  return h('div.video-foot#video-foot',
    h('button.icon-btn', { tip: 'play / pause', on: { click: togglePlay } }, icon('play', { size: 14 })),
    h('span.video-time#video-time', { text: '0:00' }),
    h('div.video-scrub#video-scrub',
      h('div.video-scrub-track'),
      h('div.video-scrub-fill#video-fill'),
      h('div.video-markers#video-markers')),
    h('button.icon-btn', { tip: 'note at this moment · t', on: { click: () => stampNote() } }, icon('clock', { size: 14 })),
    h('button.icon-btn', { tip: 'grab this frame · s', on: { click: () => grabFrame() } }, icon('camera', { size: 14 })),
  );
}

function paintFoot() { paintScrub(); }

function paintScrub() {
  const fill = $('#video-fill');
  const time = $('#video-time');
  if (!fill || !time) return;
  const cur = media ? media.currentTime : state.video.time || 0;
  const dur = media ? media.duration || 0 : state.video.duration || 0;
  state.video.time = cur;
  time.textContent = dur ? `${fmtClock(cur)} / ${fmtClock(dur)}` : fmtClock(cur);
  fill.style.width = dur ? `${clamp((cur / dur) * 100, 0, 100)}%` : '0%';

  const markers = $('#video-markers');
  if (markers && dur) {
    clear(markers);
    for (const t of stampsInCard()) {
      markers.append(h('span.video-marker', {
        style: { left: `${clamp((t / dur) * 100, 0, 100)}%` },
        tip: fmtClock(t),
        on: { click: (e) => { e.stopPropagation(); seekTo(t); } },
      }));
    }
  }

  const scrub = $('#video-scrub');
  if (scrub && !scrub.dataset.wired) {
    scrub.dataset.wired = '1';
    scrub.addEventListener('click', (e) => {
      if (e.target.classList.contains('video-marker')) return;
      const r = scrub.getBoundingClientRect();
      const dd = media ? media.duration : state.video.duration;
      if (dd) seekTo(((e.clientX - r.left) / r.width) * dd);
    });
  }
}

function stampsInCard() {
  const c = card(state.cardId);
  if (!c) return [];
  const out = new Set();
  for (const block of c.blocks || []) {
    for (const m of String(block.html || '').matchAll(/data-t="([\d.]+)"/g)) out.add(Number(m[1]));
  }
  for (const kid of Object.values(state.board.cards)) {
    if (kid.parent === c.id && kid.t !== null && kid.t !== undefined) out.add(kid.t);
  }
  return [...out].sort((a, b) => a - b);
}

function dragPanel(handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const onMove = (ev) => {
      panel.style.left = `${clamp(ev.clientX - dx, 4, innerWidth - r.width - 4)}px`;
      panel.style.top = `${clamp(ev.clientY - dy, 50, innerHeight - 80)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

/* ---------------------------------------------------------------- sources */

function sourceMenu(anchor) {
  contextMenu([
    { label: 'pick a recording', icon: 'folder', onPick: pickLocal },
    { label: 'paste a youtube link', icon: 'link', onPick: pickYoutube },
    { sep: true },
    { label: 'unload', icon: 'close', onPick: () => { state.video = { ...state.video, kind: null, token: null, url: null, label: '' }; saveVideo(); paintBody(); } },
  ], { anchor, align: 'end' });
}

async function pickLocal() {
  let data;
  try { data = await api.videos(); } catch { data = { files: [], local: true }; }

  // hosted build: no folder to list, so pick a file straight off the machine
  if (data.local || !data.files.length) {
    const input = h('input', { type: 'file', accept: 'video/*', style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      loadLocal({ name: file.name, token: URL.createObjectURL(file), size: file.size });
    });
    input.click();
    return;
  }
  const list = h('div.video-list', ...data.files.slice(0, 60).map((f) => h('button.video-row', {
    on: { click: () => { closePopover(); loadLocal(f); } },
  },
    icon('video', { size: 14 }),
    h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
    h('small', { text: fmtBytes(f.size) }))));
  popover(list, { anchor: panel.querySelector('.video-head'), width: 340 });
}

function loadLocal(file) {
  state.video = { ...state.video, kind: 'local', token: file.token, url: videoUrl(file.token), label: file.name, time: 0 };
  saveVideo();
  paintBody();
  panel.querySelector('.video-title').textContent = file.name;
  toast(`loaded ${file.name}`, { kind: 'ok' });
}

async function pickYoutube() {
  const url = await promptDialog({ title: 'youtube link', placeholder: 'https://youtube.com/watch?v=…', okLabel: 'load' });
  if (!url) return;
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{6,20})/);
  if (!m) { toast('that does not look like a youtube link', { kind: 'warn' }); return; }
  state.video = { ...state.video, kind: 'youtube', token: m[1], url, label: 'youtube', time: 0 };
  saveVideo();
  paintBody();
  panel.querySelector('.video-title').textContent = 'youtube';
}

function saveVideo() {
  if (!state.board) return;
  const v = { kind: state.video.kind, token: state.video.token, label: state.video.label };
  quietly((b) => { b.video = v; });
}

/* the panel belongs to a session — never leave it floating over the dashboard */
bus.on('route', (route) => {
  if (!panel) return;
  panel.style.display = route.name === 'dash' ? 'none' : '';
});

bus.on('board:open', () => {
  const v = state.board?.video;
  if (v && v.kind) {
    state.video = { ...state.video, kind: v.kind, token: v.token, label: v.label, url: v.kind === 'local' ? videoUrl(v.token) : null, time: 0 };
    if (state.video.open) paintBody();
  }
});

/* ---------------------------------------------------------------- controls */

export function togglePlay() {
  if (!media) return;
  if (media.paused) media.play().catch(() => {}); else media.pause();
}

export function seekTo(seconds) {
  if (seconds === null || seconds === undefined) return;
  state.video.open = true;
  ensurePanel();
  if (media) { media.currentTime = seconds; media.play().catch(() => {}); }
  else if (state.video.kind === 'youtube') {
    state.video.time = seconds;
    paintBody();
  }
  paintScrub();
}

export function currentTime() {
  return media ? media.currentTime : (state.video.time || 0);
}

/* ---------------------------------------------------------------- notes from video */

export async function insertTimestamp(blockId) {
  const t = currentTime();
  const ed = await import('./editor.js?v=440f02a293');
  const body = ed.bodyOf(blockId) || ed.currentBody();
  if (!body) return;
  body.focus();
  document.execCommand('insertHTML', false,
    `<span class="chip-t" data-t="${t.toFixed(1)}" contenteditable="false">${fmtClock(t)}</span>&nbsp;`);
  const id = blockId || ed.currentBlockId();
  if (id) {
    const html = body.innerHTML;
    commit('timestamp', (b) => {
      const target = b.cards[state.cardId].blocks.find((x) => x.id === id);
      if (target) target.html = html;
    });
  }
  paintScrub();
}

export async function stampNote() {
  if (!state.board || state.route.name !== 'page') return;
  const ed = await import('./editor.js?v=440f02a293');
  const c = card(state.cardId);
  const last = ed.currentBlockId() || c.blocks.at(-1)?.id;
  const block = ed.insertBlock(last, { type: 'p' }, true);
  await insertTimestamp(block.id);
  toast(`note at ${fmtClock(currentTime())}`, { kind: 'ok', ms: 1400 });
}

export async function grabFrame() {
  if (!media) {
    toast(state.video.kind === 'youtube'
      ? 'youtube will not hand over pixels — screenshot it and press ctrl+v'
      : 'load a recording first (v opens the panel)', { kind: 'warn' });
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = media.videoWidth;
  canvas.height = media.videoHeight;
  canvas.getContext('2d').drawImage(media, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { toast('could not grab that frame', { kind: 'error' }); return; }
  const file = new File([blob], `frame-${Math.floor(currentTime())}.png`, { type: 'image/png' });
  const { insertImageFromFile } = await import('./images.js?v=440f02a293');
  const ed = await import('./editor.js?v=440f02a293');
  const block = await insertImageFromFile(file, ed.currentBlockId());
  if (block) {
    const t = currentTime();
    commit('frame time', (b) => {
      const target = b.cards[state.cardId].blocks.find((x) => x.id === block.id);
      if (target) target.caption = `${fmtClock(t)}`;
    });
  }
}

/* clicking a timestamp chip anywhere jumps the video */
document.addEventListener('click', (e) => {
  const chip = e.target.closest?.('.chip-t[data-t]');
  if (!chip) return;
  e.preventDefault();
  seekTo(Number(chip.dataset.t));
});
