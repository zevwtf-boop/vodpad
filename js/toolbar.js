/* two contextual surfaces instead of a top ribbon:
   - a toolbar that springs up when you select text
   - a "/" menu that inserts anything
*/

import { $, h, clamp, uid, debounce } from './util.js?v=d258d51ea6';
import { icon } from './icons.js?v=d258d51ea6';
import { state } from './store.js?v=d258d51ea6';
import { popIn, popOut } from './motion.js?v=d258d51ea6';
import { promptDialog, toast, popover, pushLayer, dropLayer } from './ui.js?v=d258d51ea6';

let selBar = null;
let barVisible = false;

/* ---------------------------------------------------------------- selection toolbar */

export function initSelectionToolbar() {
  selBar = $('#seltoolbar');
  document.addEventListener('selectionchange', debounce(update, 60));
  document.addEventListener('scroll', () => hide(), true);
  window.addEventListener('resize', () => hide());
  document.addEventListener('mousedown', (e) => { if (selBar && !selBar.contains(e.target)) hide(); }, true);
}

async function update() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
  const node = sel.anchorNode;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const body = el?.closest('.blk-body, .sidenote-body, .freebox-body');
  if (!body || !sel.toString().trim()) return hide();

  const editor = await import('./editor.js?v=d258d51ea6');
  if (!barVisible) build(editor);
  paintStates(editor);

  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selBar.hidden = false;
  const box = selBar.getBoundingClientRect();
  let top = rect.top - box.height - 9;
  if (top < 54) top = rect.bottom + 9;
  selBar.style.left = `${clamp(rect.left + rect.width / 2 - box.width / 2, 8, innerWidth - box.width - 8)}px`;
  selBar.style.top = `${top}px`;
  if (!barVisible) popIn(selBar, { origin: 'center bottom', duration: 150 });
  barVisible = true;
}

function hide() {
  if (!barVisible || !selBar) return;
  barVisible = false;
  popOut(selBar, { duration: 110 }).then(() => { if (!barVisible) selBar.hidden = true; });
}

function build(editor) {
  selBar.innerHTML = '';
  const btn = (name, ico, tip, run) => h('button.tb-btn', {
    tip, data: { cmd: name },
    on: { mousedown: (e) => e.preventDefault(), click: () => { run(); paintStates(editor); } },
  }, icon(ico, { size: 15 }));

  selBar.append(
    h('button.tb-btn.tb-turn', {
      tip: 'turn into',
      on: { mousedown: (e) => e.preventDefault(), click: (e) => turnMenu(e.currentTarget, editor) },
    }, icon('page', { size: 15 }), icon('caret', { size: 12 })),
    h('span.tb-sep'),
    btn('bold', 'bold', 'bold · ctrl+b', () => editor.exec('bold')),
    btn('italic', 'italic', 'italic · ctrl+i', () => editor.exec('italic')),
    btn('underline', 'underline', 'underline · ctrl+u', () => editor.exec('underline')),
    btn('strikeThrough', 'strike', 'strikethrough · ctrl+shift+x', () => editor.exec('strikeThrough')),
    btn('code', 'codeTag', 'inline code · ctrl+e', () => editor.wrapSelection('code')),
    h('span.tb-sep'),
    h('button.tb-btn', {
      tip: 'highlight',
      on: { mousedown: (e) => e.preventDefault(), click: (e) => colorMenu(e.currentTarget, editor) },
    }, icon('highlight', { size: 15 })),
    btn('link', 'link', 'link · ctrl+shift+k', () => addLink(editor)),
    h('button.tb-btn', {
      tip: 'link this line to a picture · ctrl+l',
      on: { mousedown: (e) => e.preventDefault(), click: () => linkToPicture() },
    }, icon('image', { size: 15 })),
    h('button.tb-btn', {
      tip: 'note in the margin · ctrl+m',
      on: { mousedown: (e) => e.preventDefault(), click: () => addSidenote() },
    }, icon('sidenote', { size: 15 })),
    h('span.tb-sep'),
    btn('removeFormat', 'clearFmt', 'clear formatting', () => editor.clearFormatting()),
  );
}

