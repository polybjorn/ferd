import { closeSelectPopover, enhanceSelectsIn } from './select.js';

// Each modal is a ui.css dialog opened with showModal(), so the browser
// puts it in the top layer and makes the page behind it inert. Modals form
// a stack: each open call appends a dialog, each close removes the
// topmost, which lets a confirm sit on top of an open modal without wiping
// its listeners.
/** @typedef {'sheet' | 'fullscreen' | 'top'} PhoneLayout */
/** @typedef {{ phone?: PhoneLayout }} ModalOptions */
/**
 * @typedef {object} ModalEntry
 * @property {HTMLDialogElement} backdrop
 * @property {() => void} onClose
 * @property {PhoneLayout} [phone]
 */
/** @type {ModalEntry[]} */
export const modalStack = [];

// A press on the backdrop lands on the dialog itself, since its head, body
// and actions fill it. A drag between two of those also clicks the dialog,
// their nearest shared ancestor, so the press has to have started there.
/**
 * @param {HTMLDialogElement} dialog
 * @param {() => void} close
 */
function closeOnBackdropClick(dialog, close) {
  let pressedBackdrop = false;
  dialog.addEventListener('pointerdown', e => { pressedBackdrop = e.target === dialog; });
  dialog.addEventListener('click', e => { if (e.target === dialog && pressedBackdrop) close(); });
}

// A phone shows a long form as a full-screen view, a short choice as a sheet
// and search as a panel from the top edge, where a wider screen keeps the centred dialog. The class
// follows the width, so a phone turned sideways with a modal open moves it
// too.
const phoneQuery = window.matchMedia('(max-width: 600px)');
const PHONE_LAYOUTS = { sheet: 'ui-dialog-sheet', fullscreen: 'ui-dialog-fullscreen', top: 'ui-dialog-top' };
/** @param {ModalEntry} entry */
function applyPhoneLayout(entry) {
  Object.values(PHONE_LAYOUTS).forEach(c => entry.backdrop.classList.remove(c));
  if (entry.phone && phoneQuery.matches) entry.backdrop.classList.add(PHONE_LAYOUTS[entry.phone]);
}
// A sheet follows a downward drag from its handle or head and closes past a
// quarter of its height or on a flick; anything less springs back. Buttons
// in the head keep their taps.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/**
 * @param {HTMLDialogElement} dialog
 * @param {() => void} close
 */
function dragToClose(dialog, close) {
  /** @type {{ y: number, t: number, id: number, dy: number } | null} */
  let start = null;
  dialog.addEventListener('pointerdown', e => {
    if (!dialog.classList.contains('ui-dialog-sheet') || e.button !== 0) return;
    const target = /** @type {Element} */ (e.target);
    if (!target.closest('.ui-dialog-handle, .ui-dialog-head') || target.closest('button, input, select, a')) return;
    start = { y: e.clientY, t: e.timeStamp, id: e.pointerId, dy: 0 };
    dialog.setPointerCapture(e.pointerId);
    dialog.style.transition = 'none';
  });
  dialog.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    start.dy = Math.max(0, e.clientY - start.y);
    dialog.style.transform = start.dy ? 'translateY(' + start.dy + 'px)' : '';
  });
  /** @param {PointerEvent} e */
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

// The dialog starts empty: onMount renders its head, its .ui-dialog-body and
// its action row, and a sheet's handle too, since ui.css shows that only
// while the dialog is a sheet.
/**
 * @param {((dialog: HTMLDialogElement) => void) | null} [onMount]
 * @param {(() => void) | null} [onClose]
 * @param {ModalOptions} [opts]
 * @returns {HTMLDialogElement}
 */
export function openModal(onMount, onClose, opts) {
  const root = document.getElementById('modal-root');
  const dialog = document.createElement('dialog');
  dialog.className = 'ui-dialog';
  /** @type {HTMLElement} */ (root).appendChild(dialog);
  /** @type {ModalEntry} */
  const entry = {
    backdrop: dialog,
    // Default close behavior: tear down this dialog. onClose overrides
    // run instead and may call closeModal()/closeTopModal() themselves.
    onClose: onClose ? () => onClose() : () => closeTopModal(),
  };
  if (opts && opts.phone) entry.phone = opts.phone;
  applyPhoneLayout(entry);
  modalStack.push(entry);
  closeOnBackdropClick(dialog, () => entry.onClose());
  if (entry.phone === 'sheet') dragToClose(dialog, () => entry.onClose());
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
  // After onMount, which may render the head itself (openViewModal).
  dialog.querySelectorAll('.ui-dialog-close').forEach(el => el.addEventListener('click', () => entry.onClose()));
  enhanceSelectsIn(dialog);
  return dialog;
}

/**
 * @param {((dialog: HTMLDialogElement) => void) | null} [onMount]
 * @param {(() => void) | null} [onClose]
 */
export function openSheetModal(onMount, onClose) {
  return openModal(onMount, onClose, { phone: 'sheet' });
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
      /** @type {const} */ (['top', 'bottom', 'marginTop', 'maxHeight', 'height']).forEach(prop => { dialog.style[prop] = ''; });
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
      dialog.dataset.keyboardTop = String(Math.min(dialog.getBoundingClientRect().top, 64));
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
/** @param {KeyboardEvent} e */
function escClose(e) {
  // A control that took the key first, such as a ui.js popover in the
  // dialog, keeps the dialog open.
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (requestCloseTopModal()) e.preventDefault();
}
