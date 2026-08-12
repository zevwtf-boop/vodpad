# putting vodpad online

this folder **is** the website — plain files, no build step, nothing to install.

there are two ways it can store notes, and you can switch between them any time:

| | where notes live | works across devices | can the notes be read by anyone else |
| --- | --- | --- | --- |
| **browser-only** (what you have now) | encrypted in the browser you're using | no | no — not without your password |
| **synced** (`..\cloudflare\SETUP.md`) | your own free cloudflare database | yes, all three accounts, any device | only someone with your cloudflare login |

---

# part 1 — get it online (10 minutes, do this first)

## 1. make a repository

on **github.com** → **new repository**
- name: `vodpad` (or anything)
- **public** — free github pages won't serve a private one
- **don't** tick "add a README" — this folder already has one
- **Create repository**

github then shows you a page with commands. ignore it, use the ones below.

## 2. push this folder up

open a terminal in this folder (`Desktop\Tools\vodpad\web`) and run, one line at a time:

```bash
git remote add origin https://github.com/YOUR-USERNAME/vodpad.git
git push -u origin main
```

the first push opens a browser window to sign into github — approve it there.

> the commit is currently authored as `trickfnq`. if your github username is different:
> `git config user.name YOURNAME` and
> `git config user.email YOURNAME@users.noreply.github.com`, then push.

## 3. switch pages on

on the repo page: **Settings → Pages**
- **Source:** Deploy from a branch
- **Branch:** `main`, folder: `/ (root)`
- **Save**

wait about a minute, then open:

```
https://YOUR-USERNAME.github.io/vodpad/
```

sign in with one of the three accounts. done — it works on a phone too.

### if you'd rather not touch git

**cloudflare pages** → Create a project → *Upload assets* → drag this whole folder in.
you get a `something.pages.dev` address. same result.

---

# part 2 — make it sync (optional, another 10 minutes)

right now each browser holds its own notes. to have all three of you sign in from anywhere
and share sessions, follow **`..\cloudflare\SETUP.md`** — it's a click-by-click walkthrough
of making a free database, pasting in one file of code, and putting the address in
`config.json`.

nothing you've already written is lost by switching; the two modes are just two different
places notes can live.

---

# updating the site later

after changing the app on your pc:

```bash
python build_web.py
```

then, in this folder:

```bash
git add -A
git commit -m "update"
git push
```

github pages redeploys on its own in under a minute. `build_web.py` never touches
`users.json` or `config.json`, so accounts and your sync setting survive updates.

---

# accounts and passwords

- three accounts: **trickfnq**, **Chrisfv7**, **devoxbl**
- `users.json` in this folder holds a random **salt** and a short **sealed sentinel** per
  account — no password, nothing reversible. it's fine that it's public
- signing in turns your password into a 256-bit key (pbkdf2-hmac-sha256, 600,000 rounds).
  in browser-only mode that key encrypts every board and screenshot before storage; in synced
  mode it proves who you are to the worker
- **there is no password reset.** `python build_web.py --new-passwords` mints three new ones,
  but the new keys cannot decrypt anything written under the old ones

# backups (browser-only mode)

clearing your browser data deletes the notes. **settings → data → download a backup** writes
out the sealed records — unreadable without your password, and restorable into any browser
you sign into. once sync is on, the cloudflare database is the backup.
