/* the gear — everything you can change lives here, not in a ribbon. */

import { $, h, clear } from './util.js?v=66fb115653';
import { icon } from './icons.js?v=66fb115653';
import { api, isStatic, mode } from './api.js?v=66fb115653';
import { state, setSetting, bus } from './store.js?v=66fb115653';
import { pushLayer, dropLayer, labelled, segmented, toast, confirmDialog } from './ui.js?v=66fb115653';
import { animate, settle, fadeOut, EASE } from './motion.js?v=66fb115653';

const THEMES = [
  ['graphite', 'graphite', ['#17191c', '#25282c', '#e5484d']],
  ['fog', 'fog', ['#2a2d31', '#3b3f45', '#ef5b60']],
  ['ink', 'ink', ['#0b0c0d', '#17191b', '#e5484d']],
  ['daylight', 'daylight', ['#eceef0', '#ffffff', '#cf3239']],
];

const ACCENTS = [
  ['', 'theme default', null],
  ['crimson', '#ff4d5e', ['#ff4d5e', '#c53a49', '#8e1f2d']],
  ['blood', '#e02020', ['#e02020', '#a91818', '#6d0f0f']],
  ['toxic', '#39ff9e', ['#39ff9e', '#23b06d', '#0d6b41']],
  ['aqua', '#00e5ff', ['#00e5ff', '#049fb4', '#06596b']],
  ['hotpink', '#ff2fd6', ['#ff2fd6', '#b81f9c', '#6c1160']],
  ['orange', '#ff8a00', ['#ff8a00', '#c26800', '#7d3f00']],
  ['lilac', '#c9a7ff', ['#c9a7ff', '#8f6fd0', '#5b2fa8']],
  ['orchid', '#dba7ff', ['#dba7ff', '#a071c6', '#71309e']],
  ['periwinkle', '#a9b8ff', ['#a9b8ff', '#7787d6', '#3b46a8']],
  ['rose', '#ff9ecf', ['#ff9ecf', '#c86fa2', '#8f3268']],
  ['mint', '#6ee7c0', ['#6ee7c0', '#49b394', '#1f6f58']],
  ['amber', '#ffb454', ['#ffb454', '#c98b3c', '#8a5c1f']],
];

/* ---------------------------------------------------------------- applying */

/* twelve themes were removed. anyone whose settings still name one gets moved
   onto the nearest survivor rather than silently falling through to :root. */
const RETIRED = {
  carbon: 'graphite', ember: 'graphite', ash: 'ink', slate: 'graphite',
  'night-lilac': 'ink', 'deep-plum': 'ink', midnight: 'ink', obsidian: 'ink',
  nocturne: 'ink', aimbot: 'graphite', esp: 'graphite', chams: 'graphite',
  tracer: 'graphite', wallhack: 'graphite',
};

export function applySettings(s = state.settings) {
  const root = document.documentElement;
  if (RETIRED[s.theme]) s.theme = RETIRED[s.theme];
  root.dataset.theme = s.theme || 'graphite';
  root.dataset.motion = s.motion || 'full';
  root.dataset.density = s.density || 'comfortable';
  root.dataset.font = s.font || 'sans';

  root.style.setProperty('--text-size', `${s.textSize || 16}px`);
  root.style.setProperty('--line-height', String(s.lineHeight || 1.7));
  root.style.setProperty('--page-width', `${s.pageWidth || 72}ch`);
  root.style.setProperty('--radius', `${s.radius ?? 8}px`);
  root.style.setProperty('--radius-sm', `${Math.max(3, (s.radius ?? 8) - 2)}px`);
  root.style.setProperty('--radius-lg', `${(s.radius ?? 8) + 4}px`);

  const accent = ACCENTS.find((a) => a[0] === s.accent && a[2]);
  if (accent) {
    root.style.setProperty('--accent', accent[2][0]);
    root.style.setProperty('--accent-dim', accent[2][1]);
    root.style.setProperty('--accent-deep', accent[2][2]);
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-dim');
    root.style.removeProperty('--accent-deep');
  }

  if (s.motionSpeed) root.style.setProperty('--m', String(s.motion === 'off' ? 0.001 : (s.motion === 'subtle' ? 0.62 : 1) / s.motionSpeed));
  document.body.classList.toggle('focus-on', !!s.focusMode);
}

/* ---------------------------------------------------------------- panel */

let tab = 'appearance';
let closeFn = null;

