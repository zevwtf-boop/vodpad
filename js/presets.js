/* preset pictures — the things you keep drawing by hand.

   marking up a vod means putting the same handful of symbols down over and
   over: where you dropped, where you died, which way you rotated, which piece
   you should have built. these are those, as pictures you drop straight onto
   the board.

   they are **vector**, and they are stored in the document as a
   `data:image/svg+xml` src rather than as an uploaded file. three reasons:
   they stay crisp at any zoom on an endless plane, they cost no round trip and
   no disk (a whole icon is about a kilobyte of text), and they work
   identically on the desktop build, the synced build and the encrypted vault
   without a single new api call. the media garbage collector and the .vodpad
   bundler both skip anything that is already a data: or http: url.

   the game symbols deliberately reuse the loot map's shapes and colours
   (`js/lootmap.js` KINDS), so a red pin means "drop here" in both places.

   everything here can be deleted, and anything you have can be added: a
   picture on the page, or a file, becomes a preset of your own that follows
   the account rather than the session.
*/

import { h, uid } from './util.js?v=2e4abb3f3d';
import { state, setSetting } from './store.js?v=2e4abb3f3d';
import { toast, confirmDialog, promptDialog } from './ui.js?v=2e4abb3f3d';
import { api, mediaUrl } from './api.js?v=2e4abb3f3d';

/* ---------------------------------------------------------------- paints */

const RED = '#e5484d';
const AMBER = '#e6a23c';
const GOLD = '#f5c451';
const GREEN = '#3aa981';
const MINT = '#5ec5a0';
const BLUE = '#5ab0e0';
const STEEL = '#7f9bd4';
const VIOLET = '#b57edc';
const GREY = '#9b9da5';
const PAPER = '#f6f8fa';

