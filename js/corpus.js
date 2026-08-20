/* a cached copy of every session document, so the dashboard drill list and
   the global search don't refetch the world on every keystroke. */

import { api } from './api.js?v=2e4abb3f3d';
import { state, bus } from './store.js?v=2e4abb3f3d';

let cache = null;
let stamp = 0;
let inflight = null;

export function invalidateCorpus() { cache = null; }
bus.on('save', (s) => { if (s.status === 'saved') invalidateCorpus(); });

/* these used to load one after another, which is fine for one account and N
   round trips for an admin looking at everybody's. four at a time is quick
   without opening a socket per session or tripping the worker's rate limit. */
const LANES = 4;

export async function loadCorpus({ maxAge = 20000 } = {}) {
  if (cache && Date.now() - stamp < maxAge) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const metas = state.boards.slice();
    const docs = new Array(metas.length).fill(null);
    let next = 0;

    const lane = async () => {
      while (next < metas.length) {
        const i = next++;
        const meta = metas[i];
        // the open session is already in memory, and it is the freshest copy
        if (state.board && state.board.id === meta.id) { docs[i] = state.board; continue; }
        try { docs[i] = await api.board(meta.id); } catch { /* skip unreadable */ }
      }
    };

    await Promise.all(Array.from({ length: Math.min(LANES, metas.length) }, lane));
    cache = docs.filter(Boolean);          // order still matches state.boards
    stamp = Date.now();
    inflight = null;
    return cache;
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