export function openGear(startTab) {
  if (startTab) tab = startTab;
  const wrap = $('#gear-wrap');
  const panel = $('#gear');
  wrap.hidden = false;

  const close = () => {
    dropLayer(close);
    closeFn = null;
    animate(panel, [{ transform: 'none' }, { transform: 'translateX(100%)' }], { duration: 220, easing: EASE.calm });
    fadeOut(wrap, { duration: 220 }).then(() => { wrap.hidden = true; wrap.style.opacity = ''; panel.style.transform = ''; });
  };
  closeFn = close;

  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  paint(panel, close);
  animate(wrap, [{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
  animate(panel, [{ transform: 'translateX(100%)' }, { transform: 'none' }], { duration: 300, easing: EASE.emph });
  pushLayer(close);
}

export const closeGear = () => closeFn?.();

function paint(panel, close) {
  clear(panel);
  panel.append(
    h('div.gear-head',
      h('h2', { text: 'settings' }),
      h('button.icon-btn', { tip: 'close', on: { click: close } }, icon('close', { size: 16 }))),
    h('div.gear-tabs',
      ...[['appearance', 'appearance'], ['motion', 'motion'], ['editor', 'editor'], ['board', 'map'], ['data', 'data'], ['keys', 'shortcuts']]
        .map(([id, label]) => h('button.gear-tab', {
          class: tab === id ? 'on' : '', text: label,
          on: { click: () => { tab = id; paint(panel, close); } },
        }))),
    h('div.gear-body', body()),
  );
  const bodyEl = panel.querySelector('.gear-body');
  animate(bodyEl, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200 });
}

function body() {
  const s = state.settings;
  if (tab === 'appearance') return appearanceTab(s);
  if (tab === 'motion') return motionTab(s);
  if (tab === 'editor') return editorTab(s);
  if (tab === 'board') return boardTab(s);
  if (tab === 'data') return dataTab(s);
  return keysTab();
}

function appearanceTab(s) {
  const themeGrid = h('div.theme-grid', ...THEMES.map(([id, label, cols]) => h('button.theme-card', {
    class: s.theme === id ? 'on' : '',
    on: { click: (e) => {
      setSetting('theme', id);
      // picking a theme means "give me this look" — drop any accent override
      if (state.settings.accent) { setSetting('accent', ''); paint($('#gear'), closeFn); }
      applySettings();
      for (const c of e.currentTarget.parentElement.children) c.classList.toggle('on', c === e.currentTarget);
    } },
  },
    h('div.theme-swatch', ...cols.map((c) => h('i', { style: { background: c } }))),
    h('div.theme-name', { text: label }))));

  const accents = h('div.accent-row', ...ACCENTS.map(([id, label, cols]) => h('button.accent-dot', {
    class: (s.accent || '') === id ? 'on' : '',
    tip: id || 'theme default',
    style: { background: cols ? cols[0] : 'linear-gradient(135deg, var(--bg-3), var(--bg-4))' },
    on: { click: (e) => {
      setSetting('accent', id);
      applySettings();
      for (const c of e.currentTarget.parentElement.children) c.classList.toggle('on', c === e.currentTarget);
    } },
  })));

  return h('div',
    h('section.gear-section', h('h3', { text: 'theme' }), themeGrid),
    h('section.gear-section', h('h3', { text: 'accent' }), accents),
    h('section.gear-section',
      h('h3', { text: 'type' }),
      labelled('font', segmented([
        { label: 'sans', value: 'sans' }, { label: 'serif', value: 'serif' }, { label: 'mono', value: 'mono' },
      ], s.font || 'sans', (v) => { setSetting('font', v); applySettings(); }), 'what the document itself is set in'),
      slider('text size', 'textSize', s.textSize || 16, 13, 22, 1, 'px'),
      slider('line height', 'lineHeight', s.lineHeight || 1.7, 1.3, 2.1, 0.05, ''),
      slider('page width', 'pageWidth', s.pageWidth || 72, 52, 110, 2, 'ch'),
    ),
    h('section.gear-section',
      h('h3', { text: 'shape' }),
      slider('corner rounding', 'radius', s.radius ?? 8, 0, 20, 1, 'px'),
      labelled('density', segmented([
        { label: 'comfortable', value: 'comfortable' }, { label: 'compact', value: 'compact' },
      ], s.density || 'comfortable', (v) => { setSetting('density', v); applySettings(); })),
    ),
  );
}

function motionTab(s) {
  return h('div',
    h('section.gear-section',
      h('h3', { text: 'animation' }),
      labelled('level', segmented([
        { label: 'full', value: 'full' }, { label: 'subtle', value: 'subtle' }, { label: 'off', value: 'off' },
      ], s.motion || 'full', (v) => { setSetting('motion', v); applySettings(); }),
        'transitions between the dashboard, the map and a page'),
      slider('speed', 'motionSpeed', s.motionSpeed || 1, 0.5, 2, 0.1, '×'),
    ),
    h('section.gear-section',
      h('h3', { text: 'note' }),
      h('p.modal-text', { text: 'windows "reduce motion" is respected by default — the level above overrides it, since you asked for the animations.' }),
    ),
  );
}

function editorTab(s) {
  return h('div',
    h('section.gear-section',
      h('h3', { text: 'writing' }),
      labelled('spellcheck', toggle('spellcheck', s.spellcheck !== false)),
      labelled('markdown shortcuts', toggle('markdownShortcuts', s.markdownShortcuts !== false),
        '# for a heading, - for a bullet, [] for a checkbox, ``` for code'),
      labelled('focus mode', toggle('focusMode', !!s.focusMode),
        'fades every line except the one you are writing · ctrl+shift+f'),
      labelled('left panel', toggle('sidebar', s.sidebar !== false),
        'outline, pictures and the add palette · ctrl+\\'),
      slider('autosave delay', 'autosaveMs', s.autosaveMs || 400, 150, 2000, 50, 'ms'),
    ),
  );
}

function boardTab(s) {
  return h('div',
    h('section.gear-section',
      h('h3', { text: 'map' }),
      labelled('snap to grid', toggle('gridSnap', s.gridSnap !== false)),
      slider('grid size', 'snapSize', s.snapSize || 8, 2, 32, 2, 'px'),
      slider('collapse detail below', 'lodThreshold', s.lodThreshold || 0.42, 0.2, 0.9, 0.02, '×'),
    ),
  );
}

function dataTab() {
  if (isStatic) return webDataTab();
  return h('div',
    h('section.gear-section',
      h('h3', { text: 'your notes on disk' }),
      h('p.modal-text', { text: 'every session is a folder of plain json plus the real .png files you pasted. copy it, zip it, back it up — nothing is locked inside the app.' }),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h('button.btn', { on: { click: () => api.reveal('data').catch(() => toast('could not open it', { kind: 'error' })) } },
          icon('folder', { size: 14 }), 'open notes folder'),
        state.board ? h('button.btn', { on: { click: () => api.reveal('board', state.board.id).catch(() => {}) } },
          icon('image', { size: 14 }), 'this session\'s files') : null),
    ),
    state.board ? h('section.gear-section',
      h('h3', { text: 'export this session' }),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn', { on: { click: async () => (await import('./exporter.js?v=66fb115653')).exportMarkdown(state.board.rootId) } }, icon('download', { size: 14 }), 'markdown'),
        h('button.btn', { on: { click: async () => (await import('./exporter.js?v=66fb115653')).exportHtml(state.board.rootId) } }, icon('download', { size: 14 }), 'html'),
        h('button.btn', { on: { click: async () => (await import('./readmode.js?v=66fb115653')).openReader({ print: true }) } }, icon('page', { size: 14 }), 'pdf / print')),
    ) : null,
    h('section.gear-section',
      h('h3', { text: 'server' }),
      h('p.modal-text', { text: 'vodpad runs a tiny local server so your notes can live as real files. it shuts itself down 15 minutes after you close this window.' }),
      h('button.btn.btn-danger', { style: { marginTop: '10px' }, on: { click: quit } }, icon('close', { size: 14 }), 'quit vodpad'),
    ),
  );
}

