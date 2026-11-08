/**
 * Makes a search field a combobox over the option rows of a listbox, the
 * pattern the country field follows: the arrow keys walk the rows, Enter
 * picks the active one and Escape closes the list. Focus stays in the field,
 * and aria-activedescendant names the row. Call refresh after each render.
 * A list that holds more than its options names its listbox in controls.
 * @param {HTMLInputElement} input
 * @param {HTMLElement} listbox
 * @param {{ pick: (row: HTMLElement) => void, close?: () => void, controls?: string }} on
 * @returns {{ refresh: (open: boolean) => void }}
 */
export function bindSearchKeys(input, listbox, on) {
  let active = -1;
  /** @returns {HTMLElement[]} */
  const rows = () => Array.from(listbox.querySelectorAll('[role="option"]'));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', on.controls || listbox.id);
  input.setAttribute('aria-expanded', 'false');
  /** @param {number} i */
  const setActive = i => {
    const all = rows();
    if (all[active]) all[active].classList.remove('active');
    active = i;
    if (all[i]) {
      all[i].classList.add('active');
      all[i].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', all[i].id);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };
  input.addEventListener('keydown', e => {
    // A list hidden by a click elsewhere keeps its rows; they wait for typing.
    if (input.getAttribute('aria-expanded') !== 'true') return;
    const all = rows();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!all.length) return;
      e.preventDefault();
      const n = all.length;
      setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
    } else if (e.key === 'Enter' && all[active]) {
      e.preventDefault();
      on.pick(all[active]);
    } else if (e.key === 'Escape' && on.close) {
      e.preventDefault();
      e.stopPropagation();
      on.close();
    }
  });
  return {
    refresh(open) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
      rows().forEach((row, i) => { row.id = listbox.id + '-' + i; row.classList.remove('active'); });
      input.setAttribute('aria-expanded', String(open));
    },
  };
}
