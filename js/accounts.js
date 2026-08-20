/* who has an account, and the codes that let anyone get one.

   admin-only, and only on the synced build — the desktop app has no accounts
   and the browser-only vault bakes its two or three into users.json at build
   time. dashboard.js only ever reaches for this when both are true.

   there is no open signup anywhere in vodpad. an account exists because
   somebody generated a code here and handed it over, which is the whole point
   of this screen. */

import { h, clear, fmtRel, fmtDate, fmtBytes, download } from './util.js?v=2e4abb3f3d';
import { icon } from './icons.js?v=2e4abb3f3d';
import { adminApi } from './api.js?v=2e4abb3f3d';
import { state } from './store.js?v=2e4abb3f3d';
import { toast, contextMenu, confirmDialog, openModal, segmented } from './ui.js?v=2e4abb3f3d';
import { stagger } from './motion.js?v=2e4abb3f3d';

let data = null;          // {accounts, invites, totals}
let loading = null;
let repaint = () => {};

/** dashboard.js hands us the body element and a way to ask for a redraw */
export async function paintAccounts(body, onNeedsBoards) {
  repaint = () => paintAccounts(body, onNeedsBoards);
  const admin = await adminApi();
  if (!admin) {
    clear(body);
    body.append(h('div.empty',
      h('div.art', icon('users', { size: 34 })),
      h('h3', { text: 'no accounts in this copy' }),
      h('p', { text: 'accounts only exist on the synced build. this one keeps everything in front of you and asks nobody who they are.' })));
    return;
  }

  if (!data) {
    clear(body);
    body.append(h('div.dash-section',
      h('div.section-head', h('h2', { text: 'accounts' })),
      h('div.acct-list', ...[0, 1, 2].map(() => h('div.skel', { style: { height: '58px', marginBottom: '8px' } })))));
    try {
      loading = loading || admin.accounts();
      data = await loading;
    } catch (err) {
      clear(body);
      body.append(h('div.empty',
        h('div.art', icon('users', { size: 34 })),
        h('h3', { text: 'could not read the accounts' }),
        h('p', { text: err.message })));
      return;
    } finally { loading = null; }
  }

  clear(body);
  body.append(
    totalsStrip(),
    accountsSection(admin, onNeedsBoards),
    invitesSection(admin),
  );
}

/** call after anything that changes the picture */
export async function refreshAccounts() {
  data = null;
  await repaint();
}

export function forgetAccounts() { data = null; }

/* ---------------------------------------------------------------- totals */

function totalsStrip() {
  const t = data.totals || {};
  const tile = (label, value, ico) => h('div.stat-tile',
    h('div.stat-ico', icon(ico, { size: 16 })),
    h('div.stat-meat', h('div.stat-num', { text: String(value) }), h('div.stat-label', { text: label })));

  return h('div.stats-strip.acct-totals',
    tile('accounts', t.accounts ?? 0, 'users'),
    tile('sessions in total', t.boards ?? 0, 'cards'),
    tile('codes still live', t.live ?? 0, 'ticket'),
    tile('screenshots stored', fmtBytes(t.bytes || 0), 'image'));
}

/* ---------------------------------------------------------------- accounts */

function accountsSection(admin, onNeedsBoards) {
  const list = h('div.acct-list', ...data.accounts.map((a) => accountRow(a, admin, onNeedsBoards)));
  requestAnimationFrame(() => stagger(Array.from(list.children), { step: 24, distance: 10 }));

  return h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'accounts' }),
      h('span.section-note', { text: 'everyone who can sign in to this copy of vodpad' }),
      h('div.section-tools',
        h('button.btn', { on: { click: () => refreshAccounts() } }, icon('rotate', { size: 14 }), 'refresh'),
        h('button.btn.btn-primary', { on: { click: () => newInvite(admin) } }, icon('userPlus', { size: 15 }), 'invite someone'))),
    list);
}

function accountRow(a, admin, onNeedsBoards) {
  const you = a.name === state.user;
  const row = h('div.acct-row', { class: a.disabled ? 'off' : '' },
    h('div.acct-face', { text: a.name.slice(0, 1).toUpperCase() }),

    h('div.acct-who',
      h('div.acct-name',
        h('span', { text: a.name }),
        you ? h('span.chip.chip-you', { text: 'you' }) : null,
        a.admin ? h('span.chip.chip-admin', { tip: 'sees and edits every account’s sessions' },
          icon('shield', { size: 11 }), 'admin') : null,
        a.disabled ? h('span.chip.chip-off', { tip: 'cannot sign in' }, icon('power', { size: 11 }), 'switched off') : null),
      h('div.acct-sub', { text: joinDots([
        a.created ? `joined ${fmtDate(a.created)}` : null,
        a.seen ? `last here ${fmtRel(a.seen)}` : 'never signed in',
        a.invite ? `on code ${a.invite}` : 'here from the start',
      ]) })),

    h('div.acct-nums',
      num(a.boards, 'sessions'),
      num(a.notes, 'notes'),
      num(a.shots, 'shots'),
      num(fmtBytes(a.bytes || 0), 'stored')),

    h('button.acct-more.icon-btn', {
      tip: 'what you can do to this account',
      on: { click: (e) => { e.stopPropagation(); accountMenu(a, admin, onNeedsBoards, e.currentTarget); } },
    }, icon('dots', { size: 15 })),
  );
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    accountMenu(a, admin, onNeedsBoards, null, e.clientX, e.clientY);
  });
  return row;
}

