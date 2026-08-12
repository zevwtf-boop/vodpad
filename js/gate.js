/* the login screen for the hosted build. */

import { $, h, clear } from './util.js';
import { icon } from './icons.js';
import { loadUsers, unlock, userNames, currentUser, lock } from './vault.js';
import { animate, EASE } from './motion.js';

export function requireLogin() {
  return new Promise(async (resolve) => {
    let names = [];
    try { await loadUsers(); names = userNames(); } catch { /* shown below */ }

    const gate = h('div.gate');
    const user = h('input.field.gate-user', {
      placeholder: 'username', spellcheck: false, autocomplete: 'username',
      list: 'gate-names', value: localStorage.getItem('vodpad:last') || '',
    });
    const pass = h('input.field.gate-pass', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
    const msg = h('div.gate-msg');
    const button = h('button.btn.btn-primary.gate-go', icon('forward', { size: 15 }), 'unlock');

    gate.append(
      h('div.gate-card',
        h('div.gate-mark', icon('sparkle', { size: 22 })),
        h('h1', { text: 'vodpad' }),
        h('p.gate-sub', { text: 'your notes on this browser are encrypted. the password is the key — there is no reset.' }),
        h('datalist#gate-names', ...names.map((n) => h('option', { value: n }))),
        h('label.gate-label', { text: 'who are you' }), user,
        h('label.gate-label', { text: 'password' }), pass,
        msg,
        button,
        names.length ? h('div.gate-foot', { text: `accounts on this site: ${names.join(' · ')}` })
                     : h('div.gate-foot.warn', { text: 'users.json is missing — this build cannot log anyone in' }),
      ),
    );
    document.body.append(gate);
    animate(gate.querySelector('.gate-card'), [{ opacity: 0, transform: 'translateY(14px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE.emph });
    setTimeout(() => (user.value ? pass : user).focus(), 60);

    let busy = false;
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
      let ok = false;
      try { ok = await unlock(name, secret); } catch (err) { console.error(err); }
      busy = false;
      clear(button);
      button.append(icon('forward', { size: 15 }), 'unlock');
      if (!ok) { fail('that username and password do not match'); return; }
      localStorage.setItem('vodpad:last', currentUser());
      animate(gate, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE.calm });
      setTimeout(() => { gate.remove(); resolve(currentUser()); }, 240);
    };

    const fail = (text) => {
      msg.className = 'gate-msg bad';
      msg.textContent = text;
      pass.select();
      animate(gate.querySelector('.gate-card'), [
        { transform: 'translateX(0)' }, { transform: 'translateX(-7px)' },
        { transform: 'translateX(6px)' }, { transform: 'translateX(0)' },
      ], { duration: 260 });
    };

    button.onclick = attempt;
    for (const field of [user, pass]) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') attempt(); });
  });
}

export function signOut() {
  lock();
  location.reload();
}
