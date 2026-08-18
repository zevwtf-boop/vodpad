/* what you keep getting wrong.

   you have been tagging and flagging for weeks and nothing read it back. this
   does: it counts tag against flag across every session you can see, works out
   which mistakes are getting worse and which you have actually fixed, and puts
   the ones still costing you games in one list you can open before you queue.

   pure read side. it adds no fields, changes no documents, and works on notes
   written before it existed — everything here comes out of `card.tags` and
   `card.severity`, which have been there since the first build.

   corpus.js already holds every session for the drill list and the global
   search, so this reuses that rather than fetching the world again. */

import { h, clear, fmtRel, previewOf } from './util.js?v=764fd7e397';
import { icon } from './icons.js?v=764fd7e397';
import { state, cardTitle, SEV_SHORT } from './store.js?v=764fd7e397';
import { allCards } from './corpus.js?v=764fd7e397';
import { go } from './nav.js?v=764fd7e397';
import { stagger } from './motion.js?v=764fd7e397';
import { contextMenu, toast } from './ui.js?v=764fd7e397';
import { download } from './util.js?v=764fd7e397';

const WEEK = 7 * 86400000;
const WINDOW = 14 * 86400000;      // "lately" vs "before that"

let sort = 'worst';                 // worst | recent | trend

export async function paintPatterns(body) {
  clear(body);
  body.append(h('div.dash-section',
    h('div.section-head', h('h2', { text: 'what keeps costing you' })),
    h('div.pat-list', ...[0, 1, 2].map(() => h('div.skel', { style: { height: '64px', marginBottom: '8px' } })))));

  const cards = await allCards();
  const read = digest(cards);
  clear(body);

  if (!read.tags.length) {
    body.append(emptyState(read));
    return;
  }

  body.append(
    headline(read),
    tagSection(body, read),
    weeksSection(read),
    queueSection(read),
  );
}

/* ---------------------------------------------------------------- the numbers */

/** one pass over every card, producing everything the three sections draw */
function digest(rows) {
  const now = Date.now();
  const byTag = new Map();

  const bump = (tag) => {
    if (!byTag.has(tag)) {
      byTag.set(tag, {
        tag, total: 0, sev: [0, 0, 0, 0], first: Infinity, last: 0,
        lately: 0, before: 0, cards: [],
      });
    }
    return byTag.get(tag);
  };

  const weeks = new Map();          // week start -> [n0, n1, n2, n3]
  let flagged = 0;

  for (const row of rows) {
    const c = row.card;
    const sev = Number(c.severity || 0);
    // a note's own timestamp is the honest one — sessions get reopened
    const when = c.updated || c.created || 0;
    if (sev > 0) {
      flagged++;
      const start = Math.floor(when / WEEK) * WEEK;
      if (!weeks.has(start)) weeks.set(start, [0, 0, 0, 0]);
      weeks.get(start)[sev]++;
    }

    for (const tag of c.tags || []) {
      const t = bump(tag);
      t.total++;
      t.sev[sev]++;
      if (when) {
        t.first = Math.min(t.first, when);
        t.last = Math.max(t.last, when);
        // only flagged notes count towards the trend; an untagged mention is
        // not evidence you are getting worse at anything
        if (sev === 2) {
          if (now - when <= WINDOW) t.lately++;
          else if (now - when <= WINDOW * 2) t.before++;
        }
      }
      if (sev > 0) t.cards.push(row);
    }
  }

  const tags = [...byTag.values()].map((t) => ({
    ...t,
    first: t.first === Infinity ? 0 : t.first,
    costing: t.sev[2],
    fixed: t.sev[3],
    working: t.sev[1],
    // "fixed" only means something against how often it was a problem
    progress: t.sev[2] + t.sev[3] ? t.sev[3] / (t.sev[2] + t.sev[3]) : 0,
    drift: t.lately - t.before,
  })).filter((t) => t.sev[1] + t.sev[2] + t.sev[3] > 0);

  return {
    tags: sortTags(tags),
    weeks: [...weeks.entries()].sort((a, b) => a[0] - b[0]),
    flagged,
    cards: rows,
    queue: rows.filter((r) => (r.card.severity || 0) === 2)
      .sort((a, b) => (b.card.updated || 0) - (a.card.updated || 0)),
  };
}

function sortTags(tags) {
  const by = {
    worst: (a, b) => b.costing - a.costing || b.total - a.total || a.tag.localeCompare(b.tag),
    recent: (a, b) => b.last - a.last || a.tag.localeCompare(b.tag),
    trend: (a, b) => b.drift - a.drift || b.costing - a.costing,
  };
  return tags.slice().sort(by[sort] || by.worst);
}

/* ---------------------------------------------------------------- sections */

/* one line, not a second strip of stat tiles — the dashboard already has one
   of those directly above this. */
