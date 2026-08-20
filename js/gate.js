/* the login screen for the hosted build.

   three things happen behind one card: signing in, making an account against an
   invite code, and using a reset code to re-key an account whose password is
   gone. the last two only exist on the synced build — see api.js canSignUp().

   nothing here ever sends a password. the 600k-round derivation happens in the
   browser and only the derived key crosses the wire, on the way in and on the
   way up. */

import { $, h, clear, debounce } from './util.js?v=d258d51ea6';
import { icon } from './icons.js?v=d258d51ea6';
import { signIn, signOut as backendSignOut, mode, canSignUp, checkSignup, signUp, resetPassword } from './api.js?v=d258d51ea6';
import { animate, EASE } from './motion.js?v=d258d51ea6';

export function requireLogin() {
  return new Promise(async (resolve) => {
    let names = [];
    if (mode === 'vault') {
      try {
        const vault = await import('./vault.js?v=d258d51ea6');
        await vault.loadUsers();
        names = vault.userNames();
      } catch { /* shown below */ }
    }

    const gate = h('div.gate');
    const card = h('div.gate-card');
    const body = h('div.gate-body');
    let tabs = null;

    const done = (who) => {
      localStorage.setItem('vodpad:last', who);
      animate(gate, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE.calm });
      setTimeout(() => { gate.remove(); resolve(who); }, 240);
    };

    const shake = () => animate(card, [
      { transform: 'translateX(0)' }, { transform: 'translateX(-7px)' },
      { transform: 'translateX(6px)' }, { transform: 'translateX(0)' },
    ], { duration: 260 });

    const panels = {
      in: () => signInPanel({ names, done, shake }),
      up: () => signUpPanel({ done, shake, back: () => show('in') }),
    };

    function show(which) {
      clear(body);
      body.append(panels[which]());
      if (tabs) for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === which);
      animate(body, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, easing: EASE.snap });
    }

    if (canSignUp()) {
      tabs = h('div.gate-tabs',
        h('button', { data: { k: 'in' }, text: 'sign in', on: { click: () => show('in') } }),
        h('button', { data: { k: 'up' }, text: 'create account', on: { click: () => show('up') } }));
    }

    card.append(
      h('div.gate-mark', icon('sparkle', { size: 22 })),
      h('h1', { text: 'vodpad' }),
      h('p.gate-sub', {
        text: mode === 'cloud'
          ? 'signed in, your sessions follow you to any device you open this on.'
          : 'your notes on this browser are encrypted. the password is the key — there is no reset.',
      }),
      h('datalist#gate-names', ...names.map((n) => h('option', { value: n }))),
      tabs,
      body,
      names.length ? h('div.gate-foot', { text: `accounts on this site: ${names.join(' · ')}` })
        : h('div.gate-foot', {
          text: mode === 'cloud'
            ? 'synced · an account needs an invite code from trickfnq'
            : 'users.json is missing — this build cannot log anyone in',
        }),
    );
    gate.append(card);
    document.body.append(gate);
    show('in');
    animate(card, [{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }],
      { duration: 320, easing: EASE.emph });
  });
}

/* ---------------------------------------------------------------- sign in */

