/* the login screen for the hosted build. */

import { $, h, clear } from './util.js?v=440f02a293';
import { icon } from './icons.js?v=440f02a293';
import { signIn, signOut as backendSignOut, mode } from './api.js?v=440f02a293';
import { animate, EASE } from './motion.js?v=440f02a293';

export function requireLogin() {
  return new Promise(async (resolve) => {
    let names = [];
    if (mode === 'vault') {
      try {
        const vault = await import('./vault.js?v=440f02a293');
        await vault.loadUsers();
        names = vault.userNames();
      } catch { /* shown below */ }
    }

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
        h('p.gate-sub', {
          text: mode === 'cloud'
            ? 'signed in, your sessions follow you to any device you open this on.'
            : 'your notes on this browser are encrypted. the password is the key — there is no reset.',
        }),
        h('datalist#gate-names', ...names.map((n) => h('option', { value: n }))),
        h('label.gate-label', { text: 'who are you' }), user,
        h('label.gate-label', { text: 'password' }), pass,
        msg,
        button,
        names.length ? h('div.gate-foot', { text: `accounts on this site: ${names.join(' · ')}` })
          : h('div.gate-foot', { text: mode === 'cloud' ? 'synced · signs you in on any device' : 'users.json is missing — this build cannot log anyone in' }),
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
      let who = null, problem = null;
      try { who = await signIn(name, secret); } catch (err) { problem = err.message; console.error(err); }
      busy = false;
      clear(button);
      button.append(icon('forward', { size: 15 }), 'unlock');
      if (!who) { fail(problem || 'that username and password do not match'); return; }
      localStorage.setItem('vodpad:last', who);
      animate(gate, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: EASE.calm });
      setTimeout(() => { gate.remove(); resolve(who); }, 240);
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

export function signOut() { backendSignOut(); }