/* the hosted build: either synced through the worker, or sealed in this browser */
function webDataTab() {
  const synced = mode === 'cloud';
  const size = h('p.modal-text', { text: synced ? '' : 'measuring…' });
  if (!synced) {
    import('./vault.js?v=66fb115653').then(async (v) => {
      const s = await v.vaultSize();
      size.textContent = `${s.records} sealed records · about ${(s.bytes / 1048576).toFixed(1)} mb, all of it encrypted with your password.`;
    });
  }

  return h('div',
    h('section.gear-section',
      h('h3', { text: 'signed in' }),
      h('p.modal-text', {
        text: synced
          ? `you are ${currentUserName()}, synced. sessions you write here show up on any device you sign in from, and sessions you share are visible to the other accounts.`
          : `you are ${currentUserName()} on the hosted copy. your notes live in this browser only — they do not follow you to another device.`,
      }),
      size,
      h('button.btn', { style: { marginTop: '12px' }, on: { click: async () => (await import('./api.js?v=66fb115653')).signOut() } },
        icon('back', { size: 14 }), 'sign out'),
    ),
    synced ? null : h('section.gear-section',
      h('h3', { text: 'backup' }),
      h('p.modal-text', { text: 'a backup is the same sealed data — useless without your password, and it restores into any browser you log into. clearing your browser data wipes the notes, so keep one.' }),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h('button.btn.btn-primary', { on: { click: doBackup } }, icon('download', { size: 14 }), 'download a backup'),
        h('button.btn', { on: { click: doRestore } }, icon('upload', { size: 14 }), 'restore a backup')),
    ),
    state.board ? h('section.gear-section',
      h('h3', { text: 'export this session' }),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button.btn', { on: { click: async () => (await import('./exporter.js?v=66fb115653')).exportMarkdown(state.board.rootId) } }, icon('download', { size: 14 }), 'markdown'),
        h('button.btn', { on: { click: async () => (await import('./exporter.js?v=66fb115653')).exportHtml(state.board.rootId) } }, icon('download', { size: 14 }), 'html'),
        h('button.btn', { on: { click: async () => (await import('./readmode.js?v=66fb115653')).openReader({ print: true }) } }, icon('page', { size: 14 }), 'pdf / print')),
    ) : null,
  );
}