function signInPanel({ names, done, shake }) {
  const user = h('input.field.gate-user', {
    placeholder: 'username', spellcheck: false, autocomplete: 'username',
    list: 'gate-names', value: localStorage.getItem('vodpad:last') || '',
  });
  const pass = h('input.field.gate-pass', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const msg = h('div.gate-msg');
  const button = h('button.btn.btn-primary.gate-go', icon('forward', { size: 15 }), 'unlock');

  let busy = false;
  const fail = (text) => {
    msg.className = 'gate-msg bad';
    msg.textContent = text;
    pass.select();
    shake();
  };

  const attempt = async () => {
    if (busy) return;
    const name = user.value.trim();
    const secret = pass.value;
    if (!name || !secret) { fail('fill both in'); return; }
    busy = true;
    button.textContent = 'checking…';
    msg.className = 'gate-msg';
    msg.textContent = '';
    // the derivation is deliberately slow; let the browser paint first
    await new Promise((r) => setTimeout(r, 30));
    let who = null, problem = null;
    try { who = await signIn(name, secret); } catch (err) { problem = err.message; console.error(err); }
    busy = false;
    clear(button);
    button.append(icon('forward', { size: 15 }), 'unlock');
    if (!who) { fail(problem || 'that username and password do not match'); return; }
    done(who);
  };

  button.onclick = attempt;
  for (const field of [user, pass]) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  setTimeout(() => (user.value ? pass : user).focus(), 60);

  return h('div.gate-panel',
    h('label.gate-label', { text: 'who are you' }), user,
    h('label.gate-label', { text: 'password' }), pass,
    msg, button,
    canSignUp() ? h('p.gate-hint', { text: 'forgotten it? trickfnq can hand you a reset code — '
      + 'paste it into create account and it lets you set a new password.' }) : null,
  );
}

/* ---------------------------------------------------------------- sign up */

/* rough and deliberately generous. this is a "that is too short to bother
   anyone" check, not a policy — the account guards a notebook, and a rule that
   demands a symbol just moves the password onto a sticky note. */
function strengthOf(pw) {
  if (!pw) return { score: 0, word: '', cls: '' };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 30;
  const bits = pw.length * Math.log2(pool || 1);
  if (bits < 40) return { score: 1, word: 'too easy to guess', cls: 'weak' };
  if (bits < 60) return { score: 2, word: 'ok', cls: 'ok' };
  if (bits < 80) return { score: 3, word: 'good', cls: 'good' };
  return { score: 4, word: 'strong', cls: 'good' };
}

function signUpPanel({ done, shake, back }) {
  const name = h('input.field', { placeholder: 'pick a username', spellcheck: false, autocomplete: 'username' });
  const code = h('input.field.gate-code', { placeholder: 'VOD-XXXX-XXXX', spellcheck: false, autocomplete: 'off' });
  const pass = h('input.field', { type: 'password', placeholder: 'password', autocomplete: 'new-password' });
  const again = h('input.field', { type: 'password', placeholder: 'the same password again', autocomplete: 'new-password' });

  const nameNote = h('div.gate-note');
  const codeNote = h('div.gate-note');
  const meter = h('div.gate-meter', h('i'));
  const meterWord = h('span.gate-meter-word');
  const msg = h('div.gate-msg');
  const button = h('button.btn.btn-primary.gate-go', icon('plus', { size: 15 }), 'create account');

  const nameRow = h('div.gate-field', h('label.gate-label', { text: 'username' }), name, nameNote);

  // a reset code re-keys an existing account, so it hides the username field
  // and renames the button — same form, different job
  let resetFor = null;
  let nameOk = false;
  let codeOk = false;

  const paintMode = () => {
    nameRow.hidden = !!resetFor;
    clear(button);
    button.append(icon(resetFor ? 'undo' : 'plus', { size: 15 }),
      resetFor ? `set ${resetFor}'s new password` : 'create account');
  };

  const note = (el, state) => {
    el.className = `gate-note ${state.why ? (state.ok ? 'good' : 'bad') : ''}`;
    el.textContent = state.why || '';
  };

  const check = debounce(async () => {
    const wanted = name.value.trim();
    const typed = code.value.trim();
    if (!wanted && !typed) { note(nameNote, {}); note(codeNote, {}); return; }
    try {
      const res = await checkSignup(resetFor ? '' : wanted, typed);
      nameOk = !!res.name.ok;
      codeOk = !!res.code.ok;
      resetFor = res.code.kind === 'reset' ? res.code.for : null;
      note(nameNote, resetFor ? {} : res.name);
      note(codeNote, res.code);
      paintMode();
    } catch { /* the real answer comes back on submit */ }
  }, 420);

  name.addEventListener('input', check);
  code.addEventListener('input', () => {
    // codes get read off a screen; accept them typed loosely and tidy as you go
    const raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    code.value = raw.length > 7 ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`
      : raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
    check();
  });

  pass.addEventListener('input', () => {
    const s = strengthOf(pass.value);
    meter.dataset.score = String(s.score);
    meter.className = `gate-meter ${s.cls}`;
    meterWord.textContent = s.word;
  });

  let busy = false;
  const fail = (text) => {
    msg.className = 'gate-msg bad';
    msg.textContent = text;
    shake();
  };

  const submit = async () => {
    if (busy) return;
    const wanted = name.value.trim();
    const secret = pass.value;

    if (!code.value.trim()) return fail('you need an invite code — trickfnq hands those out');
    if (!resetFor && !wanted) return fail('pick a username');
    if (secret.length < 8) return fail('at least 8 characters, please');
    if (secret !== again.value) return fail('those two passwords are different');
    if (!resetFor && !nameOk) return fail(nameNote.textContent || 'that username will not work');
    if (!codeOk) return fail(codeNote.textContent || 'check the invite code');

    busy = true;
    msg.className = 'gate-msg';
    msg.textContent = '';
    const label = button.textContent;
    button.textContent = 'setting things up…';
    await new Promise((r) => setTimeout(r, 30));       // let it paint before the kdf

    try {
      const who = resetFor
        ? await resetPassword(code.value.trim(), secret)
        : await signUp(wanted, code.value.trim(), secret);
      done(who);
      return;
    } catch (err) {
      fail(err.message || 'that did not work');
    }
    busy = false;
    button.textContent = label;
    paintMode();
  };

  button.onclick = submit;
  for (const field of [name, code, pass, again]) {
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  setTimeout(() => code.focus(), 60);
  paintMode();

  return h('div.gate-panel',
    h('div.gate-field', h('label.gate-label', { text: 'invite code' }), code, codeNote),
    nameRow,
    h('div.gate-field',
      h('label.gate-label', { text: 'password' }), pass,
      h('div.gate-meter-row', meter, meterWord)),
    h('div.gate-field', h('label.gate-label', { text: 'and again' }), again),
    msg, button,
    h('p.gate-hint', { text: 'nobody, including this site, can read your password or look it up '
      + 'later. if it goes, ask trickfnq for a reset code.' }),
    h('button.gate-link', { text: 'back to signing in', on: { click: back } }),
  );
}

export function signOut() { backendSignOut(); }