function paintStates(editor) {
  for (const b of selBar.querySelectorAll('.tb-btn[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (['bold', 'italic', 'underline', 'strikeThrough'].includes(cmd)) b.classList.toggle('on', editor.isActive(cmd));
  }
}

function turnMenu(anchor, editor) {
  const id = editor.currentBlockId();
  const rows = [
    ['p', 'text', 'page'], ['h1', 'heading 1', 'h1'], ['h2', 'heading 2', 'h2'], ['h3', 'heading 3', 'h3'],
    ['ul', 'bullet list', 'listUl'], ['ol', 'numbered list', 'listOl'], ['todo', 'checklist', 'listCheck'],
    ['quote', 'quote', 'quote'], ['callout', 'callout', 'callout'], ['code', 'code', 'codeTag'],
  ];
  const list = h('div.pop-list', ...rows.map(([type, label, ico]) => h('button.menu-row', {
    on: {
      mousedown: (e) => e.preventDefault(),
      click: () => { editor.setType(id, type); import('./ui.js?v=d258d51ea6').then((m) => m.closePopover()); },
    },
  }, h('span.menu-ico', icon(ico, { size: 15 })), h('span.menu-label', { text: label }))));
  popover(list, { anchor, width: 190 });
}

function colorMenu(anchor, editor) {
  const swatches = [
    ['amber', 'var(--sev-1)'], ['rose', 'var(--sev-2)'], ['mint', 'var(--sev-3)'], ['lilac', 'var(--accent)'],
  ];
  const keep = (e) => e.preventDefault();          // don't let the click drop the selection
  const wrap = h('div.color-pop',
    h('div.color-label', { text: 'highlight' }),
    h('div.color-row', ...swatches.map(([name, css]) => h('button.color-dot', {
      style: { background: css }, tip: name,
      on: { mousedown: keep, click: () => { editor.wrapSelection('mark', { 'data-hl': name }); import('./ui.js?v=d258d51ea6').then((m) => m.closePopover()); } },
    }))),
    h('div.color-label', { text: 'text' }),
    h('div.color-row', ...swatches.map(([name, css]) => h('button.color-dot.color-ring', {
      style: { color: css }, tip: name,
      on: { mousedown: keep, click: () => { editor.wrapSelection('span', { 'data-c': name }); import('./ui.js?v=d258d51ea6').then((m) => m.closePopover()); } },
    }, h('i', { style: { background: css } })))),
    h('button.btn.btn-sm.btn-ghost', {
      on: { mousedown: keep, click: () => { editor.clearFormatting(); import('./ui.js?v=d258d51ea6').then((m) => m.closePopover()); } },
    }, 'clear'),
  );
  popover(wrap, { anchor, width: 188 });
}

async function addLink(editor) {
  const sel = getSelection();
  const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const url = await promptDialog({ title: 'link to', placeholder: 'https://…', okLabel: 'link' });
  if (!url) return;
  if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
  editor.wrapSelection('a', { href: /^https?:/i.test(url) ? url : `https://${url}`, target: '_blank', rel: 'noreferrer' });
}

async function linkToPicture() {
  const { startAnchorPick } = await import('./anchors.js?v=d258d51ea6');
  startAnchorPick();
}

async function addSidenote() {
  const { addSidenoteFromSelection } = await import('./page.js?v=d258d51ea6');
  addSidenoteFromSelection();
}

/* ---------------------------------------------------------------- slash menu */

let slash = null;

export const slashOpen = () => !!slash;

const SLASH_ITEMS = [
  { id: 'p', label: 'text', ico: 'page', keys: 'text paragraph body' },
  { id: 'h1', label: 'heading 1', ico: 'h1', keys: 'title big head' },
  { id: 'h2', label: 'heading 2', ico: 'h2', keys: 'subtitle head' },
  { id: 'h3', label: 'heading 3', ico: 'h3', keys: 'small head' },
  { id: 'ul', label: 'bullet list', ico: 'listUl', keys: 'bullet unordered dash' },
  { id: 'ol', label: 'numbered list', ico: 'listOl', keys: 'ordered number' },
  { id: 'todo', label: 'checklist', ico: 'listCheck', keys: 'todo task check box' },
  { id: 'quote', label: 'quote', ico: 'quote', keys: 'blockquote cite' },
  { id: 'callout', label: 'callout', ico: 'callout', keys: 'note info warning box' },
  { id: 'code', label: 'code', ico: 'codeTag', keys: 'code snippet mono' },
  { id: 'divider', label: 'divider', ico: 'divider', keys: 'line rule hr separator' },
  { id: 'table', label: 'table', ico: 'table', keys: 'grid rows columns' },
  { sep: 'insert' },
  { id: 'image', label: 'picture', ico: 'image', keys: 'image screenshot photo paste' },
  { id: 'sidenote', label: 'margin note', ico: 'sidenote', keys: 'sidenote margin comment beside' },
  { id: 'textbox', label: 'floating text box', ico: 'textbox', keys: 'free text anywhere loose label' },
  { id: 'timestamp', label: 'timestamp', ico: 'clock', keys: 'time vod clip moment' },
  { id: 'subpage', label: 'sub-page', ico: 'cards', keys: 'child page nest expand topic' },
];

export function openSlashMenu(body, blockId) {
  closeSlashMenu();
  const menu = $('#slashmenu');
  menu.hidden = false;
  slash = { body, blockId, index: 0, query: '', menu };

  paintSlash();
  place();

  const onKey = (e) => {
    if (!slash) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(); return; }
    setTimeout(() => {
      if (!slash) return;
      const text = slash.body.textContent || '';
      if (!text.startsWith('/')) return closeSlashMenu();
      slash.query = text.slice(1);
      slash.index = 0;
      paintSlash();
      place();
    }, 0);
  };
  document.addEventListener('keydown', onKey, true);
  slash.detach = () => document.removeEventListener('keydown', onKey, true);
  slash.layer = pushLayer(closeSlashMenu);
  popIn(menu, { origin: 'left top', duration: 140 });
}

