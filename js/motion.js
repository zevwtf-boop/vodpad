/* motion — one shared vocabulary so every surface feels like the same app.
   everything here is transform/opacity only, so it stays on the compositor. */

export const EASE = {
  emph: 'cubic-bezier(.22,.61,.36,1)',
  snap: 'cubic-bezier(.34,1.56,.64,1)',
  calm: 'cubic-bezier(.33,0,.2,1)',
};

export function motionScale() {
  const level = document.documentElement.dataset.motion || 'full';
  return level === 'off' ? 0 : level === 'subtle' ? 0.62 : 1;
}

export const motionOn = () => motionScale() > 0.05;

/** thin wrapper over waapi that respects the motion setting */
export function animate(el, keyframes, opts = {}) {
  const scale = motionScale();
  const duration = (opts.duration ?? 240) * scale;
  if (!el || !scale) {
    if (opts.fill === 'forwards' && keyframes.length) Object.assign(el?.style || {}, keyframes.at(-1));
    return { finished: Promise.resolve(), cancel() {} };
  }
  return el.animate(keyframes, {
    duration,
    easing: opts.easing || EASE.emph,
    fill: opts.fill || 'none',
    delay: (opts.delay || 0) * scale,
  });
}

/** fade + rise a list of children in sequence, capped so long docs don't crawl */
export function stagger(items, { step = 22, duration = 300, distance = 10, cap = 14 } = {}) {
  if (!motionOn()) return;
  items.forEach((el, i) => {
    if (i > cap) return;
    animate(el, [
      { opacity: 0, transform: `translateY(${distance}px)` },
      { opacity: 1, transform: 'none' },
    ], { duration, delay: i * step, easing: EASE.emph, fill: 'backwards' });
  });
}

/** classic FLIP: measure before, mutate, then play the delta backwards */
export function flip(el, first, { duration = 320, easing = EASE.emph } = {}) {
  if (!el || !first || !motionOn()) return;
  const last = el.getBoundingClientRect();
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / Math.max(1, last.width);
  const sy = first.height / Math.max(1, last.height);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < .01 && Math.abs(sy - 1) < .01) return;
  animate(el, [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' },
    { transform: 'none', transformOrigin: 'top left' },
  ], { duration, easing });
}

/**
 * shared-element transition: a ghost of `fromEl` flies to `toRect` while the
 * new surface fades up underneath it. this is what makes clicking a session
 * card feel like it *became* the board.
 */
export function ghostTo(fromEl, toRect, { duration = 380, radius = 14, tint } = {}) {
  if (!fromEl || !toRect || !motionOn()) return Promise.resolve();
  const from = fromEl.getBoundingClientRect();
  const layer = document.getElementById('flip-layer');
  if (!layer) return Promise.resolve();

  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  Object.assign(ghost.style, {
    left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`,
    borderRadius: `${radius}px`,
    background: tint || getComputedStyle(fromEl).backgroundColor || 'var(--bg-2)',
  });
  layer.append(ghost);

  const anim = ghost.animate([
    { transform: 'none', opacity: 1 },
    {
      transform: `translate(${toRect.left - from.left}px, ${toRect.top - from.top}px) scale(${toRect.width / from.width}, ${toRect.height / from.height})`,
      opacity: 0,
    },
  ], { duration: duration * motionScale(), easing: EASE.emph, fill: 'forwards' });

  return anim.finished.then(() => ghost.remove(), () => ghost.remove());
}

/**
 * little spring for popovers and menus.
 *
 * menus, popovers and submenus all reuse the same element, so a close
 * animation left running with fill:forwards would fade the *next* one straight
 * back out — that's what made every submenu look like it closed instantly.
 * cancelling first is the whole fix.
 */
export function popIn(el, { origin = 'center top', duration = 170 } = {}) {
  el.getAnimations?.().forEach((a) => a.cancel());
  el.style.opacity = '';
  el.style.transform = '';
  el.style.transformOrigin = origin;
  animate(el, [
    { opacity: 0, transform: 'scale(.94) translateY(-4px)' },
    { opacity: 1, transform: 'none' },
  ], { duration, easing: EASE.snap });
}

/**
 * fade out without `fill: forwards` — a finished (or stalled) animation must
 * never be what's holding an element invisible, or reopening it looks broken.
 * the caller hides it once this settles.
 */
export function popOut(el, { duration = 120 } = {}) {
  el.getAnimations?.().forEach((a) => a.cancel());
  return settle(animate(el, [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: 'scale(.97)' },
  ], { duration, easing: EASE.calm }), duration + 220);
}

export function fadeOut(el, { duration = 170 } = {}) {
  el.getAnimations?.().forEach((a) => a.cancel());
  return settle(animate(el, [{ opacity: 1 }, { opacity: 0 }], { duration, easing: EASE.calm }), duration + 220);
}

/**
 * never let a hidden tab or a cancelled animation strand a closing panel:
 * whatever happens, the promise resolves.
 */
export function settle(anim, ms = 400) {
  return Promise.race([
    (anim && anim.finished) || Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]).catch(() => {});
}

/** pulse something so the eye lands on it after a jump */
export function ping(el) {
  if (!el || !motionOn()) return;
  animate(el, [
    { boxShadow: '0 0 0 0 var(--glow)' },
    { boxShadow: '0 0 0 10px transparent' },
  ], { duration: 700, easing: EASE.calm });
}

/** number counting, used on the dashboard stats */
export function countUp(el, to, { duration = 700, suffix = '' } = {}) {
  const target = Number(to) || 0;
  if (!motionOn() || target === 0) { el.textContent = target + suffix; return; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / (duration * motionScale()));
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
