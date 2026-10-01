// The side panel (node settings, node chat, the workflow helper) is as wide as you make it: drag its left edge, or
// Alt+Shift+Left/Right. The width is kept in this browser and applied as one custom property.
import { pref, setPref } from '../state.js';

const MIN = 280;
const STEP = 48;
const maxW = () => Math.round(window.innerWidth * 0.7);
const clamp = (w) => Math.max(MIN, Math.min(maxW(), Math.round(w)));

function apply(w) {
  if (w) document.documentElement.style.setProperty('--panel-user', `${clamp(w)}px`);
  else document.documentElement.style.removeProperty('--panel-user');
}

export function initPanelSize() {
  const saved = Number(pref('panel-w', '0'));
  if (saved) apply(saved);
  document.addEventListener('pointerdown', (e) => {
    const panel = e.target instanceof Element ? e.target.closest('.cs-inspector') : null;
    if (!panel || e.button !== 0 || getComputedStyle(panel).position === 'fixed') return;
    const r = panel.getBoundingClientRect();
    if (e.clientX - r.left > 8) return;
    e.preventDefault();
    panel.setAttribute('data-resizing', '');
    const move = (ev) => apply(r.right - ev.clientX);
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      panel.removeAttribute('data-resizing');
      const w = clamp(r.right - ev.clientX);
      setPref('panel-w', String(w));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const panel = document.querySelector('.cs-inspector');
    if (!panel) return;
    e.preventDefault();
    const w = clamp(panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? STEP : -STEP));
    apply(w);
    setPref('panel-w', String(w));
  });
}
