/* boot: wake the server, load settings, paint the first surface. */

import { $, h } from './util.js?v=2e4abb3f3d';
import { icon } from './icons.js?v=2e4abb3f3d';
import { api, chooseBackend, isStatic, mode } from './api.js?v=2e4abb3f3d';
import { state, bus, boot as loadState, saveNow } from './store.js?v=2e4abb3f3d';
import { initTooltips, toast } from './ui.js?v=2e4abb3f3d';
import { go, paintChrome, back, toggleMap } from './nav.js?v=2e4abb3f3d';
import { applySettings, openGear } from './settings.js?v=2e4abb3f3d';
import { installKeys } from './keys.js?v=2e4abb3f3d';
import { installContextMenus } from './menus.js?v=2e4abb3f3d';
import { openPalette } from './search.js?v=2e4abb3f3d';
import { openReader } from './readmode.js?v=2e4abb3f3d';
import { toggleVideo } from './video.js?v=2e4abb3f3d';

import './dashboard.js?v=2e4abb3f3d';
import './canvas.js?v=2e4abb3f3d';
import './page.js?v=2e4abb3f3d';

const bootMsg = (text) => { const el = $('#boot-msg'); if (el) el.textContent = text; };

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { await api.ping(); return true; } catch { await new Promise((r) => setTimeout(r, 260)); }
  }
  return false;
}

async function start() {
  bootMsg('waking the notebook up…');
  const mode = await chooseBackend();

  if (mode === 'server') {
    if (!(await waitForServer())) {
      bootMsg('cannot reach the vodpad server — close this window and run vodpad.cmd again');
      return;
    }
  } else {
    // hosted build: sign in first, either against the worker or the local vault
    const { alreadySignedIn, whoAmI } = await import('./api.js?v=2e4abb3f3d');
    let name = (await alreadySignedIn()) ? await whoAmI() : null;
    if (!name) {
      bootMsg(mode === 'cloud' ? 'sign in to load your sessions' : 'this copy is encrypted — sign in to open it');
      document.getElementById('boot').classList.add('gone-quiet');
      const { requireLogin } = await import('./gate.js?v=2e4abb3f3d');
      name = await requireLogin();
      document.getElementById('boot').classList.remove('gone-quiet');
    }
    document.body.dataset.user = name;
    document.body.dataset.mode = mode;
  }

  bootMsg('reading your sessions…');
  await loadState();
  applySettings(state.settings);

  wireTopBar();
  initTooltips();
  installKeys();
  installContextMenus();

  await go({ name: 'dash' });

  $('#app').classList.remove('hidden');
  const splash = $('#boot');
  splash.classList.add('gone');
  setTimeout(() => splash.remove(), 400);

  // keep the local server alive while a tab is open (no-op on the hosted build)
  if (!isStatic) setInterval(() => api.ping().catch(() => {}), 120000);
  addEventListener('beforeunload', () => { try { saveNow(); } catch {} });
}

function wireTopBar() {
  $('#tb-back').append(icon('back'));
  $('#tb-search').append(icon('search'));
  $('#tb-map').append(icon('grid'));
  $('#tb-read').append(icon('book'));
  $('#tb-video').append(icon('video'));
  $('#tb-gear').append(icon('gear'));

  $('#tb-back').onclick = () => back();
  $('#tb-search').onclick = () => openPalette();
  $('#tb-map').onclick = () => toggleMap();
  $('#tb-read').onclick = () => openReader();
  $('#tb-video').onclick = () => toggleVideo();
  $('#tb-gear').onclick = () => openGear();

  bus.on('settings', (s) => applySettings(s));
  bus.on('board:open', () => paintChrome());
}

addEventListener('error', (e) => {
  console.error(e.error || e.message);
});

start().catch((err) => {
  console.error(err);
  bootMsg(`something broke while starting: ${err.message}`);
});
