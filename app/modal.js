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

export function openModal(html, onMount, onClose) {
  const root = document.getElementById('modal-root');
  const dialog = document.createElement('dialog');
  dialog.className = 'ui-dialog modal';
  dialog.innerHTML = html;
  wrapDialogBody(dialog);
  root.appendChild(dialog);
  const entry = { backdrop: dialog, onClose: null };
  // Default close behavior: tear down this dialog. onClose overrides
  // run instead and may call closeModal()/closeTopModal() themselves.
  entry.onClose = onClose
    ? () => onClose()
    : () => closeTopModal();
  modalStack.push(entry);
  closeOnBackdropClick(dialog, () => entry.onClose());
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
function fitModalsToKeyboard() {
  const vv = window.visualViewport;
  // A pinch also shrinks the visual viewport, but only a keyboard does so at scale 1.
  const covered = vv.scale < 1.01 && document.documentElement.clientHeight - vv.height > 120;
  modalStack.forEach(({ backdrop: dialog }) => {
    if (!covered) {
      ['top', 'bottom', 'marginTop', 'maxHeight'].forEach(prop => { dialog.style[prop] = ''; });
      delete dialog.dataset.keyboardTop;
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
