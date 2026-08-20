/* the video panel — deliberately optional. every note feature works with this
   closed; it just saves you alt-tabbing while you review. */

import { $, h, clear, clamp, fmtClock, fmtBytes, parseClock } from './util.js?v=d258d51ea6';
import { icon } from './icons.js?v=d258d51ea6';
import { api, videoUrl } from './api.js?v=d258d51ea6';
import { state, card, commit, quietly, bus } from './store.js?v=d258d51ea6';
import { toast, contextMenu, promptDialog, popover, closePopover } from './ui.js?v=d258d51ea6';
import { animate, EASE } from './motion.js?v=d258d51ea6';

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
  clearInterval(clockTicker);
  clockTicker = null;
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
      h('div', { style: { display: 'flex', gap: '7px', flexWrap: 'wrap', justifyContent: 'center' } },
        h('button.btn.btn-sm.btn-primary', { on: { click: pickLocal } }, icon('folder', { size: 13 }), 'your recordings'),
        h('button.btn.btn-sm', { on: { click: pickYoutube } }, icon('link', { size: 13 }), 'youtube link'),
        h('button.btn.btn-sm', {
          tip: 'watching somewhere else? run a clock alongside it and stamp against that',
          on: { click: startClock },
        }, icon('clock', { size: 13 }), 'stopwatch')),
      h('p.video-hint', { text: 'the stopwatch is for when the vod is playing in another window — '
        + 'the replay system, obs, a stream. start it with the vod and t stamps against it.' })));
    return;
  }

  if (state.video.kind === 'clock') { body.append(clockStage(), footEl()); paintScrub(); return; }

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

/* ---------------------------------------------------------------- stopwatch

   half the time the vod is not a file you can load: it is the in-game replay
   system, or obs, or a stream in another window. a clock running alongside it
   is enough to make every timestamp feature work — t, the timeline tab, the
   clip list — because they all go through currentTime(), and this just answers
   that question a different way.

   the offset matters: you rarely start the clock at 0:00 of the recording, so
   you can tell it where the vod already is.
*/

let clockTicker = null;

function clockNow() {
  const c = state.video.clock;
  if (!c) return 0;
  return c.offset + (c.running ? (Date.now() - c.since) / 1000 : 0) + c.banked;
}

function startClock() {
  state.video = {
    ...state.video, kind: 'clock', token: null, url: null, label: 'stopwatch',
    time: 0, duration: 0,
    clock: { offset: 0, banked: 0, running: false, since: 0 },
  };
  media = null;
  frame = null;
  saveVideo();
  paintBody();
  panel?.querySelector('.video-title') && (panel.querySelector('.video-title').textContent = 'stopwatch');
}

function toggleClock() {
  const c = state.video.clock;
  if (!c) return;
  if (c.running) { c.banked += (Date.now() - c.since) / 1000; c.running = false; }
  else { c.since = Date.now(); c.running = true; }
  paintBody();
}

function resetClock() {
  const c = state.video.clock;
  if (!c) return;
  c.banked = 0;
  c.running = false;
  c.since = 0;
  paintBody();
}

function clockStage() {
  const c = state.video.clock || { offset: 0, banked: 0, running: false };
  const face = h('div.clock-face#clock-face', { text: fmtClock(clockNow()) });

  clearInterval(clockTicker);
  clockTicker = setInterval(() => {
    const el2 = $('#clock-face');
    if (!el2) { clearInterval(clockTicker); clockTicker = null; return; }
    el2.textContent = fmtClock(clockNow());
    paintScrub();
  }, 250);

  return h('div.video-stage.clock-stage',
    face,
    h('div.clock-row',
      h('button.btn.btn-sm', { class: c.running ? '' : 'btn-primary', on: { click: toggleClock } },
        icon(c.running ? 'pause' : 'play', { size: 13 }), c.running ? 'pause' : (c.banked ? 'resume' : 'start')),
      h('button.btn.btn-sm', { on: { click: resetClock } }, icon('undo', { size: 13 }), 'reset')),
    h('div.clock-row',
      h('span.clock-label', { text: 'the vod is already at' }),
      h('input.field.clock-offset', {
        value: fmtClock(c.offset), spellcheck: false,
        on: { change: (e) => {
          const secs = parseClock(e.target.value);
          state.video.clock.offset = Number.isFinite(secs) && secs >= 0 ? secs : 0;
          paintBody();
        } },
      })),
    h('p.video-hint', { text: c.running
      ? 'stamping with t now records the clock, not a file position.'
      : 'start this at the same moment you press play over there.' }));
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
    h('button.icon-btn', { tip: 'pick from the frames either side · shift+s', on: { click: () => pickFrame() } }, icon('layers', { size: 14 })),
  );
}

