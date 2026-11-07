import { closeSelectPopover, enhanceSelectsIn } from './select.js';

// Each modal is a ui.css dialog opened with showModal(), so the browser
// puts it in the top layer and makes the page behind it inert. Modals form
// a stack: each open call appends a dialog, each close removes the
// topmost, which lets a confirm sit on top of an open modal without wiping
// its listeners.
export const modalStack = [];

// A dialog is a head, a body that scrolls and an action row that stays in
// view. The markup gives the head (modalHeaderHtml) and the action row
// (.ui-dialog-actions, last); everything between them goes into the body
// here. When that is a single <form>, the body goes inside it, so the
// submit button stays in the form.
function wrapDialogBody(dialog) {
  const rest = [...dialog.children].filter(c => !c.classList.contains('ui-dialog-head'));
  const box = rest.length === 1 && rest[0].tagName === 'FORM' ? rest[0] : dialog;
  const body = document.createElement('div');
  body.className = 'ui-dialog-body';
  const last = box.lastElementChild;
  const actions = last && last.classList.contains('ui-dialog-actions') ? last : null;
  [...box.childNodes].forEach(n => {
    if (n === actions || (n.classList && n.classList.contains('ui-dialog-head'))) return;
    body.appendChild(n);
  });
  box.insertBefore(body, actions);
}

// A press on the backdrop lands on the dialog itself, since its head, body
// and actions fill it. A drag between two of those also clicks the dialog,
// their nearest shared ancestor, so the press has to have started there.
function closeOnBackdropClick(dialog, close) {
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', e => { pressedBackdrop = e.target === dialog; });
  dialog.addEventListener('click', e => { if (e.target === dialog && pressedBackdrop) close(); });
}

// A phone shows a long form or a search as a full-screen view and a short
// choice as a sheet, where a wider screen keeps the centred dialog. The class
// follows the width, so a phone turned sideways with a modal open moves it
// too.
const phoneQuery = window.matchMedia('(max-width: 600px)');
const PHONE_LAYOUTS = { sheet: 'ui-dialog-sheet', fullscreen: 'ui-dialog-fullscreen' };
function applyPhoneLayout(entry) {
  Object.values(PHONE_LAYOUTS).forEach(c => entry.backdrop.classList.remove(c));
  if (entry.phone && phoneQuery.matches) entry.backdrop.classList.add(PHONE_LAYOUTS[entry.phone]);
}
// A sheet follows a downward drag from its handle or head and closes past a
// quarter of its height or on a flick; anything less springs back. Buttons
// in the head keep their taps.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
function dragToClose(dialog, close) {
  let start = null;
  dialog.addEventListener('pointerdown', e => {
    if (!dialog.classList.contains('ui-dialog-sheet') || e.button !== 0) return;
    if (!e.target.closest('.ui-dialog-handle, .ui-dialog-head') || e.target.closest('button, input, select, a')) return;
    start = { y: e.clientY, t: e.timeStamp, id: e.pointerId, dy: 0 };
    dialog.setPointerCapture(e.pointerId);
    dialog.style.transition = 'none';
  });
  dialog.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    start.dy = Math.max(0, e.clientY - start.y);
    dialog.style.transform = start.dy ? 'translateY(' + start.dy + 'px)' : '';
  });
  const end = e => {
    if (!start || e.pointerId !== start.id) return;
    const { dy, t } = start;
    start = null;
    const flick = dy > 24 && dy / Math.max(1, e.timeStamp - t) > 0.6;
    if (e.type === 'pointerup' && (dy > dialog.offsetHeight / 4 || flick)) { close(); return; }
    dialog.style.transition = reduceMotion.matches ? '' : 'transform var(--ui-duration-base) ease-out';
    dialog.style.transform = '';
  };
  dialog.addEventListener('pointerup', end);
  dialog.addEventListener('pointercancel', end);
}

phoneQuery.addEventListener('change', () => {
  modalStack.forEach(applyPhoneLayout);
  fitModalsToKeyboard();
});

