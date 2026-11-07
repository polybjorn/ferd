import { html, Toggle, useEffect, useRef, useState } from './view.js';
import { t } from './i18n.js';
import { getShowField } from './prefs.js';
import { wireCountryPicker } from './countries.js';
import { sortedCategorySlugs } from './core.js';
import { areas, places } from './store.js';

// The pieces the place, area and route forms share. Each control keeps its
// value in the form's state and reports changes up, so a payload is built
// from that state and never read back out of the DOM.

export const NEW_CHOICE = '__new__';

// FORM-FIELDS-BEGIN
/** @typedef {{ sel: string, text: string }} Choice */

/**
 * The state of a select-or-new control: a current value that is not in the
 * list opens "+ Add new" with the value in its text input.
 * @param {string | null | undefined} current
 * @param {string[]} options
 * @returns {Choice}
 */
export function choiceFrom(current, options) {
  if (current == null || current === '') return { sel: '', text: '' };
  if (options.includes(current)) return { sel: current, text: '' };
  return { sel: '__new__', text: current };
}

/** @param {Choice} choice */
export function choiceValue(choice) {
  return choice.sel === '__new__' ? choice.text.trim() : choice.sel;
}

/** @param {string} text One URL per line. */
export function sourcesFromText(text) {
  const raw = text.trim();
  return raw ? raw.split('\n').map(s => s.trim()).filter(Boolean) : [];
}

// Five decimals is about a metre; anything beyond is float noise that would
// pollute the stored JSON, and the marker is a 30 px dot anyway.
/** @param {number} n */
export function roundCoord(n) {
  return Math.round(n * 1e5) / 1e5;
}
// FORM-FIELDS-END

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

/**
 * Clickable 1-5 stars; a second click on the chosen star clears it. The
 * glyphs differ (filled and empty) so the state reads without colour.
 * @param {{ name: string, value: number, onChange: (n: number) => void }} props
 */
export function StarRating({ name, value, onChange }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return html`<div class="star-rating" data-name=${name} data-value=${value ? String(value) : ''}>
    ${[1, 2, 3, 4, 5].map(i => html`<span key=${i}
      class=${'star' + (!hover && i <= value ? ' filled' : '') + (hover && i <= hover ? ' preview' : '')}
      data-v=${i} onMouseEnter=${() => setHover(i)} onMouseLeave=${() => setHover(0)} onClick=${() => onChange(value === i ? 0 : i)}>${i <= shown ? '★' : '☆'}</span>`)}
    <a href="#" class="star-clear" onClick=${(/** @type {Event} */ e) => { e.preventDefault(); onChange(0); }}>${t('form.clear')}</a>
  </div>`;
}

/**
 * A select with a "+ Add new" entry that reveals a text input. By default the
 * empty option is hidden from the list, so a blank select means no choice;
 * `emptyLabel` shows it as a pickable entry instead.
 * @param {{ id: string, options: string[], labelOf?: (v: string) => string, value: Choice,
 *   onChange: (c: Choice) => void, newPlaceholder: string, emptyLabel?: string,
 *   addLabel?: string, focusNew?: boolean, maxLength?: number }} props
 */
export function SelectOrNew({ id, options, labelOf, value, onChange, newPlaceholder, emptyLabel, addLabel, focusNew, maxLength }) {
  const adding = value.sel === NEW_CHOICE;
  const input = useRef(/** @type {HTMLInputElement | null} */ (null));
  useEffect(() => {
    if (adding && focusNew && input.current) input.current.focus();
  }, [adding]);
  return html`<div class="select-or-new" data-id=${id}>
    <select id=${id} value=${value.sel} onChange=${(/** @type {Event} */ e) => onChange({ sel: valueOf(e), text: value.text })}>
      <option value="" hidden=${emptyLabel == null}>${emptyLabel || ''}</option>
      ${options.map(o => html`<option key=${o} value=${o}>${labelOf ? labelOf(o) : o}</option>`)}
      <option value=${NEW_CHOICE}>${addLabel || t('form.addNew')}</option>
    </select>
    <input type="text" class="new-input" id=${id + '-new'} ref=${input} placeholder=${newPlaceholder} value=${value.text}
      maxlength=${maxLength} hidden=${!adding} required=${adding} onInput=${(/** @type {Event} */ e) => onChange({ sel: value.sel, text: valueOf(e) })} />
  </div>`;
}

