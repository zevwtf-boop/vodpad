/* a cached copy of every session document, so the dashboard drill list and
   the global search don't refetch the world on every keystroke. */

import { api } from './api.js?v=58e76add28';
import { state, bus } from './store.js?v=58e76add28';

let cache = null;
let stamp = 0;
let inflight = null;

export function invalidateCorpus() { cache = null; }
bus.on('save', (s) => { if (s.status === 'saved') invalidateCorpus(); });

export async function loadCorpus({ maxAge = 20000 } = {}) {
  if (cache && Date.now() - stamp < maxAge) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const docs = [];
    for (const meta of state.boards) {
      if (state.board && state.board.id === meta.id) { docs.push(state.board); continue; }
      try { docs.push(await api.board(meta.id)); } catch { /* skip unreadable */ }
    }
    cache = docs;
    stamp = Date.now();
    inflight = null;
    return docs;
  })();
  return inflight;
}

/** flat list of every card across every session, newest first */
export async function allCards() {
  const docs = await loadCorpus();
  const out = [];
  for (const doc of docs) {
    for (const c of Object.values(doc.cards || {})) {
      out.push({ card: c, boardId: doc.id, boardTitle: doc.title });
    }
  }
  out.sort((a, b) => (b.card.updated || 0) - (a.card.updated || 0));
  return out;
}