// opts.phone is 'sheet' or 'fullscreen'.
export function openModal(html, onMount, onClose, opts) {
  const root = document.getElementById('modal-root');
  const dialog = document.createElement('dialog');
  dialog.className = 'ui-dialog modal';
  dialog.innerHTML = html;
  wrapDialogBody(dialog);
  // ui.css shows the handle only while the dialog is a sheet.
  if (opts && opts.phone === 'sheet') {
    dialog.insertAdjacentHTML('afterbegin', '<div class="ui-dialog-handle" aria-hidden="true"></div>');
  }
  root.appendChild(dialog);
  const entry = { backdrop: dialog, onClose: null, phone: opts && opts.phone };
  applyPhoneLayout(entry);
  // Default close behavior: tear down this dialog. onClose overrides
  // run instead and may call closeModal()/closeTopModal() themselves.
  entry.onClose = onClose
    ? () => onClose()
    : () => closeTopModal();
  modalStack.push(entry);
  closeOnBackdropClick(dialog, () => entry.onClose());
  if (entry.phone === 'sheet') dragToClose(dialog, () => entry.onClose());
  dialog.querySelectorAll('.modal-close').forEach(el => el.addEventListener('click', () => entry.onClose()));
  // Escape is handled on keydown (escClose), where preventDefault keeps the
  // browser from closing the dialog itself. Any other close request, such
  // as Android's back gesture, arrives as cancel.
  dialog.addEventListener('cancel', e => { e.preventDefault(); entry.onClose(); });
  // A close request the page could not cancel still closes the dialog;
  // drop it from the stack so the next close takes the right one.
  dialog.addEventListener('close', () => {
    const i = modalStack.indexOf(entry);
    if (i === -1) return;
    modalStack.splice(i, 1);
    dialog.remove();
    if (modalStack.length === 0) document.removeEventListener('keydown', escClose);
  });
  if (modalStack.length === 1) document.addEventListener('keydown', escClose);
  // Open before onMount, which measures and focuses inside the dialog.
  dialog.showModal();
  if (onMount) onMount(dialog);
  enhanceSelectsIn(dialog);
  return dialog;
}

export function openFullScreenModal(html, onMount, onClose) {
  return openModal(html, onMount, onClose, { phone: 'fullscreen' });
}
export function openSheetModal(html, onMount, onClose) {
  return openModal(html, onMount, onClose, { phone: 'sheet' });
}

export function closeTopModal() {
  closeSelectPopover();
  const entry = modalStack.pop();
  if (!entry) return;
  if (modalStack.length === 0) document.removeEventListener('keydown', escClose);
  if (entry.backdrop.open) entry.backdrop.close();
  entry.backdrop.remove();
}

// Public alias preserved for the many callers in this file.
export function closeModal() { closeTopModal(); }

// Popovers and menus opened from a modal mount inside it, because the top
// layer covers everything outside the open dialog.
export function popoverHost() {
  const top = modalStack[modalStack.length - 1];
  return top ? top.backdrop : document.body;
}

// A phone keyboard covers the page without resizing it, which leaves a
// modal's scroll end behind the keys. Capping modals at the part still
// visible keeps every field and list reachable. A modal keeps its top, so
// only a short centred one moves, up to the height the form modals sit at.
// A full-screen view shrinks to the visible part instead, and a sheet rides
// up on the keyboard's top edge.
function fitModalsToKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  // A pinch also shrinks the visual viewport, but only a keyboard does so at scale 1.
  const layoutHeight = document.documentElement.clientHeight;
  const covered = vv.scale < 1.01 && layoutHeight - vv.height > 120;
  modalStack.forEach(({ backdrop: dialog }) => {
    if (!covered) {
      ['top', 'bottom', 'marginTop', 'maxHeight', 'height'].forEach(prop => { dialog.style[prop] = ''; });
      delete dialog.dataset.keyboardTop;
      return;
    }
    if (dialog.classList.contains('ui-dialog-fullscreen')) {
      dialog.style.top = vv.offsetTop + 'px';
      dialog.style.bottom = 'auto';
      dialog.style.height = vv.height + 'px';
      return;
    }
    if (dialog.classList.contains('ui-dialog-sheet')) {
      dialog.style.bottom = (layoutHeight - vv.offsetTop - vv.height) + 'px';
      dialog.style.maxHeight = (vv.height - 8) + 'px';
      return;
    }
    if (!dialog.dataset.keyboardTop) {
      dialog.dataset.keyboardTop = Math.min(dialog.getBoundingClientRect().top, 64);
    }
    const gap = Number(dialog.dataset.keyboardTop);
    dialog.style.top = (vv.offsetTop + gap) + 'px';
    dialog.style.bottom = 'auto';
    dialog.style.marginTop = '0';
    dialog.style.maxHeight = (vv.height - gap - 8) + 'px';
  });
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitModalsToKeyboard);
  window.visualViewport.addEventListener('scroll', fitModalsToKeyboard);
}

function requestCloseTopModal() {
  const top = modalStack[modalStack.length - 1];
  if (!top) return false;
  top.onClose();
  return true;
}
// The Android app owns the back gesture, so the dialog's cancel event never
// fires there. MainActivity calls this first, and goes back or exits on false.
window.ferdCloseTopModal = requestCloseTopModal;
function escClose(e) {
  if (e.key !== 'Escape') return;
  if (requestCloseTopModal()) e.preventDefault();
}
// The box sits at the end of the scrolling body, and a form saved from a
// pinned action row may be scrolled well above it.
export function showErrorBox(el, msg) {
  el.textContent = msg;
  el.classList.add('visible');
  el.scrollIntoView({ block: 'nearest' });
}

export function showModalError(msg) {
  const el = document.querySelector('.modal-error');
  if (el) showErrorBox(el, msg);
}