function headline(read) {
  const rising = read.tags.filter((t) => t.drift > 0);
  const beaten = read.tags.filter((t) => t.progress >= .6 && t.fixed > 0);

  const bit = (n, label, cls = '') => h('span.pat-fact', { class: cls },
    h('b', { text: String(n) }), h('span', { text: label }));

  return h('div.pat-summary',
    bit(read.tags.length, read.tags.length === 1 ? 'habit tracked' : 'habits tracked'),
    bit(read.flagged, 'notes flagged'),
    bit(rising.length, 'getting worse', rising.length ? 'bad' : ''),
    bit(beaten.length, 'mostly beaten', beaten.length ? 'good' : ''),
    rising.length
      ? h('span.pat-callout', icon('up', { size: 13 }),
        h('span', { text: `#${rising[0].tag} is the one to look at` }))
      : beaten.length
        ? h('span.pat-callout.good', icon('check', { size: 13 }),
          h('span', { text: `#${beaten[0].tag} looks beaten` }))
        : null);
}

function tagSection(body, read) {
  const list = h('div.pat-list', ...read.tags.map((t) => tagRow(t, read)));
  requestAnimationFrame(() => stagger(Array.from(list.children), { step: 22, distance: 10 }));

  const pick = (kind, label) => h('button.pat-sort', {
    class: sort === kind ? 'on' : '',
    on: { click: () => { sort = kind; paintPatterns(body); } },
  }, label);

  return h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'the same mistakes' }),
      h('span.section-note', { text: 'every tag you have ever flagged, and whether it is going the right way' }),
      h('div.pat-sorts', pick('worst', 'worst first'), pick('trend', 'getting worse'), pick('recent', 'most recent'))),
    list);
}

function tagRow(t, read) {
  // "steady" is only honest when it has actually come up recently. a habit that
  // has not appeared in a month is quiet, which is a different thing entirely.
  const drift = t.drift > 0 ? { word: `up ${t.drift} in a fortnight`, cls: 'bad', ico: 'up' }
    : t.drift < 0 ? { word: `down ${-t.drift} in a fortnight`, cls: 'good', ico: 'down' }
    : t.lately ? { word: 'steady', cls: '', ico: 'minus' }
    : t.costing ? { word: 'not cost a game in a month', cls: 'good', ico: 'minus' }
    : null;

  const row = h('div.pat-row',
    h('div.pat-tag', h('span.pat-hash', { text: '#' }), h('span', { text: t.tag })),

    h('div.pat-meat',
      h('div.pat-bar', { tip: barTip(t) },
        t.costing ? h('i.sev-2', { style: { flex: String(t.costing) } }) : null,
        t.working ? h('i.sev-1', { style: { flex: String(t.working) } }) : null,
        t.fixed ? h('i.sev-3', { style: { flex: String(t.fixed) } }) : null),
      h('div.pat-sub', { text: [
        t.costing ? `${t.costing} still costing games` : null,
        t.working ? `${t.working} in progress` : null,
        t.fixed ? `${t.fixed} fixed` : null,
        t.last ? `last ${fmtRel(t.last)}` : null,
      ].filter(Boolean).join(' · ') })),

    drift ? h('div.pat-drift', { class: drift.cls }, icon(drift.ico, { size: 13 }),
      h('span', { text: drift.word })) : h('div.pat-drift'),

    h('button.icon-btn', {
      tip: `what to do with #${t.tag}`,
      on: { click: (e) => { e.stopPropagation(); tagMenu(t, read, e.currentTarget); } },
    }, icon('dots', { size: 15 })),
  );
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); tagMenu(t, read, null, e.clientX, e.clientY); });
  return row;
}

const barTip = (t) => [
  `#${t.tag} across ${t.total} note${t.total === 1 ? '' : 's'}`,
  t.costing ? `${t.costing} costing games` : null,
  t.working ? `${t.working} working on it` : null,
  t.fixed ? `${t.fixed} fixed` : null,
].filter(Boolean).join(' · ');

function tagMenu(t, read, anchor, x, y) {
  const worst = t.cards.filter((r) => (r.card.severity || 0) === 2)
    .sort((a, b) => (b.card.updated || 0) - (a.card.updated || 0));
  contextMenu([
    { header: `#${t.tag}` },
    worst.length ? { label: `open the newest one still costing games`, icon: 'forward',
      onPick: () => jump(worst[0]) } : null,
    { label: `see every session with #${t.tag}`, icon: 'cards',
      onPick: () => { location.hash = ''; go({ name: 'dash' }); toast(`filter the dashboard by #${t.tag} from the rail`, { ms: 4200 }); } },
    { sep: true },
    { label: 'copy these notes as a list', icon: 'copy', onPick: () => copyTag(t) },
  ].filter(Boolean), anchor ? { anchor, align: 'end', width: 280 } : { x, y, width: 280 });
}

async function copyTag(t) {
  const lines = [`#${t.tag}`, ''];
  for (const row of t.cards.sort((a, b) => (b.card.updated || 0) - (a.card.updated || 0))) {
    const sev = SEV_SHORT[row.card.severity || 0];
    lines.push(`- ${cardTitle(row.card)}${sev ? `  [${sev}]` : ''}  (${row.boardTitle})`);
    const preview = previewOf(row.card.blocks, 140);
    if (preview && preview !== cardTitle(row.card)) lines.push(`    ${preview}`);
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('copied', { kind: 'ok' });
  } catch { toast('could not reach the clipboard', { kind: 'error' }); }
}

