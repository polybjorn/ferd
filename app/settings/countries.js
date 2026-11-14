import { dataLayer, visitedCountries } from '../store.js';
import { countryCodeOf, loadCountryPick } from '../countries.js';
import { CountryInput } from '../form-fields.js';
import { t } from '../i18n.js';
import { html, useEffect, useState } from '../view.js';

/** @typedef {import('../countries.js').CountryPick} CountryPick */

// Countries marked visited by hand, for the ones no visited place lies in.
// The map fill is the union of these and the countries of visited places.
/** @param {{ code: string, name: string }} props */
function CountryRow({ code, name }) {
  return html`<li class="ui-list-item session-row">
    <div class="ui-list-item-main">${name}</div>
    <button type="button" class="ui-button ui-button-danger ui-list-item-end country-remove" data-code=${code}
      onClick=${() => dataLayer.setCountryVisited(code, false)}>${t('common.remove')}</button>
  </li>`;
}

// The picker's open list sits in the flow and closes when the input blurs,
// which on a phone also scrolls the dialog. The row aligns to the top and
// Add keeps the input focused through the press, so nothing moves under it.
export function MarkedCountries() {
  const [pick, setPick] = useState(/** @type {CountryPick | null} */ (null));
  const [name, setName] = useState('');
  useEffect(() => { loadCountryPick().then(setPick, err => console.warn('[ferd] country list:', err.message)); }, []);
  const codes = visitedCountries.value;
  const nameOf = (/** @type {string} */ code) => {
    const hit = pick && pick.countries.find((/** @type {{ code: string }} */ c) => c.code === code);
    return hit ? hit.name : code;
  };
  const code = pick ? countryCodeOf(name, pick.countries, pick.names) : null;
  const add = () => {
    if (!code) return;
    dataLayer.setCountryVisited(code, true);
    setName('');
    const input = document.getElementById('s-country-add');
    if (input) input.blur();
  };
  const rows = codes.map((/** @type {string} */ c) => ({ code: c, name: nameOf(c) }))
    .sort((/** @type {{ name: string }} */ a, /** @type {{ name: string }} */ b) => a.name.localeCompare(b.name));
  return html`
    <h3 class="settings-h">${t('settings.general.markedCountries')}</h3>
    <div class="hint">${t('settings.general.markedCountriesHint')}</div>
    <div class="ui-control-row country-add-row">
      <div class="ui-field"><${CountryInput} id="s-country-add" value=${name} onInput=${setName} /></div>
      <button type="button" class="ui-button ui-button-primary" id="s-country-add-btn" disabled=${!code} onMouseDown=${(/** @type {Event} */ e) => e.preventDefault()} onClick=${add}>${t('common.add')}</button>
    </div>
    <ul class="session-list" id="s-country-list">${rows.map((/** @type {{ code: string, name: string }} */ r) => html`<${CountryRow} key=${r.code} code=${r.code} name=${r.name} />`)}</ul>`;
}
