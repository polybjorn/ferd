import { h, render, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { openModal } from './modal.js';

// The view layer: Preact components written as htm templates, so there is no
// build step. index.html maps the bare names to vendor/.
export { Fragment, useEffect, useRef, useState };
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

// openModal wires .modal-close to its own close handling.
export function DialogHead({ title, lead }) {
  return html`<div class="ui-dialog-head">
    ${lead || html`<h2 class="ui-dialog-title">${title}</h2>`}
    <button type="button" class="ui-button ui-button-quiet ui-dialog-close modal-close" aria-label="Close">×</button>
  </div>`;
}

export function Field({ id, label, children }) {
  return html`<div class="ui-field">
    ${id ? html`<label class="ui-field-label" for=${id}>${label}</label>` : html`<span class="ui-field-label">${label}</span>`}
    ${children}
  </div>`;
}

export function ErrorBox({ id, msg }) {
  return html`<div class=${'modal-error' + (msg ? ' visible' : '')} id=${id}>${msg || ''}</div>`;
}

// Preact checks `checked` against the live element on every render, so a
// control whose state lived only in the DOM would snap back whenever a parent
// re-renders. Each control keeps its own state for that reason. onToggle gets
// the setter, so a failed save can put the switch back.
export function Toggle({ id, label, initial, onToggle }) {
  const [on, setOn] = useState(!!initial);
  const change = e => {
    const v = e.currentTarget.checked;
    setOn(v);
    if (onToggle) onToggle(v, setOn);
  };
  return html`<label class="ui-toggle-row">
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
  return html`<button type="button" class="primary" ...${rest} onClick=${copy}>${copied ? 'Copied' : 'Copy'}</button>`;
}