function paintFoot() { paintScrub(); }

function paintScrub() {
  const fill = $('#video-fill');
  const time = $('#video-time');
  if (!fill || !time) return;
  const cur = state.video.kind === 'clock' ? clockNow()
    : media ? media.currentTime : state.video.time || 0;
  // a stopwatch has no end, so there is no bar to fill and no scrub to draw
  const dur = state.video.kind === 'clock' ? 0
    : media ? media.duration || 0 : state.video.duration || 0;
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
    { label: 'stopwatch', icon: 'clock', hint: 'elsewhere', onPick: startClock },
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
    state.video = {
      ...state.video, kind: v.kind, token: v.token, label: v.label,
      url: v.kind === 'local' ? videoUrl(v.token) : null, time: 0,
      // only the *choice* of a stopwatch is remembered, never a running one —
      // resuming a clock started three days ago would read as hours elapsed
      clock: v.kind === 'clock' ? { offset: 0, banked: 0, running: false, since: 0 } : null,
    };
    if (state.video.open) paintBody();
  }
});

/* ---------------------------------------------------------------- controls */

export function togglePlay() {
  if (state.video.kind === 'clock') return toggleClock();
  if (!media) return;
  if (media.paused) media.play().catch(() => {}); else media.pause();
}

export function seekTo(seconds) {
  if (seconds === null || seconds === undefined) return;
  state.video.open = true;
  ensurePanel();
  if (state.video.kind === 'clock') {
    // nothing to seek — but re-pointing the clock at a stamp is how you get
    // back in sync after scrubbing the vod in the other window
    const c = state.video.clock;
    if (c) { c.offset = seconds; c.banked = 0; c.running = false; c.since = 0; }
    paintBody();
    toast(`clock set to ${fmtClock(seconds)} — line the vod up and press start`, { ms: 3600 });
    return;
  }
  if (media) { media.currentTime = seconds; media.play().catch(() => {}); }
  else if (state.video.kind === 'youtube') {
    state.video.time = seconds;
    paintBody();
  }
  paintScrub();
}

export function currentTime() {
  if (state.video.kind === 'clock') return clockNow();
  return media ? media.currentTime : (state.video.time || 0);
}

/* ---------------------------------------------------------------- notes from video */

export async function insertTimestamp(blockId) {
  const t = currentTime();
  const ed = await import('./editor.js?v=d258d51ea6');
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
  const ed = await import('./editor.js?v=d258d51ea6');
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
      : state.video.kind === 'clock'
        ? 'the stopwatch has no pixels to grab — screenshot the other window and press ctrl+v'
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
  const { insertImageFromFile } = await import('./images.js?v=d258d51ea6');
  const ed = await import('./editor.js?v=d258d51ea6');
  const block = await insertImageFromFile(file, ed.currentBlockId());
  if (block) {
    const t = currentTime();
    commit('frame time', (b) => {
      const target = b.cards[state.cardId].blocks.find((x) => x.id === block.id);
      if (target) target.caption = `${fmtClock(t)}`;
    });
  }
}

/* ---------------------------------------------------------------- frame strip

   grabFrame() takes the frame that is showing at the instant you press, which
   is never the frame you wanted — you notice the mistake half a second after
   it happens. this walks a window either side of where you are, shows them as
   thumbnails, and puts the one you pick into the page at full resolution.

   the video is paused, scrubbed and put back exactly where it was.
*/

const STEPS = [
  { label: 'fine', step: 0.2 },
  { label: 'normal', step: 0.5 },
  { label: 'wide', step: 1 },
  { label: 'very wide', step: 2 },
];

/** seek and wait for the pixels to actually be there */
function seekAndSettle(el, time) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; el.removeEventListener('seeked', finish); resolve(); };
    el.addEventListener('seeked', finish);
    // a seek past the end, or into a gap, can never fire — don't hang on it
    setTimeout(finish, 900);
    try { el.currentTime = time; } catch { finish(); }
  });
}