export function closeSlashMenu() {
  if (!slash) return;
  const { menu, detach, layer } = slash;
  detach?.();
  layer?.();
  slash = null;
  popOut(menu, { duration: 100 }).then(() => { if (!slash) menu.hidden = true; });
}

function filtered() {
  const q = slash.query.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((it) => !it.sep && (it.label.includes(q) || it.keys.includes(q)));
}

function paintSlash() {
  const items = filtered();
  slash.items = items.filter((i) => !i.sep);
  slash.menu.innerHTML = '';
  if (!slash.items.length) {
    slash.menu.append(h('div.slash-empty', { text: 'nothing matches' }));
    return;
  }
  for (const item of items) {
    if (item.sep) { slash.menu.append(h('div.menu-header', { text: item.sep })); continue; }
    const i = slash.items.indexOf(item);
    slash.menu.append(h('button.menu-row', {
      class: i === slash.index ? 'here' : '',
      on: { mousedown: (e) => e.preventDefault(), click: () => { slash.index = i; pick(); }, mouseenter: () => { slash.index = i; paintSlash(); } },
    }, h('span.menu-ico', icon(item.ico, { size: 15 })), h('span.menu-label', { text: item.label })));
  }
}

function move(delta) {
  slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
  paintSlash();
  const here = slash.menu.querySelector('.here');
  here?.scrollIntoView({ block: 'nearest' });
}

function place() {
  const sel = getSelection();
  const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : slash.body.getBoundingClientRect();
  const menu = slash.menu;
  menu.style.left = '0px'; menu.style.top = '0px';
  const box = menu.getBoundingClientRect();
  let top = rect.bottom + 8;
  if (top + box.height > innerHeight - 10) top = rect.top - box.height - 8;
  menu.style.left = `${clamp(rect.left, 10, innerWidth - box.width - 10)}px`;
  menu.style.top = `${clamp(top, 56, innerHeight - box.height - 10)}px`;
}

async function pick() {
  if (!slash) return;
  const item = slash.items[slash.index];
  const { blockId, body } = slash;
  closeSlashMenu();
  if (!item) return;

  body.innerHTML = '';                            // drop the "/query" text
  const editor = await import('./editor.js?v=d258d51ea6');
  editor.exec('delete');                          // keep the model in step
  const block = editor.getBlock(blockId);
  if (block) block.html = '';

  switch (item.id) {
    case 'divider':
      editor.setType(blockId, 'divider');
      editor.insertBlock(blockId, { type: 'p' }, true);
      break;
    case 'table':
      editor.setType(blockId, 'table', { rows: [['', '', ''], ['', '', ''], ['', '', '']], header: true });
      break;
    case 'image': {
      const { pickImageFile } = await import('./images.js?v=d258d51ea6');
      pickImageFile(blockId);
      break;
    }
    case 'sidenote': {
      const { addSidenoteFromSelection } = await import('./page.js?v=d258d51ea6');
      editor.focusBlock(blockId, 'end');
      addSidenoteFromSelection();
      break;
    }
    case 'textbox': {
      const { addShape } = await import('./shapes.js?v=d258d51ea6');
      addShape({ kind: 'rect', tone: 'text', align: 'left', valign: 'top', w: 240, h: 60 });
      break;
    }
    case 'timestamp': {
      const { insertTimestamp } = await import('./video.js?v=d258d51ea6');
      insertTimestamp(blockId);
      break;
    }
    case 'subpage': {
      const { addSubPage } = await import('./page.js?v=d258d51ea6');
      addSubPage(blockId);
      break;
    }
    default:
      editor.setType(blockId, item.id);
  }
}