/* ---- the last twelve weeks, as bars ---- */

function weeksSection(read) {
  const now = Math.floor(Date.now() / WEEK) * WEEK;
  const slots = [];
  for (let i = 11; i >= 0; i--) {
    const start = now - i * WEEK;
    slots.push([start, read.weeks.find(([s]) => s === start)?.[1] || [0, 0, 0, 0]]);
  }
  const tallest = Math.max(1, ...slots.map(([, n]) => n[1] + n[2] + n[3]));

  const bars = h('div.pat-weeks', ...slots.map(([start, n]) => {
    const total = n[1] + n[2] + n[3];
    const label = new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return h('div.pat-week', {
      tip: total ? `week of ${label} — ${[
        n[2] ? `${n[2]} costing games` : null,
        n[1] ? `${n[1]} working on it` : null,
        n[3] ? `${n[3]} fixed` : null,
      ].filter(Boolean).join(', ')}` : `week of ${label} — nothing flagged`,
    },
      h('div.pat-stack', { style: { height: `${(total / tallest) * 100}%` } },
        n[3] ? h('i.sev-3', { style: { flex: String(n[3]) } }) : null,
        n[1] ? h('i.sev-1', { style: { flex: String(n[1]) } }) : null,
        n[2] ? h('i.sev-2', { style: { flex: String(n[2]) } }) : null),
      h('span.pat-week-label', { text: label.split(' ')[0] }));
  }));

  return h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'the last twelve weeks' }),
      h('span.section-note', { text: 'flags per week — a tall red week is one you should go back and read' })),
    bars);
}

/* ---- the list you open before you play ---- */

function queueSection(read) {
  const rows = read.queue.slice(0, 25);
  const list = h('div.drill-list');

  if (!rows.length) {
    list.append(h('div.empty.empty-inline',
      h('div.art', icon('check', { size: 30 })),
      h('h3', { text: 'nothing is costing you games right now' }),
      h('p', { text: 'flag a note "costs me games" and it lands here, newest first.' })));
  } else {
    for (const row of rows) list.append(queueRow(row));
    requestAnimationFrame(() => stagger(Array.from(list.children), { step: 18, distance: 8 }));
  }

  return h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'before you queue' }),
      h('span.section-note', { text: read.queue.length > 25
        ? `the 25 most recent of ${read.queue.length} still costing you games`
        : 'everything still costing you games, newest first' }),
      rows.length ? h('div.section-tools',
        h('button.btn', { tip: 'save the whole list as a text file',
          on: { click: () => exportQueue(read) } }, icon('download', { size: 14 }), 'save the list')) : null),
    list);
}

function queueRow(row) {
  const preview = previewOf(row.card.blocks, 130);
  return h('button.drill-row', { on: { click: () => jump(row) } },
    h('span.drill-bar'),
    h('div.drill-meat',
      h('div.drill-title', { text: cardTitle(row.card) }),
      preview ? h('div.drill-preview', { text: preview }) : null,
      h('div.drill-meta',
        h('span', { text: row.boardTitle }),
        h('span.dot', { text: '·' }),
        h('span', { text: fmtRel(row.card.updated) }),
        ...(row.card.tags || []).slice(0, 4).map((t) => h('span.chip.chip-tag', { text: t })))),
    h('span.drill-go', icon('chevron', { size: 15 })));
}

const jump = (row) => go({ name: 'page', boardId: row.boardId, cardId: row.card.id });

function exportQueue(read) {
  const lines = [
    'vodpad — still costing me games',
    `${read.queue.length} notes · ${new Date().toLocaleDateString()}`,
    '',
  ];
  for (const row of read.queue) {
    lines.push(`${cardTitle(row.card)}`);
    const preview = previewOf(row.card.blocks, 200);
    if (preview && preview !== cardTitle(row.card)) lines.push(`  ${preview}`);
    lines.push(`  ${row.boardTitle} · ${fmtRel(row.card.updated)}`
      + ((row.card.tags || []).length ? ` · ${row.card.tags.map((t) => '#' + t).join(' ')}` : ''));
    lines.push('');
  }
  download('vodpad-drill-list.txt', lines.join('\n'));
}

/* ---------------------------------------------------------------- nothing yet */

function emptyState(read) {
  const anyTags = read.cards.some((r) => (r.card.tags || []).length);
  return h('div.empty',
    h('div.art', icon('target', { size: 34 })),
    h('h3', { text: anyTags ? 'tags, but nothing flagged yet' : 'nothing to read back yet' }),
    h('p', { text: anyTags
      ? 'this reads tags against flags. flag a few notes — press 2, 3 or 4 on a page — and it starts telling you which habits are getting worse and which you have actually beaten.'
      : 'write #tags in your notes and flag the pages that cost you the game. after a couple of sessions this page tells you what you keep doing.' }));
}