const num = (value, label) => h('div.acct-num',
  h('b', { text: String(value) }), h('span', { text: label }));

const joinDots = (bits) => bits.filter(Boolean).join(' · ');

function accountMenu(a, admin, onNeedsBoards, anchor, x, y) {
  const you = a.name === state.user;
  contextMenu([
    { header: a.name },
    a.boards ? { label: `see their ${a.boards} session${a.boards === 1 ? '' : 's'}`, icon: 'cards',
      onPick: () => onNeedsBoards(a.name) } : null,
    { label: 'give them a reset code', icon: 'key', hint: 'password',
      onPick: () => newInvite(admin, { reset: a.name }) },
    { sep: true },
    you ? null : {
      label: a.admin ? 'take admin away' : 'make them an admin',
      icon: 'shield',
      onPick: () => setAdmin(a, admin),
    },
    you ? null : {
      label: a.disabled ? 'let them back in' : 'switch this account off',
      icon: 'power',
      onPick: () => setDisabled(a, admin),
    },
    you ? null : { sep: true },
    you ? null : { label: 'delete the account and everything in it', icon: 'trash', danger: true,
      onPick: () => removeAccount(a, admin) },
    you ? { label: 'this is you — sign out from settings instead', icon: 'user', disabled: true } : null,
  ].filter(Boolean), anchor ? { anchor, align: 'end', width: 268 } : { x, y, width: 268 });
}

