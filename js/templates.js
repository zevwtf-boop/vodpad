/* session templates — a new session that already has your checklist in it.

   a template is just a list of blocks. three ship with the app; anything else
   comes from `settings.templates`, saved off a page you already wrote. they
   live in settings rather than on a board so they follow the account rather
   than one session.

   NOTE for the desktop build: `server.py` whitelists settings keys against
   DEFAULT_SETTINGS on both read and write, so `templates` had to be added
   there too or it would vanish on save. cloud and vault store settings as
   free-form json. */

import { h, uid, clear } from './util.js?v=13c601f470';
import { icon } from './icons.js?v=13c601f470';
import { state, setSetting } from './store.js?v=13c601f470';
import { openModal, toast, confirmDialog, promptDialog, contextMenu } from './ui.js?v=13c601f470';

const p = (html) => ({ type: 'p', html });
const h2 = (html) => ({ type: 'h2', html });
const todo = (html) => ({ type: 'todo', html, checked: false });

export const BUILT_IN = [
  {
    id: 'blank',
    name: 'blank',
    note: 'nothing at all — an empty plane, no paper, no title',
    blocks: [],
    // blank means blank. the paper, the title and the meta row are furniture,
    // and a session that starts as a whiteboard should not have to have them
    // turned off by hand every time.
    chrome: { paper: false, title: false, meta: false, kids: false },
  },
  {
    id: 'paper',
    name: 'a page to write on',
    note: 'the paper, a title and one empty line',
    blocks: [p('')],
  },
  {
    id: 'vod',
    name: 'vod review',
    note: 'the four things worth checking every game',
    blocks: [
      h2('drop and early game'),
      todo('did the drop get contested, and was that the plan?'),
      todo('was the first rotation decided before it was needed?'),
      h2('mid game'),
      todo('any fight taken without a reason'),
      todo('loot discipline — did looting cost position?'),
      h2('endgame'),
      todo('height and cover at 20 left'),
      todo('the death: what was the actual mistake, not the last thing that happened'),
      h2('one thing to fix next game'),
      p(''),
    ],
  },
  {
    id: 'scrim',
    name: 'scrims / tournament',
    note: 'per-game log with a placement line',
    blocks: [
      h2('game log'),
      p('game 1 — placement · elims · what happened'),
      p('game 2 — '),
      p('game 3 — '),
      h2('what worked'),
      p(''),
      h2('what did not'),
      p(''),
      h2('call for next block'),
      p(''),
    ],
  },
];

/** built-ins first, then anything saved off a page. a built-in you deleted is
 *  remembered by id, so it can be put back without hunting for it. */
export const allTemplates = () => {
  const gone = new Set(state.settings.hiddenTemplates || []);
  return [...BUILT_IN.filter((t) => !gone.has(t.id)), ...(state.settings.templates || [])];
};

export const hiddenTemplateCount = () => (state.settings.hiddenTemplates || []).length;
export function restoreTemplates() {
  setSetting('hiddenTemplates', []);
  toast('the built-in templates are back', { kind: 'ok' });
}

export const templateById = (id) => allTemplates().find((t) => t.id === id) || allTemplates()[0] || BUILT_IN[0];

/** stamp a template onto a freshly created session document.
 *  a template with no blocks empties the page rather than being ignored —
 *  that is what "blank" means. */
export function applyTemplate(doc, tpl) {
  if (!tpl) return doc;
  const root = doc.cards?.[doc.rootId];
  if (!root) return doc;
  root.blocks = (tpl.blocks || []).map((b) => ({ ...b, id: uid('b'), html: b.html ?? '' }));
  // a template you wrote wants somewhere to carry on typing; an empty one does not
  if (root.blocks.length) root.blocks.push({ id: uid('b'), type: 'p', html: '' });
  if (tpl.chrome) root.chrome = { ...tpl.chrome };

  // a template can carry a board as well as a page. ids are minted fresh and
  // the lines between the boxes are re-pointed at the new ones, or the second
  // session made from the template would join boxes in the first.
  if (tpl.shapes?.length) {
    const remap = new Map();
    root.shapes = tpl.shapes.map((sh) => {
      const id = uid('sh');
      remap.set(sh.id, id);
      return { ...sh, id };
    });
    root.wires = (tpl.wires || [])
      .filter((w) => remap.has(w.from?.id) && remap.has(w.to?.id))
      .map((w) => ({
        ...w, id: uid('w'),
        from: { ...w.from, id: remap.get(w.from.id) },
        to: { ...w.to, id: remap.get(w.to.id) },
      }));
  }
  return doc;
}

/* ---------------------------------------------------------------- picking one */

/** the new-session dialog: a name and, if there is more than one, a template.
 *  resolves to {title, template} or null. */
