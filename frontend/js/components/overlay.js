// Toasts, modals (focus trapped, Esc closes the top one), confirm dialogs and menus.
import { h, icon } from '../dom.js';

/* ---- toasts ------------------------------------------------------------------------------------- */
export function toast(message, { kind = 'info', ms = 5000 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const glyph = { ok: 'check', danger: 'danger', warn: 'warning', info: 'info' }[kind] || 'info';
  const el = h('div', { class: ['cs-toast', kind === 'danger' && 'cs-toast--danger', kind === 'ok' && 'cs-toast--ok'], role: kind === 'danger' ? 'alert' : 'status' },
    icon(glyph, 'm'), h('span', { class: 'cs-grow' }, message),
    h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon cs-btn--small', 'aria-label': 'Dismiss', onclick: () => el.remove() }, icon('close', 's')));
  host.append(el);
  if (ms) setTimeout(() => el.remove(), ms);
}

/* ---- modals ------------------------------------------------------------------------------------- */
const stack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

document.addEventListener('keydown', (e) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && top.dismissable) { e.preventDefault(); e.stopPropagation(); top.close(null); return; }
  if (e.key === 'Tab') {
    const items = [...top.dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !top.dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !top.dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }
}, true);

export const modalOpen = () => stack.length > 0;

/**
 * openModal({ title, body, actions:[{label, kind, onClick(ctrl), id}], size:'narrow'|'wide', dismissable, onClose })
 * Returns { close(result), el, setBusy(bool), closed: Promise }.
 */
export function openModal({ title, body, actions = [], size, dismissable = true, onClose, top = false, initialFocus, bare = false }) {
  const opener = document.activeElement;
  const titleId = `m${Math.random().toString(36).slice(2, 8)}`;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const buttons = new Map();
  const ctrl = {
    el: null,
    closed,
    close(result = null) {
      const at = stack.indexOf(entry);
      if (at >= 0) stack.splice(at, 1);
      scrim.remove();
      if (opener && opener.isConnected) opener.focus();
      onClose?.(result);
      resolveClosed(result);
    },
    setBusy(busy) {
      for (const b of buttons.values()) b.disabled = busy;
      dialog.setAttribute('aria-busy', String(busy));
    },
    button: (id) => buttons.get(id),
  };
  const foot = actions.length
    ? h('div', { class: 'cs-modal__foot' }, actions.map((a) => {
      const b = h('button', {
        class: ['cs-btn', a.kind === 'primary' && 'cs-btn--primary', a.kind === 'danger' && 'cs-btn--danger', a.kind === 'quiet' && 'cs-btn--quiet'],
        type: 'button',
        disabled: a.disabled,
        onclick: () => (a.onClick ? a.onClick(ctrl) : ctrl.close(a.result ?? null)),
      }, a.label);
      if (a.id) buttons.set(a.id, b);
      return b;
    }))
    : null;
  const dialog = h('div', { class: ['cs-modal', size === 'wide' && 'cs-modal--wide', size === 'narrow' && 'cs-modal--narrow'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    bare ? null : h('div', { class: 'cs-modal__head' }, h('h2', { class: 'cs-modal__title', id: titleId }, title),
      dismissable ? h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close', onclick: () => ctrl.close(null) }, icon('close', 'm')) : null),
    bare ? h('h2', { class: 'cs-sr', id: titleId }, title) : null,
    bare ? body : h('div', { class: 'cs-modal__body' }, body),
    foot);
  const scrim = h('div', { class: ['cs-scrim', top && 'cs-scrim--top'], onmousedown: (e) => { if (e.target === scrim && dismissable) ctrl.close(null); } }, dialog);
  const entry = { dialog, close: ctrl.close, dismissable };
  ctrl.el = dialog;
  stack.push(entry);
  document.getElementById('overlays').append(scrim);
  const target = (initialFocus && dialog.querySelector(initialFocus)) || dialog.querySelector('[autofocus]') || dialog.querySelector('.cs-modal__body input, .cs-modal__body textarea, .cs-modal__body select') || dialog.querySelector('.cs-btn--primary') || dialog.querySelector(FOCUSABLE);
  (target || dialog).focus?.();
  return ctrl;
}

export function confirmDialog({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false, detail }) {
  return new Promise((resolve) => {
    openModal({
      title,
      size: 'narrow',
      body: h('div', { class: 'cs-stack' }, h('p', {}, message), detail ? h('p', { class: 'cs-soft cs-small' }, detail) : null),
      actions: [
        { label: cancelLabel, kind: 'quiet', onClick: (c) => { c.close(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: (c) => { c.close(true); } },
      ],
      onClose: (r) => resolve(r === true),
    });
  });
}

/* ---- menus -------------------------------------------------------------------------------------- */
let openMenuCtrl = null;

/**
 * openMenu({ anchor, items:[{label, icon, kbd, onSelect, disabled, group}], label }) - arrow keys, Enter, Esc.
 * The position is written as two custom properties in viewport percent (--x, --y), so no pixel value is styled.
 */
export function openMenu({ anchor, items, label, x, y }) {
  openMenuCtrl?.close();
  const opener = document.activeElement;
  const menu = h('div', { class: 'cs-menu', role: 'menu', 'aria-label': label || 'Menu' });
  const rows = [];
  items.forEach((it) => {
    if (it.group) { menu.append(h('div', { class: 'cs-menu__label cs-eyebrow', role: 'presentation' }, it.group)); return; }
    const b = h('button', { class: 'cs-menu__item', role: 'menuitem', type: 'button', disabled: it.disabled, onclick: () => { close(); it.onSelect?.(); } },
      it.icon ? icon(it.icon, 's') : null, h('span', { class: 'cs-grow' }, it.label), it.kbd ? h('kbd', {}, it.kbd) : null);
    rows.push(b);
    menu.append(b);
  });
  document.getElementById('overlays').append(menu);
  const rect = anchor ? anchor.getBoundingClientRect() : { left: x ?? 0, bottom: y ?? 0, top: y ?? 0, right: x ?? 0 };
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + mw > innerWidth - 8) left = Math.max(8, innerWidth - mw - 8);
  if (top + mh > innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  menu.style.setProperty('--x', String((left / innerWidth) * 100));
  menu.style.setProperty('--y', String((top / innerHeight) * 100));
  let active = 0;
  const focusRow = (n) => { active = (n + rows.length) % rows.length; rows.forEach((r, i) => r.setAttribute('data-active', String(i === active))); rows[active]?.focus(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(active - 1); }
    else if (e.key === 'Tab') { close(); }
  };
  const onDown = (e) => { if (!menu.contains(e.target)) close(); };
  menu.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  function close() {
    document.removeEventListener('mousedown', onDown);
    menu.remove();
    if (openMenuCtrl === ctrl) openMenuCtrl = null;
    if (opener && opener.isConnected) opener.focus();
  }
  const ctrl = { close };
  openMenuCtrl = ctrl;
  if (rows.length) focusRow(0);
  return ctrl;
}
