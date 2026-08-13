/* right-click, everywhere.

   the browser's own menu is replaced by one that knows what you clicked:
   text, a picture, a pin, a margin note, a floating box, a card on the map.
   hold shift while right-clicking if you ever want the browser's menu back.
*/

import { h, fmtClock } from './util.js?v=58e76add28';
import { state, card, commit, cardTitle, deleteCard, childrenOf } from './store.js?v=58e76add28';
import { contextMenu, toast, promptDialog, confirmDialog } from './ui.js?v=58e76add28';
import { mediaUrl } from './api.js?v=58e76add28';

export function installContextMenus() {
  document.addEventListener('contextmenu', route, false);
}

async function route(e) {
  if (e.shiftKey) return;                     // escape hatch to the browser menu
  if (e.defaultPrevented) return;             // something more specific handled it

  const t = e.target;
  const at = { x: e.clientX, y: e.clientY };

  const field = t.closest?.('input, textarea');
  if (field) { e.preventDefault(); return fieldMenu(field, at); }

  const pin = t.closest?.('.img-pin');
  if (pin) { e.preventDefault(); return pinMenu(pin, at); }

  const fig = t.closest?.('.img-block');
  if (fig) { e.preventDefault(); return imageMenu(fig, at); }

  const anchor = t.closest?.('.anchor-mark');
  if (anchor) { e.preventDefault(); return anchorMenu(anchor, at); }

  const side = t.closest?.('.sidenote');
  if (side) { e.preventDefault(); return sidenoteMenu(side, at); }

  const free = t.closest?.('.freebox');
  if (free) { e.preventDefault(); return freeMenu(free, at); }

  const kid = t.closest?.('.kid-card, .subpage-block');
  if (kid) { e.preventDefault(); return subPageMenu(kid, at); }

  const node = t.closest?.('.node');
  if (node) { e.preventDefault(); return mapNodeMenu(node, at); }

  const blk = t.closest?.('.blk');
  if (blk) { e.preventDefault(); return blockMenu(blk, at); }

  if (t.closest?.('.page-title')) { e.preventDefault(); return titleMenu(at); }
  if (t.closest?.('.map-viewport')) { e.preventDefault(); return mapBackgroundMenu(e, at); }
  if (t.closest?.('#surface-page')) { e.preventDefault(); return pageBackgroundMenu(at); }
  if (t.closest?.('#surface-dash')) { e.preventDefault(); return dashMenu(at); }
}

/* ---------------------------------------------------------------- clipboard */

const selectionText = () => (getSelection()?.toString() || '');

async function pasteHere() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) document.execCommand('insertText', false, text);
  } catch {
    toast('the browser will only paste with ctrl+v — press that instead', { kind: 'warn' });
  }
}

function clipboardRows({ cut = true, paste = true } = {}) {
  const has = !!selectionText();
  return [
    { label: 'copy', icon: 'copy', hint: 'ctrl+c', disabled: !has, onPick: () => document.execCommand('copy') },
    cut ? { label: 'cut', icon: 'eraser', hint: 'ctrl+x', disabled: !has, onPick: () => document.execCommand('cut') } : null,
    paste ? { label: 'paste', icon: 'download', hint: 'ctrl+v', onPick: pasteHere } : null,
  ].filter(Boolean);
}

function fieldMenu(field, at) {
  contextMenu([
    { label: 'copy', icon: 'copy', onPick: () => document.execCommand('copy') },
    { label: 'cut', icon: 'eraser', onPick: () => document.execCommand('cut') },
    { label: 'paste', icon: 'download', onPick: async () => {
      try { field.setRangeText(await navigator.clipboard.readText(), field.selectionStart, field.selectionEnd, 'end'); }
      catch { toast('press ctrl+v', { kind: 'warn' }); }
    } },
    { sep: true },
    { label: 'select all', icon: 'grid', onPick: () => field.select() },
  ], at);
}

/* ---------------------------------------------------------------- text blocks */

const TURN = [
  ['p', 'text', 'page'], ['h1', 'heading 1', 'h1'], ['h2', 'heading 2', 'h2'], ['h3', 'heading 3', 'h3'],
  ['ul', 'bullet list', 'listUl'], ['ol', 'numbered list', 'listOl'], ['todo', 'checklist', 'listCheck'],
  ['quote', 'quote', 'quote'], ['callout', 'callout', 'callout'], ['code', 'code', 'codeTag'],
];

