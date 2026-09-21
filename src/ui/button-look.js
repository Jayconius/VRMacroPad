// The look of one button that goes beyond its colour: the picture for the current state and the animation effect.
// Used by the grid and by the editor's preview, so what you see while editing is what the button will do.
import { authToken } from './net.js';

const SPEED = { slow: 1.7, normal: 1, fast: 0.55 };
const seen = new Set();

export function imageUrl(name) {
  return `/user-images/${encodeURIComponent(name)}?token=${encodeURIComponent(authToken())}`;
}

// Load a picture once ahead of time, so switching to the active picture does not blink.
export function preload(name) {
  if (!name || seen.has(name)) return;
  seen.add(name);
  try { new Image().src = imageUrl(name); } catch { /* not in a browser */ }
}

export function applyLook(el, b, active) {
  const fx = (active ? b.animOn : b.anim) || 'none';
  for (const c of [...el.classList]) if (c.startsWith('fx-')) el.classList.remove(c);
  if (fx !== 'none') el.classList.add(`fx-${fx}`);
  el.style.setProperty('--fx-speed', String(SPEED[b.animSpeed] || 1));
  const img = (active && b.imageOn) || b.image || '';
  el.classList.toggle('has-img', Boolean(img));
  if (img) {
    el.style.setProperty('--img', `url("${imageUrl(img)}")`);
    el.style.setProperty('--fit', b.imageFit === 'contain' ? 'contain' : 'cover');
  } else {
    el.style.removeProperty('--img');
  }
}