async function setAdmin(a, admin) {
  const ok = a.admin || await confirmDialog({
    title: `make ${a.name} an admin?`,
    body: 'an admin sees, opens, edits, renames, shares and deletes every account’s sessions, '
      + 'including yours, and can hand out invite codes of their own. there is no read-only version of it.',
    okLabel: 'make them an admin',
  });
  if (!ok) return;
  try {
    await admin.patchAccount(a.name, { admin: !a.admin });
    toast(a.admin ? `${a.name} is an ordinary account again` : `${a.name} is an admin now`, { kind: 'ok' });
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

async function setDisabled(a, admin) {
  const ok = a.disabled || await confirmDialog({
    title: `switch ${a.name} off?`,
    body: 'they are signed out everywhere straight away and cannot sign back in. their sessions '
      + 'stay exactly where they are and you can switch them back on whenever.',
    okLabel: 'switch it off', danger: true,
  });
  if (!ok) return;
  try {
    await admin.patchAccount(a.name, { disabled: !a.disabled });
    toast(a.disabled ? `${a.name} can sign in again` : `${a.name} is switched off`, { kind: 'ok' });
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

async function removeAccount(a, admin) {
  const ok = await confirmDialog({
    title: `delete ${a.name}?`,
    body: `this deletes the account and all ${a.boards} of their session${a.boards === 1 ? '' : 's'}, `
      + 'every screenshot in them, and their settings. it cannot be undone and there is no trash folder '
      + 'in the cloud. switching the account off keeps everything and locks them out just as well.',
    okLabel: `delete ${a.name} and their work`, danger: true,
  });
  if (!ok) return;
  try {
    const res = await admin.deleteAccount(a.name);
    toast(`${a.name} deleted · ${res.boards || 0} sessions gone`, { kind: 'ok' });
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

/* ---------------------------------------------------------------- invites */

function invitesSection(admin) {
  const live = data.invites.filter((i) => !i.spent);
  const spent = data.invites.filter((i) => i.spent);

  const list = h('div.code-list');
  if (!data.invites.length) {
    list.append(h('div.empty.empty-inline',
      h('div.art', icon('ticket', { size: 30 })),
      h('h3', { text: 'no codes yet' }),
      h('p', { text: 'nobody can make an account until you generate one. a code is one line of text you '
        + 'send someone; they paste it into the create account tab and pick their own password.' })));
  } else {
    for (const inv of live) list.append(codeRow(inv, admin));
    if (spent.length) {
      list.append(h('div.code-past-head',
        h('span', { text: `used up and cancelled (${spent.length})` })));
      for (const inv of spent) list.append(codeRow(inv, admin));
    }
  }

  return h('div.dash-section',
    h('div.section-head',
      h('h2', { text: 'invite codes' }),
      h('span.section-note', { text: 'the only way anyone gets an account' }),
      h('div.section-tools',
        data.invites.length ? h('button.btn', {
          tip: 'save every code and who used it, as a text file',
          on: { click: exportCodes },
        }, icon('download', { size: 14 }), 'export') : null,
        h('button.btn.btn-primary', { on: { click: () => newInvite(admin) } },
          icon('plus', { size: 15 }), 'generate a code'))),
    list);
}

function codeRow(inv, admin) {
  const status = inv.revoked ? { text: 'cancelled', cls: 'dead' }
    : inv.expires && inv.expires < Date.now() ? { text: 'expired', cls: 'dead' }
    : inv.uses >= inv.maxUses ? { text: 'used', cls: 'dead' }
    : inv.maxUses > 1 ? { text: `${inv.maxUses - inv.uses} of ${inv.maxUses} left`, cls: 'live' }
    : { text: 'unused', cls: 'live' };

  const row = h('div.code-row', { class: inv.spent ? 'spent' : '' },
    h('button.code-chip', {
      tip: 'copy it',
      on: { click: () => copyCode(inv.code) },
    }, h('span.code-text', { text: inv.code }), icon('copy', { size: 13 })),

    h('div.code-meat',
      h('div.code-line',
        h('span.code-kind', { class: inv.reset ? 'reset' : inv.admin ? 'admin' : '' },
          icon(inv.reset ? 'key' : inv.admin ? 'shield' : 'userPlus', { size: 11 }),
          inv.reset ? `password reset for ${inv.reset}` : inv.admin ? 'makes an admin' : 'makes an account'),
        h('span.code-status', { class: status.cls, text: status.text })),
      h('div.code-sub', { text: joinDots([
        inv.note || null,
        `made by ${inv.maker} ${fmtRel(inv.created)}`,
        inv.expires ? `runs out ${fmtDate(inv.expires)}` : null,
        inv.takenBy.length ? `used by ${inv.takenBy.map((u) => u.user).join(', ')}` : null,
      ]) })),

    h('button.icon-btn', {
      tip: 'what you can do with this code',
      on: { click: (e) => { e.stopPropagation(); codeMenu(inv, admin, e.currentTarget); } },
    }, icon('dots', { size: 15 })),
  );
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); codeMenu(inv, admin, null, e.clientX, e.clientY); });
  return row;
}

function codeMenu(inv, admin, anchor, x, y) {
  contextMenu([
    { header: inv.code },
    { label: 'copy the code', icon: 'copy', onPick: () => copyCode(inv.code) },
    { label: 'copy it with the joining instructions', icon: 'page', onPick: () => copyInviteBlurb(inv) },
    { sep: true },
    { label: inv.revoked ? 'put it back in service' : 'cancel this code', icon: inv.revoked ? 'undo' : 'close',
      onPick: () => toggleRevoked(inv, admin) },
    { label: 'delete the record of it', icon: 'trash', danger: true, onPick: () => dropCode(inv, admin) },
  ], anchor ? { anchor, align: 'end', width: 250 } : { x, y, width: 250 });
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast('code copied', { kind: 'ok' });
  } catch {
    // clipboard access can be refused; show it so it can still be read out
    toast(code, { ms: 9000 });
  }
}

function inviteBlurb(inv) {
  const where = location.origin + location.pathname;
  return inv.reset
    ? `your vodpad password can be reset with this code:\n\n  ${inv.code}\n\n`
      + `open ${where}, click "create account", paste the code in, and it will ask you `
      + 'for a new password. the code works once.'
    : `you have been invited to vodpad.\n\n  ${inv.code}\n\n`
      + `open ${where}, click "create account", paste the code in and pick a username and password. `
      + 'nobody can look your password up afterwards, so keep it somewhere.';
}

async function copyInviteBlurb(inv) {
  try {
    await navigator.clipboard.writeText(inviteBlurb(inv));
    toast('copied — paste it straight into a message', { kind: 'ok' });
  } catch { toast('could not reach the clipboard', { kind: 'error' }); }
}

async function toggleRevoked(inv, admin) {
  try {
    await admin.patchInvite(inv.code, { revoked: !inv.revoked });
    toast(inv.revoked ? 'code works again' : 'code cancelled', { kind: 'ok' });
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

async function dropCode(inv, admin) {
  const ok = await confirmDialog({
    title: `delete ${inv.code}?`,
    body: 'this only removes the record from this list — it does not touch any account already made '
      + 'with it. cancelling the code instead keeps the history of who used it.',
    okLabel: 'delete the record', danger: true,
  });
  if (!ok) return;
  try {
    await admin.dropInvite(inv.code);
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

function exportCodes() {
  const lines = [
    'vodpad invite codes',
    `exported ${fmtDate(Date.now())} by ${state.user}`,
    '',
  ];
  for (const inv of data.invites) {
    lines.push(`${inv.code}  ${inv.reset ? `reset for ${inv.reset}` : inv.admin ? 'makes an admin' : 'makes an account'}`);
    lines.push(`    ${joinDots([
      inv.note || null,
      `made by ${inv.maker} on ${fmtDate(inv.created)}`,
      `${inv.uses} of ${inv.maxUses} used`,
      inv.revoked ? 'cancelled' : null,
      inv.expires ? `runs out ${fmtDate(inv.expires)}` : 'never runs out',
      inv.takenBy.length ? `used by ${inv.takenBy.map((u) => `${u.user} (${fmtDate(u.used)})`).join(', ')}` : null,
    ])}`);
    lines.push('');
  }
  download('vodpad-invite-codes.txt', lines.join('\n'));
}

/* ---------------------------------------------------------------- generating */

async function newInvite(admin, { reset = null } = {}) {
  const note = h('input.field', { placeholder: reset ? `why ${reset} needs it` : 'who is this for?', spellcheck: false });
  let uses = 1;
  let days = 14;
  let makeAdmin = false;

  const usesRow = h('div.setting-row',
    h('div.setting-text', h('label', { text: 'how many people can use it' }),
      h('small', { text: 'one each is the tidy way — you can see who used which' })),
    h('div.setting-ctl', segmented([
      { label: 'once', value: 1 }, { label: '3', value: 3 }, { label: '10', value: 10 },
    ], 1, (v) => { uses = v; })));

  const adminRow = h('div.setting-row',
    h('div.setting-text', h('label', { text: 'make them an admin' }),
      h('small', { text: 'full control over everyone’s sessions, including yours' })),
    h('div.setting-ctl', segmented([
      { label: 'no', value: 0 }, { label: 'yes', value: 1 },
    ], 0, (v) => { makeAdmin = !!v; })));

  const pick = await openModal({
    title: reset ? `reset code for ${reset}` : 'generate an invite code',
    width: 470,
    body: h('div.invite-form',
      h('p.modal-text', { text: reset
        ? `${reset} pastes this into the create account tab and it lets them choose a new password. `
          + 'nothing else about their account changes, and it works once.'
        : 'whoever you send this to picks their own username and password. you never see the password '
          + 'and neither does the site — that is the point of the code.' }),
      h('label.gate-label', { text: 'note to yourself' }), note,
      reset ? null : usesRow,
      h('div.setting-row',
        h('div.setting-text', h('label', { text: 'how long it lasts' }),
          h('small', { text: 'a code with no end date is one you will forget about' })),
        h('div.setting-ctl', segmented([
          { label: '24h', value: 1 }, { label: '2 weeks', value: 14 },
          { label: '90 days', value: 90 }, { label: 'forever', value: 0 },
        ], 14, (v) => { days = v; }))),
      reset ? null : adminRow,
    ),
    actions: [{ label: 'cancel', value: null }, { label: 'generate', value: 'go', kind: 'primary' }],
  });
  if (pick !== 'go') return;

  try {
    const res = await admin.makeInvite({
      note: note.value.trim(), maxUses: uses, days, admin: makeAdmin, reset,
    });
    forgetAccounts();
    await showFreshCode(res.invite);
    await refreshAccounts();
  } catch (err) { toast(err.message, { kind: 'error' }); }
}

/** the code, big, with the one button that matters. it is also in the list
 *  behind this — nothing here is a last chance to write it down. */
async function showFreshCode(inv) {
  await openModal({
    title: inv.reset ? `reset code for ${inv.reset}` : 'here is the code',
    width: 460,
    body: h('div.fresh-code',
      h('div.fresh-code-value', { text: inv.code }),
      h('p.modal-text', { text: inv.reset
        ? `send this to ${inv.reset}. it lets them set a new password once, then stops working.`
        : 'send this to whoever is joining. they paste it into the create account tab.' }),
      h('div.fresh-code-acts',
        h('button.btn', { on: { click: () => copyCode(inv.code) } }, icon('copy', { size: 15 }), 'copy the code'),
        h('button.btn.btn-primary', { on: { click: () => copyInviteBlurb(inv) } },
          icon('page', { size: 15 }), 'copy with instructions')),
      h('p.modal-text.dim', { text: 'it stays in the list on this page, so you can come back for it.' })),
    actions: [{ label: 'done', value: true, kind: 'primary' }],
  });
}