const wrap = (w, hh, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${hh}" width="${w}" height="${hh}">${inner}</svg>`;

/** a filled shape with a light rim, which is what keeps these readable on a
 *  dark board and on the light theme without drawing two versions */
const rim = (d, fill, width = 3) =>
  `<path d="${d}" fill="${fill}" stroke="${PAPER}" stroke-width="${width}" stroke-linejoin="round"/>`;

const stroke = (d, colour, width = 7, extra = '') =>
  `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;

const label = (text, x, y, size, colour = PAPER) =>
  `<text x="${x}" y="${y}" font-family="Inter, Segoe UI, system-ui, sans-serif" font-size="${size}" font-weight="700" fill="${colour}" text-anchor="middle" dominant-baseline="central">${text}</text>`;

/* ---------------------------------------------------------------- the set */

const marker = (id, name, fill, art) => ({ id: `pr-${id}`, name, group: 'markers', w: 96, h: 96, svg: wrap(96, 96, art(fill)) });

const DIAMOND = (fill) => rim('M48 8 L88 48 L48 88 L8 48 Z', fill);
const SQUARE = (fill) => rim('M14 14 h68 v68 h-68 Z', fill);

export const BUILT_IN = [
  /* ------------------------------------------------ markers: where things are */
  marker('drop', 'drop here', RED, (f) =>
    rim('M48 10a26 26 0 0 1 26 26c0 20-26 50-26 50S22 56 22 36a26 26 0 0 1 26-26z', f)
    + `<circle cx="48" cy="36" r="9" fill="${PAPER}"/>`),
  marker('chest', 'chest', AMBER, (f) => DIAMOND(f) + `<path d="M30 48 h36" stroke="${PAPER}" stroke-width="4"/><circle cx="48" cy="56" r="5" fill="${PAPER}"/>`),
  marker('gold', 'gold', GOLD, (f) => DIAMOND(f) + label('$', 48, 50, 34, '#4a3505')),
  marker('register', 'cash register', GREEN, (f) => SQUARE(f) + `<path d="M28 40 h40 M28 56 h26" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/>`),
  marker('ammo', 'ammo', STEEL, (f) => SQUARE(f) + `<path d="M36 34 v28 M48 34 v28 M60 34 v28" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/>`),
  marker('vault', 'vault', VIOLET, (f) =>
    rim('M30 10 h36 l22 38 -22 38 h-36 L8 48 Z', f)
    + `<circle cx="48" cy="48" r="12" fill="none" stroke="${PAPER}" stroke-width="5"/><path d="M48 48 l10 10" stroke="${PAPER}" stroke-width="5" stroke-linecap="round"/>`),
  marker('heals', 'heals', MINT, (f) => rim('M38 12 h20 v26 h26 v20 h-26 v26 h-20 v-26 h-26 v-20 h26 Z', f)),
  marker('vehicle', 'car', GREY, (f) =>
    `<circle cx="48" cy="48" r="40" fill="${f}" stroke="${PAPER}" stroke-width="3"/>`
    + `<path d="M24 54 l6-16h36l6 16z" fill="${PAPER}"/><circle cx="34" cy="60" r="6" fill="${PAPER}"/><circle cx="62" cy="60" r="6" fill="${PAPER}"/>`),
  marker('launch', 'launch pad', BLUE, (f) =>
    rim('M48 8 L90 84 H6 Z', f)
    + `<path d="M48 30 v34 M38 42 l10-12 10 12" stroke="${PAPER}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`),
  marker('death', 'died here', RED, () =>
    `<circle cx="48" cy="48" r="40" fill="none" stroke="${RED}" stroke-width="8"/>`
    + stroke('M30 30 L66 66 M66 30 L30 66', RED, 10)),
  marker('note', 'a note', GREY, (f) => `<circle cx="48" cy="48" r="26" fill="${f}" stroke="${PAPER}" stroke-width="4"/>`),

  /* ------------------------------------------------ calls: what happened, what to do */
  { id: 'pr-arrow', name: 'arrow', group: 'calls', w: 160, h: 96, svg: wrap(160, 96, stroke('M14 48 H132', RED, 10) + rim('M120 26 L154 48 L120 70 Z', RED, 0)) },
  { id: 'pr-rotate', name: 'rotate', group: 'calls', w: 160, h: 120, svg: wrap(160, 120, stroke('M18 100 C18 34 78 14 132 32', BLUE, 10) + rim('M112 8 L146 34 L106 48 Z', BLUE, 0)) },
  { id: 'pr-push', name: 'push', group: 'calls', w: 140, h: 96, svg: wrap(140, 96, stroke('M20 20 L60 48 L20 76 M64 20 L104 48 L64 76', RED, 12)) },
  { id: 'pr-hold', name: 'hold', group: 'calls', w: 96, h: 96, svg: wrap(96, 96, `<circle cx="48" cy="48" r="36" fill="none" stroke="${AMBER}" stroke-width="9"/><circle cx="48" cy="48" r="10" fill="${AMBER}"/>`) },
  { id: 'pr-crosshair', name: 'crosshair', group: 'calls', w: 96, h: 96, svg: wrap(96, 96, `<circle cx="48" cy="48" r="30" fill="none" stroke="${RED}" stroke-width="7"/>` + stroke('M48 2 v22 M48 72 v22 M2 48 h22 M72 48 h22', RED, 7)) },
  { id: 'pr-watch', name: 'watch this', group: 'calls', w: 120, h: 84, svg: wrap(120, 84, `<path d="M6 42s24-32 54-32 54 32 54 32-24 32-54 32S6 42 6 42z" fill="none" stroke="${BLUE}" stroke-width="8"/><circle cx="60" cy="42" r="14" fill="${BLUE}"/>`) },
  { id: 'pr-warning', name: 'mistake', group: 'calls', w: 100, h: 92, svg: wrap(100, 92, rim('M50 6 L96 86 H4 Z', AMBER, 4) + label('!', 50, 58, 40, '#3a2704')) },
  { id: 'pr-question', name: 'why?', group: 'calls', w: 96, h: 96, svg: wrap(96, 96, `<circle cx="48" cy="48" r="40" fill="${VIOLET}" stroke="${PAPER}" stroke-width="3"/>` + label('?', 48, 50, 46, '#1c1030')) },
  { id: 'pr-tick', name: 'good', group: 'calls', w: 96, h: 96, svg: wrap(96, 96, `<circle cx="48" cy="48" r="40" fill="${GREEN}" stroke="${PAPER}" stroke-width="3"/>` + stroke('M28 50 L42 64 L70 34', PAPER, 9)) },
  { id: 'pr-cross', name: 'bad', group: 'calls', w: 96, h: 96, svg: wrap(96, 96, `<circle cx="48" cy="48" r="40" fill="${RED}" stroke="${PAPER}" stroke-width="3"/>` + stroke('M32 32 L64 64 M64 32 L32 64', PAPER, 9)) },

  /* ------------------------------------------------ builds */
  { id: 'pr-wall', name: 'wall', group: 'builds', w: 96, h: 96, svg: wrap(96, 96, `<rect x="10" y="10" width="76" height="76" rx="4" fill="none" stroke="${AMBER}" stroke-width="7"/>` + stroke('M10 48 h76 M48 10 v76', AMBER, 5)) },
  { id: 'pr-ramp', name: 'ramp', group: 'builds', w: 96, h: 96, svg: wrap(96, 96, `<path d="M10 86 L86 10 L86 86 Z" fill="none" stroke="${AMBER}" stroke-width="7" stroke-linejoin="round"/>` + stroke('M48 48 L86 48 M48 48 L48 86', AMBER, 5)) },
  { id: 'pr-floor', name: 'floor', group: 'builds', w: 120, h: 80, svg: wrap(120, 80, `<path d="M28 12 h84 l-20 56 H8 Z" fill="none" stroke="${AMBER}" stroke-width="7" stroke-linejoin="round"/>` + stroke('M18 40 h84 M68 12 L48 68', AMBER, 5)) },
  { id: 'pr-cone', name: 'cone', group: 'builds', w: 96, h: 96, svg: wrap(96, 96, `<path d="M48 8 L86 86 H10 Z" fill="none" stroke="${AMBER}" stroke-width="7" stroke-linejoin="round"/>` + stroke('M29 50 h38', AMBER, 5)) },
  { id: 'pr-edit', name: 'edit', group: 'builds', w: 96, h: 96, svg: wrap(96, 96, `<rect x="10" y="10" width="76" height="76" rx="4" fill="none" stroke="${GREEN}" stroke-width="7"/><rect x="48" y="10" width="38" height="38" fill="${GREEN}" opacity=".85"/>` + stroke('M10 48 h76 M48 10 v76', GREEN, 5)) },
  { id: 'pr-wood', name: 'wood', group: 'builds', w: 88, h: 88, svg: wrap(88, 88, `<rect x="8" y="8" width="72" height="72" rx="10" fill="#a4763f" stroke="${PAPER}" stroke-width="3"/>` + stroke('M24 30 h40 M24 44 h40 M24 58 h26', '#f0dcc2', 6)) },
  { id: 'pr-brick', name: 'brick', group: 'builds', w: 88, h: 88, svg: wrap(88, 88, `<rect x="8" y="8" width="72" height="72" rx="10" fill="#9a6a63" stroke="${PAPER}" stroke-width="3"/>` + stroke('M18 34 h52 M18 54 h52 M44 18 v16 M32 34 v20 M58 54 v16', '#f3dedb', 6)) },
  { id: 'pr-metal', name: 'metal', group: 'builds', w: 88, h: 88, svg: wrap(88, 88, `<rect x="8" y="8" width="72" height="72" rx="10" fill="#6e7c88" stroke="${PAPER}" stroke-width="3"/><circle cx="30" cy="30" r="5" fill="${PAPER}"/><circle cx="58" cy="30" r="5" fill="${PAPER}"/><circle cx="30" cy="58" r="5" fill="${PAPER}"/><circle cx="58" cy="58" r="5" fill="${PAPER}"/>`) },

  /* ------------------------------------------------ zones and ground */
  { id: 'pr-storm', name: 'the circle', group: 'zones', w: 200, h: 200, svg: wrap(200, 200, `<circle cx="100" cy="100" r="92" fill="none" stroke="${VIOLET}" stroke-width="6" opacity=".85"/><circle cx="100" cy="100" r="54" fill="none" stroke="${BLUE}" stroke-width="6" stroke-dasharray="10 8"/>`) },
  { id: 'pr-pull', name: 'the pull', group: 'zones', w: 200, h: 160, svg: wrap(200, 160, `<circle cx="100" cy="86" r="70" fill="none" stroke="${VIOLET}" stroke-width="6"/>` + stroke('M30 30 L74 66', BLUE, 8) + rim('M78 74 L58 62 L70 50 Z', BLUE, 0)) },
  { id: 'pr-zone', name: 'zone', group: 'zones', w: 200, h: 140, svg: wrap(200, 140, `<rect x="8" y="8" width="184" height="124" rx="10" fill="none" stroke="${AMBER}" stroke-width="6" stroke-dasharray="14 10"/>`) },
  { id: 'pr-high', name: 'high ground', group: 'zones', w: 120, h: 110, svg: wrap(120, 110, stroke('M20 88 L60 48 L100 88 M20 62 L60 22 L100 62', GREEN, 10)) },
  { id: 'pr-compass', name: 'compass', group: 'zones', w: 120, h: 120, svg: wrap(120, 120, `<circle cx="60" cy="60" r="52" fill="none" stroke="${GREY}" stroke-width="5"/>` + rim('M60 14 L74 60 L60 50 L46 60 Z', RED, 0) + rim('M60 106 L46 60 L60 70 L74 60 Z', GREY, 0) + label('N', 60, 26, 16, PAPER)) },
  { id: 'pr-timer', name: 'timer', group: 'zones', w: 100, h: 100, svg: wrap(100, 100, `<circle cx="50" cy="54" r="40" fill="none" stroke="${BLUE}" stroke-width="8"/>` + stroke('M50 32 v24 l16 10 M38 8 h24', BLUE, 8)) },

  /* ------------------------------------------------ who is where */
  ...[1, 2, 3, 4].map((n) => ({
    id: `pr-p${n}`, name: `player ${n}`, group: 'team', w: 84, h: 84,
    svg: wrap(84, 84, `<circle cx="42" cy="42" r="36" fill="${BLUE}" stroke="${PAPER}" stroke-width="4"/>` + label(String(n), 42, 44, 38, '#08202e')),
  })),
  { id: 'pr-enemy', name: 'enemy', group: 'team', w: 84, h: 84, svg: wrap(84, 84, `<circle cx="42" cy="42" r="36" fill="${RED}" stroke="${PAPER}" stroke-width="4"/>` + stroke('M28 30 L56 54 M56 30 L28 54', PAPER, 8)) },
  { id: 'pr-squad', name: 'a squad', group: 'team', w: 130, h: 130, svg: wrap(130, 130, [[44, 44], [86, 44], [44, 86], [86, 86]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="24" fill="${RED}" stroke="${PAPER}" stroke-width="3"/>`).join('')) },
];

/** the island is not drawn here — it is whatever the current season looks
 *  like, fetched the same way the loot map fetches it. */
export const ISLAND = { id: 'pr-island', name: 'the island', group: 'map', w: 900, h: 900, island: true };

export const GROUPS = [
  ['markers', 'markers'],
  ['calls', 'calls'],
  ['builds', 'builds'],
  ['zones', 'zones'],
  ['team', 'team'],
  ['map', 'the island'],
  ['yours', 'yours'],
];

/* ---------------------------------------------------------------- the list */

const hidden = () => new Set(state.settings.hiddenPresets || []);

/** built-ins you have not deleted, then the island, then your own */
export function allPresets() {
  const gone = hidden();
  return [
    ...BUILT_IN.filter((p) => !gone.has(p.id)),
    ...(gone.has(ISLAND.id) ? [] : [ISLAND]),
    ...(state.settings.presets || []),
  ];
}

export const isBuiltIn = (id) => id === ISLAND.id || BUILT_IN.some((p) => p.id === id);
export const deletedCount = () => hidden().size;

/** what goes in the document as the picture's src */
export function presetSrc(preset) {
  if (preset.uri) return preset.uri;
  if (preset.svg) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preset.svg)}`;
  return '';
}

/* ---------------------------------------------------------------- using one */

/** put a preset on the board at a point on the plane */
export async function dropPreset(preset, planePoint) {
  const shapes = await import('./shapes.js?v=2e4abb3f3d');
  let src = presetSrc(preset);
  let size = { w: preset.w || 160, h: preset.h || 160 };

  if (preset.island) {
    const got = await api.lootmap().catch(() => null);
    if (!got?.island) { toast('could not get the island picture', { kind: 'warn' }); return null; }
    src = got.island;
    size = { w: 760, h: 760 };
  }

  const scale = preset.island ? 1 : Math.min(2.2, Math.max(1, 190 / Math.max(size.w, size.h)));
  const w = Math.round(size.w * scale);
  const hh = Math.round(size.h * scale);

  return shapes.placeShape(shapes.newShape({
    kind: 'rect', tone: 'none', fill: '#68707c',
    x: Math.round(planePoint.x - w / 2), y: Math.round(planePoint.y - hh / 2),
    w, h: hh,
    src, nat: { w: size.w, h: size.h }, fit: 'contain',
    preset: preset.id,
  }), { label: preset.name, edit: false });
}

/* ---------------------------------------------------------------- adding one

   a preset of your own is stored in settings, so it follows the account and
   turns up in every session. that means it has to be small: a picture is
   redrawn at 440px on its longest side before it is kept, which takes a 3 MB
   screenshot down to about forty kilobytes. */

const MAX_EDGE = 440;
const WARN_BYTES = 220 * 1024;

function shrink(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const hh = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = hh;
      canvas.getContext('2d').drawImage(img, 0, 0, w, hh);
      let uri = '';
      try { uri = canvas.toDataURL('image/webp', 0.86); } catch { /* fall through */ }
      if (!uri || uri.length < 40 || !uri.startsWith('data:image/webp')) uri = canvas.toDataURL('image/png');
      resolve({ uri, w, hh });
    };
    img.onerror = () => reject(new Error('that picture would not load'));
    img.src = url;
  });
}