/**
 * The expanding block under a toggle.
 * @param {{ id?: string, open: boolean, children?: any }} props
 */
export function Collapsible({ id, open, children }) {
  return html`<div class=${'collapsible' + (open ? ' expanded' : '')} id=${id}>
    <div class="collapsible-inner">${children}</div>
  </div>`;
}

/**
 * A toggle for "visited" or "completed" with the date and rating that go
 * with it. The extras follow Settings > Optional fields.
 * @param {{ ids: { toggle: string, extras: string, date: string, rating: string }, label: string,
 *   dateLabel: string, on: boolean, onToggle: (on: boolean) => void, date: string,
 *   onDate: (s: string) => void, rating: number, onRating: (n: number) => void }} props
 */
export function DoneFields({ ids, label, dateLabel, on, onToggle, date, onDate, rating, onRating }) {
  const showDate = getShowField('date');
  const showRating = getShowField('rating');
  return html`<div>
    <${Toggle} id=${ids.toggle} label=${label} initial=${on} onToggle=${onToggle} />
    ${(showDate || showRating) && html`<${Collapsible} id=${ids.extras} open=${on}>
      <div class="ui-section">
        ${showDate && html`<div class="ui-field">
          <label class="ui-field-label" for=${ids.date}>${dateLabel}</label>
          <input type="date" id=${ids.date} value=${date} onInput=${(/** @type {Event} */ e) => onDate(valueOf(e))} />
        </div>`}
        ${showRating && html`<div class="ui-field">
          <span class="ui-field-label">${t('form.rating')}</span>
          <${StarRating} name=${ids.rating} value=${rating} onChange=${onRating} />
        </div>`}
      </div>
    <//>`}
  </div>`;
}

// The picker adds its list beside the input, so the input is the wrapper's
// only child and Preact never reorders around the list.
/** @param {{ id: string, value: string, onInput: (s: string) => void }} props */
export function CountryInput({ id, value, onInput }) {
  useEffect(() => { wireCountryPicker(id); }, []);
  return html`<div><input type="text" id=${id} value=${value} onInput=${(/** @type {Event} */ e) => onInput(valueOf(e))} /></div>`;
}

/**
 * A file input behind a button. `inputRef` lets the form clear the file.
 * @param {{ id: string, accept: string, required?: boolean, file: File | null,
 *   onFile: (f: File | null) => void, inputRef?: { current: HTMLInputElement | null } }} props
 */
export function FilePick({ id, accept, required, file, onFile, inputRef }) {
  const own = useRef(/** @type {HTMLInputElement | null} */ (null));
  const ref = inputRef || own;
  return html`<div class="ui-control-row">
    <input type="file" id=${id} ref=${ref} tabindex="-1" accept=${accept} class="file-input-hidden" required=${required}
      onChange=${(/** @type {Event} */ e) => { const files = /** @type {HTMLInputElement} */ (e.currentTarget).files; onFile(files && files[0] || null); }} />
    <button type="button" class="primary" id=${id + '-pick'} onClick=${() => ref.current && ref.current.click()}>${t('form.chooseFile')}</button>
    <span class=${'ui-control-text' + (file ? ' has-file' : '')} id=${id + '-name'}>${file ? file.name : t('form.noFile')}</span>
  </div>`;
}

/** The difficulty choices of a route, in the order the form lists them. */
export function difficultyOptions() {
  return [
    ['', t('form.diffNone')], ['easy', t('form.diffEasy')], ['moderate', t('form.diffModerate')],
    ['hard', t('form.diffHard')], ['expert', t('form.diffExpert')],
  ];
}

// The categories places and areas use. "No category" is the blank option of
// the control, so the uncategorized bucket is not listed.
export function categorySlugs() {
  const used = new Set(places.value.concat(areas.value).map((/** @type {{category?: string}} */ p) => p.category));
  return sortedCategorySlugs([...used].filter(Boolean));
}