function currentUserName() {
  try { return document.body.dataset.user || 'signed in'; } catch { return 'signed in'; }
}

async function doBackup() {
  const v = await import('./vault.js?v=66fb115653');
  const { download } = await import('./util.js?v=66fb115653');
  const vault = await v.exportVault();
  download(`vodpad-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(vault), 'application/json');
  toast('backup saved to downloads — it is encrypted', { kind: 'ok' });
}

async function doRestore() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const v = await import('./vault.js?v=66fb115653');
      const n = await v.importVault(file);
      toast(`restored ${n} records — reloading`, { kind: 'ok' });
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      toast(err.message || 'that backup could not be read', { kind: 'error' });
    }
  });
  input.click();
}

function keysTab() {
  const rows = [
    ['ctrl + k', 'search everything'],
    ['ctrl + h', 'find and replace in this page'],
    ['ctrl + shift + b', 'page ⇄ map'],
    ['ctrl + r', 'read mode'],
    ['ctrl + \\', 'show / hide the left panel'],
    ['ctrl + shift + f', 'focus mode'],
    ['esc', 'back / close / drop the selection'],
    ['right-click', 'a menu for whatever you clicked'],
    ['shift + right-click', 'the browser\'s own menu'],
    ['/', 'insert menu (on an empty line)'],
    ['ctrl + b / i / u', 'bold, italic, underline'],
    ['ctrl + e', 'inline code'],
    ['ctrl + l', 'link this line to a picture'],
    ['ctrl + m', 'note in the margin'],
    ['ctrl + shift + t', 'floating text box'],
    ['ctrl + v', 'paste a screenshot in'],
    ['1 … 4', 'flag the page (none → costs me games)'],
    ['tab / shift + tab', 'indent, outdent'],
    ['ctrl + d', 'duplicate the block'],
    ['ctrl + z / ctrl + shift + z', 'undo, redo'],
    ['ctrl + 0', 'fit the map'],
    ['ctrl + shift + v', 'video panel'],
    ['v', 'with the vod open: show / hide the panel'],
    ['t', 'with the vod open: a new note stamped at this moment'],
    ['s', 'with the vod open: grab this frame'],
    ['shift + s', 'with the vod open: pick from the frames either side'],
    ['dbl-click', 'on the map: a new card you can type on'],
    ['tab', 'on the map: branch a card off the selected one'],
    ['alt + drag', 'on the map: drop a card inside another'],
  ];
  return h('div', h('section.gear-section',
    h('h3', { text: 'shortcuts' }),
    ...rows.map(([keys, what]) => h('div.shortcut-row',
      h('span', { text: what }),
      h('span.shortcut-keys', ...keys.split(' ').map((k) => k === '+' || k === '/' || k === '…'
        ? h('span', { text: k, style: { color: 'var(--faint)', fontSize: '11px' } })
        : h('span.kbd', { text: k }))))),
  ));
}

/* ---------------------------------------------------------------- controls */

function toggle(key, value) {
  return h('label.switch',
    h('input', { type: 'checkbox', checked: value, on: { change: (e) => setSetting(key, e.target.checked) } }),
    h('i'));
}

function slider(label, key, value, min, max, step, unit) {
  const out = h('span.setting-val', { text: `${value}${unit}` });
  const input = h('input', {
    type: 'range', min, max, step, value,
    on: {
      input: (e) => {
        const v = Number(e.target.value);
        out.textContent = `${v}${unit}`;
        state.settings[key] = v;
        applySettings();
      },
      change: (e) => setSetting(key, Number(e.target.value)),
    },
  });
  return labelled(label, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, input, out));
}

async function quit() {
  const ok = await confirmDialog({ title: 'quit vodpad?', body: 'your notes are already saved. the window will go blank — close it after.', okLabel: 'quit', danger: true });
  if (!ok) return;
  try { await api.quit(); } catch {}
  document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#9d90b8;font:14px system-ui">vodpad is closed — you can shut this window.</div>';
}

bus.on('settings', () => applySettings());