async function keep(uri, w, hh, name) {
  if (uri.length > WARN_BYTES) {
    const ok = await confirmDialog({
      title: 'that is a big one',
      body: `it comes to ${Math.round(uri.length / 1024)} kb, and presets are stored with your settings rather than with a session. keep it anyway?`,
      okLabel: 'keep it',
    });
    if (!ok) return null;
  }
  const preset = { id: uid('pr'), name: name || 'my picture', group: 'yours', w, h: hh, uri };
  setSetting('presets', [...(state.settings.presets || []), preset]);
  toast(`"${preset.name}" is in your presets`, { kind: 'ok', ms: 2600 });
  return preset;
}

/** from a file on disk */
export async function addPresetFromFile(file) {
  if (!file?.type?.startsWith('image/')) { toast('that is not a picture', { kind: 'warn' }); return null; }
  const url = URL.createObjectURL(file);
  try {
    const { uri, w, hh } = await shrink(url);
    const name = await promptDialog({
      title: 'save it as a preset',
      value: (file.name || 'my picture').replace(/\.[a-z0-9]+$/i, ''),
      okLabel: 'save it',
    });
    if (name === null) return null;
    return await keep(uri, w, hh, name);
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return null;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

/** from a picture already in this session — the page's own right-click menu */
export async function addPresetFromSrc(src, suggested = 'my picture') {
  const url = mediaUrl(state.board?.id, src);
  if (!url) { toast('cannot read that picture', { kind: 'warn' }); return null; }
  try {
    const { uri, w, hh } = await shrink(url);
    const name = await promptDialog({ title: 'save it as a preset', value: suggested, okLabel: 'save it' });
    if (name === null) return null;
    return await keep(uri, w, hh, name);
  } catch (err) {
    toast(err.message, { kind: 'error' });
    return null;
  }
}

/** resolves once the picker is finished, so whoever asked can repaint */
export function pickPresetFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      resolve(file ? await addPresetFromFile(file) : null);
    });
    // no file chosen: the dialog closes without a change event
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    input.click();
  });
}