export async function askForNewSession() {
  const suggested = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' session';
  const title = h('input.field', { value: suggested, placeholder: 'e.g. ranked trios — 09 aug', spellcheck: false });

  const list = allTemplates();
  const fallback = list.some((t) => t.id === 'paper') ? 'paper' : (list[0]?.id || 'blank');
  let picked = state.settings.lastTemplate && list.some((t) => t.id === state.settings.lastTemplate)
    ? state.settings.lastTemplate : fallback;

  const choices = h('div.tpl-choices');
  const paint = () => {
    clear(choices);
    for (const tpl of list) {
      const row = h('button.tpl-choice', {
        class: tpl.id === picked ? 'on' : '',
        on: { click: () => { picked = tpl.id; paint(); } },
      },
        h('span.tpl-tick', tpl.id === picked ? icon('check', { size: 13 }) : null),
        h('span.tpl-meat',
          h('span.tpl-name', { text: tpl.name }),
          h('span.tpl-note', { text: tpl.note || `${(tpl.blocks || []).length} lines` })),
        BUILT_IN.some((b) => b.id === tpl.id) ? null : h('span.tpl-mine', { text: 'yours' }));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const built = BUILT_IN.some((b) => b.id === tpl.id);
        contextMenu([
          { header: tpl.name },
          { label: 'rename', icon: 'pen', disabled: built, hint: built ? 'built in' : '',
            onPick: async () => { await renameTemplate(tpl); paint(); } },
          { label: built ? 'take it off the list' : 'delete this template', icon: 'trash', danger: true,
            onPick: async () => { await deleteTemplate(tpl); picked = allTemplates()[0]?.id || 'blank'; paint(); } },
          hiddenTemplateCount() ? { sep: true } : null,
          hiddenTemplateCount() ? { label: `put back ${hiddenTemplateCount()} built-in`, icon: 'undo',
            onPick: () => { restoreTemplates(); paint(); } } : null,
        ].filter(Boolean), { x: e.clientX, y: e.clientY, width: 220 });
      });
      choices.append(row);
    }
  };
  paint();

  const out = await openModal({
    title: 'new session',
    width: 460,
    body: h('div',
      h('label.gate-label', { text: 'call it' }), title,
      h('label.gate-label', { text: 'start from' }), choices),
    actions: [{ label: 'cancel', value: null }, { label: 'create', value: 'go', kind: 'primary' }],
    onMount: () => setTimeout(() => { title.focus(); title.select(); }, 30),
  });
  if (out !== 'go') return null;

  if (picked !== state.settings.lastTemplate) setSetting('lastTemplate', picked);
  return { title: title.value.trim() || suggested, template: templateById(picked) };
}

/* ---------------------------------------------------------------- making one */

/** save the page you are looking at as a template you can start from again */
export async function saveAsTemplate(c) {
  const blocks = (c.blocks || [])
    .filter((b) => b.type !== 'image' && b.type !== 'subpage')
    .map((b) => ({
      type: b.type || 'p',
      html: b.html || '',
      // a checklist saved as a template should start unticked
      ...(b.type === 'todo' ? { checked: false } : {}),
      ...(b.indent ? { indent: b.indent } : {}),
    }));

  // the board comes too. an uploaded picture belongs to this session's media
  // folder and would be a dead link in the next one, so a box keeps everything
  // except that — the built-in preset pictures are data: urls and travel fine.
  const shapes = (c.shapes || []).map((sh) => {
    const copy = { ...sh };
    delete copy.pending;
    if (copy.src && !/^data:/.test(copy.src)) { delete copy.src; delete copy.nat; }
    return copy;
  });
  const live = new Set(shapes.map((sh) => sh.id));
  const wires = (c.wires || []).filter((w) => live.has(w.from?.id) && live.has(w.to?.id));

  if (!blocks.length && !shapes.length) {
    toast('there is nothing on this page to save', { kind: 'warn' });
    return;
  }

  const name = await promptDialog({
    title: 'save this page as a template',
    value: (c.title || '').trim() || 'my checklist',
    placeholder: 'what to call it',
    okLabel: 'save it',
  });
  if (!name) return;

  const mine = state.settings.templates || [];
  const existing = mine.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (existing && !(await confirmDialog({
    title: `replace "${existing.name}"?`,
    body: 'you already have a template with that name. this overwrites it.',
    okLabel: 'replace it',
  }))) return;

  const bits = [];
  if (blocks.length) bits.push(`${blocks.length} line${blocks.length === 1 ? '' : 's'}`);
  if (shapes.length) bits.push(`${shapes.length} box${shapes.length === 1 ? '' : 'es'}`);
  const tpl = {
    id: existing?.id || uid('tpl'),
    name,
    note: `${bits.join(' · ')} · from "${(c.title || 'a page').trim()}"`,
    blocks,
    ...(shapes.length ? { shapes, wires } : {}),
    chrome: { ...(c.chrome || {}) },
  };
  const next = existing ? mine.map((t) => (t.id === tpl.id ? tpl : t)) : [...mine, tpl];
  setSetting('templates', next);
  toast(`saved — pick "${name}" when you make a session`, { kind: 'ok', ms: 4200 });
}

async function renameTemplate(tpl) {
  const name = await promptDialog({ title: 'rename template', value: tpl.name, okLabel: 'rename' });
  if (!name) return;
  setSetting('templates', (state.settings.templates || []).map((t) => (t.id === tpl.id ? { ...t, name } : t)));
}

async function deleteTemplate(tpl) {
  if (BUILT_IN.some((b) => b.id === tpl.id)) {
    setSetting('hiddenTemplates', [...new Set([...(state.settings.hiddenTemplates || []), tpl.id])]);
    toast(`"${tpl.name}" is off the list — right-click any template to put it back`, { ms: 4000 });
    return;
  }
  const ok = await confirmDialog({
    title: `delete "${tpl.name}"?`,
    body: 'sessions you already made from it are untouched — this only removes it from the list.',
    okLabel: 'delete it', danger: true,
  });
  if (!ok) return;
  setSetting('templates', (state.settings.templates || []).filter((t) => t.id !== tpl.id));
}
