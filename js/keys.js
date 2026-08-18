/* global shortcuts. anything typed inside a contenteditable is left alone
   unless it carries a modifier. */

import { modKey } from './util.js?v=764fd7e397';
import { state, undo, redo, saveNow } from './store.js?v=764fd7e397';
import { closeTopLayer, toast } from './ui.js?v=764fd7e397';
import { back, toggleMap, go } from './nav.js?v=764fd7e397';

const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export function installKeys() {
  document.addEventListener('keydown', async (e) => {
    // escape always peels one layer off
    if (e.key === 'Escape') {
      if (closeTopLayer()) { e.preventDefault(); return; }
      const ed = await import('./editor.js?v=764fd7e397');
      if (ed.clearBlockSelection()) { e.preventDefault(); return; }
      const img = await import('./images.js?v=764fd7e397');
      if (img.imagePicked()) { img.clearImageSelection(); e.preventDefault(); return; }
      if (isTyping()) { document.activeElement.blur(); return; }
      e.preventDefault();
      back();
      return;
    }

    const mod = modKey(e);
    const key = e.key.toLowerCase();

    if (mod && key === 'k') { e.preventDefault(); (await import('./search.js?v=764fd7e397')).openPalette(); return; }
    if (mod && key === 'f') { e.preventDefault(); (await import('./search.js?v=764fd7e397')).openPalette({ scope: 'board' }); return; }
    if (mod && key === 's') { e.preventDefault(); saveNow(); toast('saved', { kind: 'ok', ms: 1200 }); return; }

    if (mod && key === 'z' && !e.shiftKey) {
      if (state.route.name === 'dash') return;
      e.preventDefault();
      const label = undo();
      if (label) toast(`undid ${label}`, { ms: 1400 });
      return;
    }
    if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
      if (state.route.name === 'dash') return;
      e.preventDefault();
      const label = redo();
      if (label) toast(`redid ${label}`, { ms: 1400 });
      return;
    }

    if (state.route.name === 'dash') {
      if (!isTyping() && key === 'n') { e.preventDefault(); document.querySelector('.dash-actions .btn-primary')?.click(); }
      return;
    }

    // ---- inside a session
    if (mod && key === 'b' && e.shiftKey === false && !isTyping()) { e.preventDefault(); toggleMap(); return; }
    if (mod && key === 'b' && isTyping()) return;                     // bold, handled by the editor
    if (mod && e.shiftKey && key === 'b') { e.preventDefault(); toggleMap(); return; }
    if (mod && key === 'r') { e.preventDefault(); (await import('./readmode.js?v=764fd7e397')).openReader(); return; }
    if (mod && e.shiftKey && key === 'v') { e.preventDefault(); (await import('./video.js?v=764fd7e397')).toggleVideo(); return; }
    if (mod && key === '0') {
      e.preventDefault();
      if (state.route.name === 'board') (await import('./canvas.js?v=764fd7e397')).fit();
      else (await import('./page.js?v=764fd7e397')).resetPageZoom();
      return;
    }
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); const pg = await import('./page.js?v=764fd7e397'); pg.setPageZoom(pg.pageZoom() * 1.1); return; }
    if (mod && key === '-') { e.preventDefault(); const pg = await import('./page.js?v=764fd7e397'); pg.setPageZoom(pg.pageZoom() * 0.909); return; }

    if (mod && key === 'h') { e.preventDefault(); (await import('./find.js?v=764fd7e397')).openFind(String(getSelection() || '').slice(0, 60)); return; }
    if (mod && key === '\\') { e.preventDefault(); (await import('./page.js?v=764fd7e397')).toggleSidebar(); return; }
    if (mod && e.shiftKey && key === 'f') { e.preventDefault(); (await import('./page.js?v=764fd7e397')).toggleFocusMode(); return; }
    if (mod && key === 'l') { e.preventDefault(); (await import('./anchors.js?v=764fd7e397')).startAnchorPick(); return; }
    if (mod && key === 'm') { e.preventDefault(); (await import('./page.js?v=764fd7e397')).addSidenoteFromSelection(); return; }
    if (mod && e.shiftKey && key === 't') { e.preventDefault(); (await import('./page.js?v=764fd7e397')).addFreeBox(); return; }

    if (mod && key === 'd') {
      const ed = await import('./editor.js?v=764fd7e397');
      const id = ed.currentBlockId();
      if (id) { e.preventDefault(); ed.duplicateBlock(id); }
      return;
    }
    if (mod && e.key === 'Backspace') {
      const ed = await import('./editor.js?v=764fd7e397');
      const id = ed.currentBlockId();
      if (id) { e.preventDefault(); ed.deleteBlock(id); }
      return;
    }

    if (!isTyping()) {
      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const { setSeverity } = await import('./page.js?v=764fd7e397');
        setSeverity(state.cardId, Number(e.key) - 1);
        return;
      }
      if (key === 't') { e.preventDefault(); (await import('./video.js?v=764fd7e397')).stampNote(); return; }
      if (key === 's') {
        e.preventDefault();
        const vid = await import('./video.js?v=764fd7e397');
        // shift+s when you noticed the mistake half a second too late
        if (e.shiftKey) vid.pickFrame(); else vid.grabFrame();
        return;
      }
      if (key === 'v') { e.preventDefault(); (await import('./video.js?v=764fd7e397')).toggleVideo(); return; }
    }
  });
}