async function blockMenu(blk, at) {
  const ed = await import('./editor.js?v=58e76add28');
  const id = blk.dataset.id;
  const block = ed.getBlock(id);
  if (!block) return;

  const picked = ed.selectedBlockIds();
  const many = picked.length > 1 && picked.includes(id);
  const apply = (fn, all) => (many ? all() : fn());

  const isHeading = ['h1', 'h2', 'h3'].includes(block.type);

  contextMenu([
    many ? { header: `${picked.length} blocks selected` } : null,
    {
      row: [
        { icon: 'bold', tip: 'bold · ctrl+b', on: ed.isActive('bold'), onPick: () => ed.exec('bold') },
        { icon: 'italic', tip: 'italic · ctrl+i', on: ed.isActive('italic'), onPick: () => ed.exec('italic') },
        { icon: 'underline', tip: 'underline · ctrl+u', on: ed.isActive('underline'), onPick: () => ed.exec('underline') },
        { icon: 'strike', tip: 'strikethrough', on: ed.isActive('strikeThrough'), onPick: () => ed.exec('strikeThrough') },
        { icon: 'codeTag', tip: 'inline code · ctrl+e', onPick: () => ed.wrapSelection('code') },
        { icon: 'highlight', tip: 'highlight', color: 'var(--sev-1)', onPick: () => ed.wrapSelection('mark', { 'data-hl': 'amber' }) },
        { icon: 'severity', tip: 'red text', color: 'var(--accent)', onPick: () => ed.wrapSelection('span', { 'data-c': 'rose' }) },
        { icon: 'clearFmt', tip: 'clear formatting', onPick: () => ed.clearFormatting() },
      ],
    },
    { sep: true },
    {
      label: many ? `turn ${picked.length} blocks into` : 'turn into', icon: 'layers',
      sub: TURN.map(([type, label, ico]) => ({
        label, icon: ico, checked: block.type === type,
        onPick: () => apply(() => ed.setType(id, type), () => ed.setTypeOnSelection(type)),
      })),
    },
    { label: 'insert', icon: 'plus', sub: insertItems(id) },
    {
      label: 'align', icon: 'alignLeft',
      sub: [
        { label: 'left', icon: 'alignLeft', checked: !block.align || block.align === 'left', onPick: () => ed.setAlign(id, 'left') },
        { label: 'centre', icon: 'alignCenter', checked: block.align === 'center', onPick: () => ed.setAlign(id, 'center') },
        { label: 'right', icon: 'alignLeft', checked: block.align === 'right', onPick: () => ed.setAlign(id, 'right') },
      ],
    },
    isHeading ? { label: block.folded ? 'unfold this section' : 'fold this section', icon: block.folded ? 'expand' : 'collapse', onPick: () => ed.toggleFold(id) } : null,
    block.float
      ? { label: 'put it back in the text', icon: 'alignLeft', onPick: () => ed.unfloat(id, null) }
      : { label: 'float it free on the page', icon: 'textbox', hint: 'alt+drag', onPick: () => {
          const r = document.querySelector('.page-canvas').getBoundingClientRect();
          const box = document.querySelector(`.blk[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
          ed.setFloat(id, { x: Math.round(((box?.left ?? r.left + 40) - r.left)) + 24, y: Math.round(((box?.top ?? r.top + 40) - r.top)), w: 320 });
        } },
    { sep: true },
    { label: 'note in the margin', icon: 'sidenote', hint: 'ctrl+m', onPick: async () => (await import('./page.js?v=58e76add28')).addSidenoteFromSelection() },
    { label: 'link this line to a picture', icon: 'link', hint: 'ctrl+l', onPick: async () => (await import('./anchors.js?v=58e76add28')).startAnchorPick() },
    { label: 'make it a sub-page', icon: 'cards', onPick: async () => (await import('./page.js?v=58e76add28')).addSubPage(id) },
    { sep: true },
    ...clipboardRows(),
    { sep: true },
    { label: many ? `duplicate ${picked.length} blocks` : 'duplicate', icon: 'copy', hint: 'ctrl+d', onPick: () => apply(() => ed.duplicateBlock(id), () => ed.duplicateSelected()) },
    { label: 'select this block', icon: 'target', onPick: () => ed.selectBlock(id) },
    { label: many ? `delete ${picked.length} blocks` : 'delete block', icon: 'trash', danger: true, hint: 'ctrl+⌫', onPick: () => apply(() => ed.deleteBlock(id), () => ed.deleteSelected()) },
  ].filter(Boolean), { ...at, width: 232 });
}

function insertItems(afterId) {
  return [
    { label: 'picture from a file', icon: 'image', onPick: async () => (await import('./images.js?v=58e76add28')).pickImageFile(afterId) },
    { label: 'heading', icon: 'h2', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'h2' }, true); } },
    { label: 'bullet list', icon: 'listUl', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'ul' }, true); } },
    { label: 'checklist', icon: 'listCheck', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'todo' }, true); } },
    { label: 'quote', icon: 'quote', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'quote' }, true); } },
    { label: 'callout', icon: 'callout', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'callout' }, true); } },
    { label: 'code', icon: 'codeTag', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); ed.insertBlock(afterId, { type: 'code' }, true); } },
    { label: 'table', icon: 'table', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); const made = ed.insertBlock(afterId, { type: 'p' }, false); ed.setType(made.id, 'table', { rows: [['', '', ''], ['', '', ''], ['', '', '']], header: true }); } },
    { label: 'divider', icon: 'divider', onPick: async () => { const ed = await import('./editor.js?v=58e76add28'); const made = ed.insertBlock(afterId, { type: 'p' }, false); ed.setType(made.id, 'divider'); } },
    { sep: true },
    { label: 'floating text box', icon: 'textbox', hint: 'ctrl+shift+t', onPick: async () => (await import('./page.js?v=58e76add28')).addFreeBox() },
    { label: 'margin note', icon: 'sidenote', hint: 'ctrl+m', onPick: async () => (await import('./page.js?v=58e76add28')).addSidenoteFromSelection() },
    { label: 'sub-page', icon: 'cards', onPick: async () => (await import('./page.js?v=58e76add28')).addSubPage(afterId) },
    { label: 'timestamp', icon: 'clock', onPick: async () => (await import('./video.js?v=58e76add28')).insertTimestamp(afterId) },
  ];
}

/* ---------------------------------------------------------------- pictures */

async function imageMenu(fig, at) {
  const id = fig.dataset.id;
  const img = await import('./images.js?v=58e76add28');
  const block = card(state.cardId)?.blocks.find((b) => b.id === id);
  if (!block) return;

  contextMenu([
    {
      row: [
        { icon: 'pen', tip: 'draw on it', onPick: async () => (await import('./annotate.js?v=58e76add28')).openAnnotator(id) },
        { icon: 'pin', tip: 'add a numbered pin', onPick: () => img.armPin(id) },
        { icon: 'link', tip: 'link to a line of text', onPick: async () => (await import('./anchors.js?v=58e76add28')).linkImageToLine(id) },
        { icon: 'copy', tip: 'copy the picture', onPick: () => copyPicture(block) },
        { icon: 'crop', tip: 'full width', onPick: () => img.setLayout(id, 'full') },
      ],
    },
    { sep: true },
    {
      label: 'where the text goes', icon: 'alignLeft',
      sub: [
        { label: 'picture left, text right', icon: 'alignLeft', checked: block.layout === 'left', onPick: () => img.setLayout(id, 'left') },
        { label: 'picture right, text left', icon: 'alignLeft', checked: block.layout === 'right', onPick: () => img.setLayout(id, 'right') },
        { label: 'on its own line', icon: 'alignCenter', checked: (block.layout || 'center') === 'center', onPick: () => img.setLayout(id, 'center') },
        { label: 'full width', icon: 'expand', checked: block.layout === 'full', onPick: () => img.setLayout(id, 'full') },
      ],
    },
    {
      label: 'size', icon: 'fit',
      sub: [25, 35, 45, 60, 80, 100].map((pct) => ({
        label: `${pct}%`, icon: 'fit', checked: (block.width || 100) === pct, onPick: () => img.setWidth(id, pct),
      })),
    },
    { sep: true },
    { label: 'draw on it', icon: 'pen', hint: 'double-click', onPick: async () => (await import('./annotate.js?v=58e76add28')).openAnnotator(id) },
    { label: 'add a pin', icon: 'pin', onPick: () => img.armPin(id) },
    { label: 'link to a line of text', icon: 'link', onPick: async () => (await import('./anchors.js?v=58e76add28')).linkImageToLine(id) },
    { label: (block.strokes || []).length ? `clear ${block.strokes.length} drawings` : 'clear drawings', icon: 'eraser', disabled: !(block.strokes || []).length, onPick: () => img.clearStrokes(id) },
    { sep: true },
    { label: 'copy the picture', icon: 'copy', onPick: () => copyPicture(block) },
    { label: 'open the file', icon: 'folder', onPick: () => window.open(mediaUrl(state.board.id, block.src), '_blank') },
    { label: 'replace it', icon: 'upload', onPick: () => img.replacePicture(id) },
    { sep: true },
    { label: 'delete picture', icon: 'trash', danger: true, onPick: async () => (await import('./editor.js?v=58e76add28')).deleteBlock(id) },
  ], { ...at, width: 244 });
}

async function copyPicture(block) {
  try {
    const blob = await (await fetch(mediaUrl(state.board.id, block.src))).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    toast('picture copied', { kind: 'ok', ms: 1500 });
  } catch {
    toast('could not copy that one', { kind: 'error' });
  }
}

async function pinMenu(pin, at) {
  const fig = pin.closest('.img-block');
  const img = await import('./images.js?v=58e76add28');
  const blockId = fig.dataset.id;
  const pinId = pin.dataset.id;
  contextMenu([
    { label: 'write in this pin', icon: 'pen', onPick: () => pin.click() },
    { label: 'link it to a line of text', icon: 'link', onPick: async () => (await import('./anchors.js?v=58e76add28')).linkPinToLine(blockId, pinId) },
    { sep: true },
    { label: 'delete pin', icon: 'trash', danger: true, onPick: () => img.removePin(blockId, pinId) },
  ], at);
}

/* ---------------------------------------------------------------- side bits */

async function sidenoteMenu(side, at) {
  const pg = await import('./page.js?v=58e76add28');
  contextMenu([
    { label: 'edit', icon: 'pen', onPick: () => side.querySelector('.sidenote-body')?.focus() },
    ...clipboardRows(),
    { sep: true },
    { label: 'delete this margin note', icon: 'trash', danger: true, onPick: () => pg.removeSidenote(side.dataset.id) },
  ], at);
}

async function freeMenu(free, at) {
  const pg = await import('./page.js?v=58e76add28');
  contextMenu([
    { label: 'edit', icon: 'pen', onPick: () => free.querySelector('.freebox-body')?.focus() },
    { label: 'duplicate', icon: 'copy', onPick: () => pg.duplicateFreeBox(free.dataset.id) },
    ...clipboardRows(),
    { sep: true },
    { label: 'delete this box', icon: 'trash', danger: true, onPick: () => pg.removeFreeBox(free.dataset.id) },
  ], at);
}

async function anchorMenu(mark, at) {
  const anchors = await import('./anchors.js?v=58e76add28');
  contextMenu([
    { label: 'go to the picture', icon: 'image', onPick: () => mark.click() },
    { label: 'remove this link', icon: 'unlink', danger: true, onPick: () => anchors.removeAnchor(mark.dataset.anchor) },
  ], at);
}

/* ---------------------------------------------------------------- sub-pages */

function targetCardId(el) {
  if (el.classList.contains('kid-card')) {
    const kids = childrenOf(state.cardId);
    const index = [...el.parentElement.children].indexOf(el);
    return kids[index]?.id;
  }
  const blk = el.closest('.blk');
  const block = card(state.cardId)?.blocks.find((b) => b.id === blk?.dataset.id);
  return block?.cardId;
}

async function subPageMenu(el, at) {
  const id = targetCardId(el);
  const kid = card(id);
  if (!kid) return;
  const nav = await import('./nav.js?v=58e76add28');
  contextMenu([
    { label: 'open', icon: 'forward', onPick: () => nav.openCardPage(id) },
    { label: 'look inside on the map', icon: 'grid', onPick: () => nav.go({ name: 'board', boardId: state.board.id, cardId: id }) },
    { sep: true },
    { label: 'rename', icon: 'pen', onPick: async () => {
      const name = await promptDialog({ title: 'rename sub-page', value: kid.title || '' });
      if (name === null) return;
      commit('rename', (b) => { b.cards[id].title = name; });
      (await import('./page.js?v=58e76add28')).refreshPage();
    } },
    flagSub(id, kid),
    { sep: true },
    { label: 'delete sub-page', icon: 'trash', danger: true, onPick: async () => {
      if (!(await confirmDialog({ title: `delete "${cardTitle(kid)}"?`, body: 'everything inside it goes too.', okLabel: 'delete', danger: true }))) return;
      deleteCard(id);
      (await import('./page.js?v=58e76add28')).refreshPage();
    } },
  ], at);
}

function flagSub(id, target) {
  const names = ['no flag', 'working on it', 'costs me games', 'fixed — keep doing it'];
  return {
    label: 'flag', icon: 'severity',
    sub: names.map((label, lvl) => ({
      label, icon: lvl ? 'severity' : 'minus', checked: (target.severity || 0) === lvl,
      onPick: async () => {
        commit('severity', (b) => { b.cards[id].severity = lvl; });
        const pg = await import('./page.js?v=58e76add28');
        pg.refreshPage();
      },
    })),
  };
}

/* ---------------------------------------------------------------- backgrounds */

async function pageBackgroundMenu(at) {
  const ed = await import('./editor.js?v=58e76add28');
  const pg = await import('./page.js?v=58e76add28');
  const blocks = card(state.cardId)?.blocks || [];
  const lastId = blocks.at(-1)?.id;
  contextMenu([
    { label: 'new line', icon: 'plus', onPick: () => ed.insertBlock(lastId, { type: 'p' }, true) },
    { label: 'insert', icon: 'layers', sub: insertItems(lastId) },
    { sep: true },
    { label: 'floating text box here', icon: 'textbox', hint: 'ctrl+shift+t', onPick: () => pg.addFreeBox(at) },
    { label: 'picture from a file', icon: 'image', onPick: async () => (await import('./images.js?v=58e76add28')).pickImageFile(lastId) },
    { label: 'sub-page', icon: 'cards', onPick: () => pg.addSubPage(null) },
    { sep: true },
    { label: 'find in this page', icon: 'find', hint: 'ctrl+h', onPick: async () => (await import('./find.js?v=58e76add28')).openFind() },
    { label: 'select everything', icon: 'grid', onPick: () => ed.selectAllBlocks() },
    { label: 'read mode', icon: 'book', hint: 'ctrl+r', onPick: async () => (await import('./readmode.js?v=58e76add28')).openReader() },
  ], { ...at, width: 226 });
}

async function mapNodeMenu(node, at) {
  const id = node.dataset.id;
  const target = card(id);
  if (!target) return;
  const nav = await import('./nav.js?v=58e76add28');
  const canvas = await import('./canvas.js?v=58e76add28');
  contextMenu([
    { label: 'open it', icon: 'forward', hint: 'double-click', onPick: () => nav.openCardPage(id, node) },
    { label: 'look inside', icon: 'grid', onPick: () => nav.go({ name: 'board', boardId: state.board.id, cardId: id }) },
    { label: 'rename here', icon: 'pen', onPick: () => canvas.editNodeTitle(id) },
    { sep: true },
    { label: 'branch off this one', icon: 'sparkle', hint: 'tab', onPick: () => canvas.branchFrom(id) },
    flagSub(id, target),
    { sep: true },
    { label: 'duplicate', icon: 'copy', onPick: () => canvas.duplicateNode(id) },
    { label: 'delete', icon: 'trash', danger: true, onPick: async () => {
      if (!(await confirmDialog({ title: `delete "${cardTitle(target)}"?`, okLabel: 'delete', danger: true }))) return;
      deleteCard(id);
      canvas.repaint();
    } },
  ], at);
}

async function mapBackgroundMenu(e, at) {
  const canvas = await import('./canvas.js?v=58e76add28');
  contextMenu([
    { label: 'new card here', icon: 'plus', hint: 'double-click', onPick: () => canvas.addNodeAt(e.clientX, e.clientY, true) },
    { sep: true },
    { label: 'fit everything', icon: 'fit', hint: 'ctrl+0', onPick: () => canvas.fit() },
    { label: 'zoom in', icon: 'zoomIn', onPick: () => canvas.zoomBy(1.2) },
    { label: 'zoom out', icon: 'zoomOut', onPick: () => canvas.zoomBy(0.83) },
    { sep: true },
    { label: 'back to the page', icon: 'page', hint: 'ctrl+shift+b', onPick: async () => (await import('./nav.js?v=58e76add28')).toggleMap() },
  ], at);
}

async function dashMenu(at) {
  contextMenu([
    { label: 'new session', icon: 'plus', onPick: () => document.querySelector('.dash-actions .btn-primary')?.click() },
    { label: 'import a session file', icon: 'upload', onPick: async () => (await import('./transfer.js?v=58e76add28')).pickSessionFile() },
    { label: 'search everything', icon: 'search', hint: 'ctrl+k', onPick: async () => (await import('./search.js?v=58e76add28')).openPalette() },
    { sep: true },
    { label: 'settings', icon: 'gear', onPick: async () => (await import('./settings.js?v=58e76add28')).openGear() },
    { label: 'open the notes folder', icon: 'folder', onPick: async () => (await import('./api.js?v=58e76add28')).api.reveal('data') },
  ], at);
}

function titleMenu(at) {
  contextMenu([
    ...clipboardRows(),
    { sep: true },
    { label: 'rename the session', icon: 'pen', onPick: () => document.querySelector('.page-title')?.focus() },
  ], at);
}