function shoot(el, width) {
  const canvas = document.createElement('canvas');
  const scale = width ? Math.min(1, width / (el.videoWidth || width)) : 1;
  canvas.width = Math.max(1, Math.round((el.videoWidth || 640) * scale));
  canvas.height = Math.max(1, Math.round((el.videoHeight || 360) * scale));
  canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function pickFrame() {
  if (!media) {
    toast(state.video.kind === 'youtube'
      ? 'youtube will not hand over pixels — screenshot it and press ctrl+v'
      : state.video.kind === 'clock'
        ? 'the stopwatch has no pixels to grab — screenshot the other window and press ctrl+v'
        : 'load a recording first (v opens the panel)', { kind: 'warn' });
    return;
  }

  const wasPlaying = !media.paused;
  const wasAt = media.currentTime;
  media.pause();

  const strip = h('div.frame-strip');
  const caption = h('p.modal-text.dim', { text: 'pick the one that actually shows it' });
  let step = 0.5;
  let cancelled = false;
  let picked = null;
  // changing the step restarts the walk; the previous one has to stop, or two
  // loops fight over media.currentTime and every thumbnail is the wrong frame
  let run = 0;

  const { openModal } = await import('./ui.js?v=d258d51ea6');

  const draw = async () => {
    const mine = ++run;
    clear(strip);
    const times = [];
    for (let i = -8; i <= 8; i++) {
      const t = wasAt + i * step;
      if (t >= 0 && t <= (media.duration || Infinity)) times.push(t);
    }
    // placeholders first, so the grid does not jump around as they fill in
    const cells = times.map((t) => {
      const cell = h('button.frame-cell', { class: Math.abs(t - wasAt) < 1e-6 ? 'here' : '' },
        h('div.frame-shot'), h('span.frame-t', { text: fmtClock(t) }));
      cell.onclick = () => { picked = t; done(true); };
      strip.append(cell);
      return { t, cell };
    });

    for (const { t, cell } of cells) {
      if (cancelled || mine !== run) return;
      await seekAndSettle(media, t);
      if (cancelled || mine !== run) return;
      const url = shoot(media, 220).toDataURL('image/jpeg', 0.72);
      const shot = cell.querySelector('.frame-shot');
      clear(shot);
      shot.append(h('img', { src: url, alt: '' }));
    }
    if (mine === run) caption.textContent = `${cells.length} frames, ${step}s apart · click the right one`;
  };

  let done = () => {};
  const modal = openModal({
    title: 'which frame?',
    width: 760,
    body: h('div',
      h('div.frame-steps', ...STEPS.map((s) => h('button.pat-sort', {
        class: s.step === step ? 'on' : '',
        text: s.label,
        on: {
          click: (e) => {
            step = s.step;
            for (const b of e.currentTarget.parentElement.children) b.classList.toggle('on', b === e.currentTarget);
            draw();
          },
        },
      }))),
      strip, caption),
    actions: [{ label: 'cancel', value: null }],
    onMount: (_box, finish) => { done = finish; draw(); },
  });

  const answer = await modal;
  cancelled = true;

  if (answer !== true || picked === null) {
    await seekAndSettle(media, wasAt);
    if (wasPlaying) media.play().catch(() => {});
    return;
  }

  // full resolution for the one that is going into the page
  await seekAndSettle(media, picked);
  const blob = await new Promise((res) => shoot(media, 0).toBlob(res, 'image/png'));
  await seekAndSettle(media, wasAt);
  if (wasPlaying) media.play().catch(() => {});

  if (!blob) { toast('could not grab that frame', { kind: 'error' }); return; }
  const file = new File([blob], `frame-${Math.floor(picked)}.png`, { type: 'image/png' });
  const { insertImageFromFile } = await import('./images.js?v=d258d51ea6');
  const ed = await import('./editor.js?v=d258d51ea6');
  const block = await insertImageFromFile(file, ed.currentBlockId());
  if (block) {
    commit('frame time', (b) => {
      const target = b.cards[state.cardId].blocks.find((x) => x.id === block.id);
      if (target) target.caption = fmtClock(picked);
    });
  }
  toast(`frame at ${fmtClock(picked)}`, { kind: 'ok', ms: 1800 });
}

/* clicking a timestamp chip anywhere jumps the video */
document.addEventListener('click', (e) => {
  const chip = e.target.closest?.('.chip-t[data-t]');
  if (!chip) return;
  e.preventDefault();
  seekTo(Number(chip.dataset.t));
});
