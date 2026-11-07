import { h, render, Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { openModal } from './modal.js';
import { t } from './i18n.js';
import { isDefaultHidden, setDefaultHidden } from './prefs.js';

// The view layer: Preact components written as htm templates, so there is no
// build step. index.html maps the bare names to vendor/.
export { Fragment, useEffect, useLayoutEffect, useRef, useState };
export const html = htm.bind(h);

// Preact owns every child of the dialog, so a view renders its own head and
// .ui-dialog-body, and a sheet would render its own handle. Unmounting on
// close runs the effects' cleanups.
export function openViewModal(view, opts) {
  return openModal('', dialog => {
    dialog.replaceChildren();
    render(view, dialog);
    dialog.addEventListener('close', () => render(null, dialog));
  }, null, opts);
}

// A list page is one Preact tree under #app. The router unmounts it before
// any page writes #app, so effects clean up and a page that sets innerHTML
// never sits on top of a live tree.
let pageMounted = false;
/** @param {any} view */
export function mountPage(view) {
  const app = document.getElementById('app');
  if (!app) return;
  if (!pageMounted) app.replaceChildren();
  render(view, app);
  pageMounted = true;
}
// A view mounted inside imperative page markup (the route detail's meta
// panel). unmountPage tears these down with the page, because the router
// replaces #app's markup next and would otherwise strand their effects.
const extraRoots = new Set();
/** @param {any} view @param {Element} el */
export function mountExtra(view, el) {
  extraRoots.add(el);
  render(view, el);
}
export function unmountPage() {
  extraRoots.forEach(el => render(null, el));
  extraRoots.clear();
  if (!pageMounted) return;
  pageMounted = false;
  const app = document.getElementById('app');
  if (app) render(null, app);
}

// openModal wires .modal-close to its own close handling.
export function DialogHead({ title, lead }) {
  return html`<div class="ui-dialog-head">
    ${lead || html`<h2 class="ui-dialog-title">${title}</h2>`}
    <button type="button" class="ui-button ui-button-quiet ui-dialog-close modal-close" aria-label=${t('common.close')}>×</button>
  </div>`;
}

/** @param {{id?: string, label: any, required?: boolean, children?: any}} props */
export function Field({ id, label, required, children }) {
  const cls = 'ui-field-label' + (required ? ' ui-required' : '');
  return html`<div class="ui-field">
    ${id ? html`<label class=${cls} for=${id}>${label}</label>` : html`<span class=${cls}>${label}</span>`}
    ${children}
  </div>`;
}

export function ErrorBox({ id, msg }) {
  const ref = useRef(null);
  useEffect(() => {
    if (msg) ref.current.scrollIntoView({ block: 'nearest' });
  }, [msg]);
  return html`<div class=${'modal-error' + (msg ? ' visible' : '')} id=${id} ref=${ref}>${msg || ''}</div>`;
}

// Preact checks `checked` against the live element on every render, so a
// control whose state lived only in the DOM would snap back whenever a parent
// re-renders. Each control keeps its own state for that reason. onToggle gets
// the setter, so a failed save can put the switch back.
/** @param {{id: string, label: any, initial?: boolean, title?: string, onToggle?: Function}} props */
export function Toggle({ id, label, initial, title, onToggle }) {
  const [on, setOn] = useState(!!initial);
  const change = e => {
    const v = e.currentTarget.checked;
    setOn(v);
    if (onToggle) onToggle(v, setOn);
  };
  return html`<label class="ui-toggle-row" title=${title}>
    <span class="ui-toggle-text">${label}</span>
    <input type="checkbox" id=${id} checked=${on} onChange=${change} />
  </label>`;
}

export function RadioPills({ name, options, initial, variant, onPick }) {
  const [value, setValue] = useState(initial);
  const pick = e => {
    setValue(e.currentTarget.value);
    if (onPick) onPick(e.currentTarget.value);
  };
  return html`<div class=${'radio-row ' + (variant || 'radio-pills')}>
    ${options.map(([v, l]) => html`<label key=${v}><input type="radio" name=${name} value=${v} checked=${value === v} onChange=${pick} />${l}</label>`)}
  </div>`;
}

// Data a component loads from the API. A reload keeps the last data on
// screen until the new answer arrives.
export function useFetch(load, deps) {
  const [res, setRes] = useState({ status: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(
      data => { if (live) setRes({ status: 'ok', data }); },
      () => { if (live) setRes({ status: 'error' }); });
    return () => { live = false; };
  }, deps);
  return res;
}

// Copies the value of the input `target` points at. The fallback covers a
// browser without clipboard access, such as an insecure origin.
export function CopyButton({ target, ...rest }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const input = target.current;
    if (!input) return;
    const done = () => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    navigator.clipboard.writeText(input.value).then(done).catch(() => {
      input.select();
      document.execCommand('copy');
      done();
    });
  };
  return html`<button type="button" class="primary" ...${rest} onClick=${copy}>${copied ? t('common.copied') : t('common.copy')}</button>`;
}

const EYE_SHOWN = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_HIDDEN = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;

// The span keeps the SVG from being a direct flex child of the button, where
// it collapses to no width.
export function EyeIcon({ hidden }) {
  return html`<span class="eye-wrap">${hidden ? EYE_HIDDEN : EYE_SHOWN}</span>`;
}

// The eye on a category or region row: whether it starts hidden on the map.
// It saves on its own, apart from the dialog's Save, and updates the
// session's set so the next map navigation follows it. `attrs` carries the
// row's data attribute.
export function HideToggle({ prefKey, id, hiddenSet, className, attrs }) {
  const [hidden, setHidden] = useState(() => isDefaultHidden(prefKey, id));
  const toggle = () => {
    const now = !hidden;
    setDefaultHidden(prefKey, id, now);
    if (now) hiddenSet.add(id); else hiddenSet.delete(id);
    setHidden(now);
  };
  return html`<button type="button" ...${attrs} class=${className + ' btn-x' + (hidden ? ' is-hidden' : '')} aria-label=${t('common.defaultVisibility')}
    title=${hidden ? t('common.hiddenByDefault') : t('common.shownByDefault')} style="flex:0 0 auto" onClick=${toggle}><${EyeIcon} hidden=${hidden} /></button>`;
}

// The small tag at the end of an editable row: "edited", or a note on its
// state such as "unused". Empty text hides it through :empty.
export function RowTag({ text, dirty, inInput }) {
  return html`<span class=${'row-tag' + (inInput ? ' in-input' : '') + (dirty ? ' dirty' : '')}>${text}</span>`;
}