/* ---------------------------------------------------------------- editing the list */

export async function deletePreset(id) {
  const preset = allPresets().find((p) => p.id === id);
  if (!preset) return;
  if (isBuiltIn(id)) {
    setSetting('hiddenPresets', [...new Set([...(state.settings.hiddenPresets || []), id])]);
    toast(`"${preset.name}" removed · settings → surface puts the built-in ones back`, { ms: 3600 });
    return;
  }
  const ok = await confirmDialog({
    title: `delete "${preset.name}"?`,
    body: 'pictures you have already put on a board are untouched — this only takes it out of the list.',
    okLabel: 'delete it', danger: true,
  });
  if (!ok) return;
  setSetting('presets', (state.settings.presets || []).filter((p) => p.id !== id));
}

export async function renamePreset(id) {
  const preset = allPresets().find((p) => p.id === id);
  if (!preset) return;
  const name = await promptDialog({ title: 'rename it', value: preset.name, okLabel: 'rename' });
  if (!name) return;
  if (isBuiltIn(id)) {
    // a renamed built-in becomes one of yours, and the original steps aside
    setSetting('presets', [...(state.settings.presets || []), { ...preset, id: uid('pr'), name, group: 'yours' }]);
    setSetting('hiddenPresets', [...new Set([...(state.settings.hiddenPresets || []), id])]);
    return;
  }
  setSetting('presets', (state.settings.presets || []).map((p) => (p.id === id ? { ...p, name } : p)));
}

export function restorePresets() {
  setSetting('hiddenPresets', []);
  toast('the built-in pictures are back', { kind: 'ok' });
}
