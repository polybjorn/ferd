import { COLORS, state } from '../core.js';
import { dataLayer } from '../store.js';
import { t, tx } from '../i18n.js';
import { refreshPlacesPresentation } from '../map-popups.js';
import { openConfirmModal } from '../select.js';
import { closeTopModal } from '../modal.js';
import {
  DialogHead, ErrorBox, HideToggle, RowTag, html, openViewModal, useRef, useState,
} from '../view.js';

function slugifyCategory(s) {
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const rowDirty = (r, i) => r.display !== r.original || r.color !== r.originalColor || r.originalOrder !== i;

function CategoryRow({ r, index, open, onToggleSwatches, onColor, onDisplay, onRemove, onDragStart }) {
  const labelDirty = r.display !== r.original;
  const dirty = rowDirty(r, index);
  const tag = dirty ? t('common.edited') : r.count === 0 ? t('categories.unused') : '';
  return html`<div class="cat-row" data-i=${index} style="margin-top:var(--ui-space-2)">
    <div style="display:flex;gap:var(--ui-space-2);align-items:center">
      <button type="button" class="cat-drag btn-x" data-i=${index} aria-label=${t('categories.drag')} title=${t('categories.drag')}
        style="flex:0 0 auto;cursor:grab;touch-action:none" onPointerDown=${e => onDragStart(e, index)}>☰</button>
      <button type="button" class=${'cat-color-dot' + (open ? ' open' : '')} data-i=${index} title=${t('categories.changeColor')}
        style=${'background:' + COLORS[r.color % COLORS.length]} onClick=${onToggleSwatches}></button>
      <span class="cat-input-wrap" style="position:relative;flex:1;min-width:0;display:block">
        <input type="text" data-i=${index} class=${'cat-display' + (labelDirty ? ' dirty' : '')} value=${r.display}
          placeholder=${t('categories.labelPlaceholder')} title=${t('categories.slugTitle', { slug: r.slug })} style="width:100%"
          onInput=${e => onDisplay(e.currentTarget.value)} />
        <${RowTag} text=${tag} dirty=${dirty} inInput />
      </span>
      <${HideToggle} prefKey="default-hidden-categories" id=${r.slug} hiddenSet=${state.hiddenCategories} className="cat-hide" attrs=${{ 'data-slug': r.slug }} />
      <button type="button" data-i=${index} class="cat-remove btn-x x-icon" aria-label=${t('common.remove')} title=${t('common.remove')}
        style="flex:0 0 auto" onClick=${onRemove}></button>
    </div>
    <div class=${'cat-swatches' + (open ? ' open' : '')}>
      ${COLORS.map((c, ci) => html`<button type="button" key=${ci} class=${'cat-swatch' + (ci === r.color ? ' active' : '')} data-i=${index} data-ci=${ci}
        style=${'background:' + c} title=${t('categories.color', { n: ci + 1 })} onClick=${() => onColor(ci)}></button>`)}
    </div>
  </div>`;
}

// Drags a row by DOM transforms while the pointer is down, and hands the
// final position to `commit`. Preact never sees the live moves, so the rows
// go back to their rendered order and lose the drag styles first; the state
// change then reorders them.
function dragRow(ev, startIdx, container, onStart, commit) {
  ev.preventDefault();
  const rowEls = Array.from(container.querySelectorAll('.cat-row'));
  const rowEl = rowEls[startIdx];
  if (!rowEl) return;
  const rendered = rowEls.slice();
  const handle = ev.currentTarget;
  const offsetY = ev.clientY - rowEl.getBoundingClientRect().top;
  let curIdx = startIdx;
  onStart();
  rowEl.classList.add('dragging');
  rowEl.style.position = 'relative';
  rowEl.style.zIndex = '5';
  rowEl.style.pointerEvents = 'none';
  rowEl.style.opacity = '0.85';
  handle.style.cursor = 'grabbing';
  document.body.style.cursor = 'grabbing';
  function onMove(e) {
    // Compare the cursor against the adjacent neighbour's centre.
    let newIdx = curIdx;
    if (curIdx > 0) {
      const prev = rowEls[curIdx - 1].getBoundingClientRect();
      if (e.clientY < prev.top + prev.height / 2) newIdx = curIdx - 1;
    }
    if (newIdx === curIdx && curIdx < rowEls.length - 1) {
      const next = rowEls[curIdx + 1].getBoundingClientRect();
      if (e.clientY > next.top + next.height / 2) newIdx = curIdx + 1;
    }
    if (newIdx !== curIdx) {
      // FLIP: record the displaced rows' tops, swap, then animate from the
      // old position.
      const lo = Math.min(curIdx, newIdx);
      const hi = Math.max(curIdx, newIdx);
      const affected = [];
      for (let k = lo; k <= hi; k++) {
        if (k === curIdx) continue;
        affected.push({ el: rowEls[k], oldTop: rowEls[k].getBoundingClientRect().top });
      }
      const ref = newIdx > curIdx ? rowEls[newIdx].nextSibling : rowEls[newIdx];
      container.insertBefore(rowEl, ref);
      rowEls.splice(curIdx, 1);
      rowEls.splice(newIdx, 0, rowEl);
      curIdx = newIdx;
      for (const a of affected) {
        const dy = a.oldTop - a.el.getBoundingClientRect().top;
        if (!dy) continue;
        a.el.style.transition = 'none';
        a.el.style.transform = 'translateY(' + dy + 'px)';
        requestAnimationFrame(() => {
          a.el.style.transition = '';
          a.el.style.transform = '';
        });
      }
    }
    // After any reorder, so the row never paints in its new slot without the
    // lift transform.
    rowEl.style.transform = '';
    const natural = rowEl.getBoundingClientRect();
    rowEl.style.transform = 'translateY(' + (e.clientY - offsetY - natural.top) + 'px)';
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
    document.body.style.cursor = '';
    handle.style.cursor = '';
    rendered.forEach(el => container.appendChild(el));
    for (const p of ['position', 'zIndex', 'pointerEvents', 'opacity', 'transform']) rowEl.style[p] = '';
    rowEl.classList.remove('dragging');
    commit(startIdx, curIdx);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

function CategoriesView({ initial, inUse }) {
  const [rows, setRows] = useState(initial);
  const [initialKeys] = useState(() => new Set(initial.map(r => r.slug)));
  // In-use slugs the user removed, bulk-cleared on Save.
  const [cleared, setCleared] = useState([]);
  const [openSwatch, setOpenSwatch] = useState(null);
  const [newText, setNewText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const newSlug = slugifyCategory(newText);
  const changed = cleared.length > 0 || rows.length !== initialKeys.size ||
    rows.some((r, i) => !initialKeys.has(r.slug) || rowDirty(r, i));
  const lost = cleared.length ? state.places.filter(p => cleared.includes(p.category)).length : 0;
  const patch = (slug, fields) => setRows(list => list.map(r => (r.slug === slug ? { ...r, ...fields } : r)));

  const add = () => {
    const display = newText.trim();
    setError('');
    if (!display) { setError(t('categories.labelRequired')); return; }
    const slug = slugifyCategory(display);
    if (!slug) { setError(t('categories.noSlug')); return; }
    if (rows.some(r => r.slug === slug)) { setError(t('categories.slugExists', { slug })); return; }
    setRows(list => list.concat({ slug, display, original: '', color: 0, originalColor: 0, originalOrder: list.length, count: 0 }));
    setNewText('');
  };
  const remove = slug => {
    if (inUse.has(slug)) setCleared(list => list.concat(slug));
    setRows(list => list.filter(r => r.slug !== slug));
  };
  // Colours run 0..n-1 in the current display order, so reordering decides
  // which category gets which palette slot.
  const resetColors = () => {
    setRows(list => list.map((r, i) => ({ ...r, color: i % COLORS.length })));
    setOpenSwatch(null);
  };
  const reorder = (from, to) => {
    if (from === to) return;
    setRows(list => {
      const next = list.slice();
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  };

  const doSave = () => {
    setBusy(true);
    const payload = {};
    rows.forEach((r, i) => {
      const label = r.display.trim();
      if (!label) return;
      payload[r.slug] = { label, color: r.color, order: i };
    });
    // A failed clear aborts the save so the label map and the places don't
    // drift apart.
    Promise.all(cleared.map(slug => dataLayer.clearCategory({ category: slug })))
      .then(() => dataLayer.putCategoryLabels({ category_labels: payload }))
      .then(res => {
        state.config.category_labels = res.category_labels || payload;
        refreshPlacesPresentation();
        closeTopModal();
      })
      .catch(err => { setBusy(false); setError(err.message); });
  };
  const save = () => {
    setError('');
    if (!cleared.length) { doSave(); return; }
    const total = [...state.places, ...(state.areas || [])].filter(p => cleared.includes(p.category)).length;
    openConfirmModal({
      title: t('categories.confirmTitle', { count: cleared.length }),
      body: t('categories.confirmBody', { count: total, slugs: cleared.map(s => '"' + s + '"').join(', ') }),
      confirmLabel: t('common.save'),
      danger: true,
    }).then(ok => { if (ok) doSave(); });
  };

  return html`
    <${DialogHead} title=${t('categories.title')} />
    <div class="ui-dialog-body">
      <h3 class="settings-h" style="margin-top:var(--ui-space-3)">${t('categories.add')}</h3>
      <div class="row" style="margin-top:var(--ui-space-1)">
        <input type="text" id="cat-new-display" placeholder=${t('categories.newPlaceholder')} value=${newText} onInput=${e => setNewText(e.currentTarget.value)} />
        <button type="button" class="primary" id="cat-add" style="flex:0 0 auto" onClick=${add}>${t('categories.add')}</button>
      </div>
      <div class="hint" id="cat-new-slug-preview" hidden=${!newSlug}>${newSlug && tx('categories.slugPreview', { slug: html`<code>${newSlug}</code>` })}</div>
      <${ErrorBox} id="cat-error" msg=${error} />
      <h3 class="settings-h" style="margin-top:var(--ui-space-5);display:flex;align-items:baseline;gap:var(--ui-space-2)">${t('categories.heading')}
        <span id="cat-clear-warning" class="action-warning" style="margin-left:auto;text-align:right" hidden=${!lost}>${lost ? t('categories.clearWarning', { count: lost }) : ''}</span></h3>
      <div id="cat-rows" ref=${listRef}>
        ${rows.length ? rows.map((r, i) => html`<${CategoryRow} key=${r.slug} r=${r} index=${i} open=${openSwatch === r.slug}
          onToggleSwatches=${() => setOpenSwatch(openSwatch === r.slug ? null : r.slug)}
          onColor=${ci => { patch(r.slug, { color: ci }); setOpenSwatch(null); }}
          onDisplay=${v => patch(r.slug, { display: v })}
          onRemove=${() => remove(r.slug)}
          onDragStart=${(e, idx) => dragRow(e, idx, listRef.current, () => setOpenSwatch(null), reorder)} />`)
          : html`<div class="hint">${t('categories.empty')}</div>`}
      </div>
    </div>
    <div class="ui-dialog-actions">
      <button type="button" class="ui-button ui-button-quiet" id="cat-reset-colors" onClick=${resetColors}>${t('categories.resetColors')}</button>
      <span class="action-spacer"></span>
      <span id="cat-save-slot" hidden=${!changed}><button type="button" class="ui-button ui-button-primary" id="cat-save" disabled=${busy} onClick=${save}>${t('common.save')}</button></span>
    </div>`;
}

export function openManageCategoriesModal() {
  const labels = state.config.category_labels || {};
  // Uncategorized ('') isn't a manageable slug, so it is dropped.
  const slugsFromPlaces = [...new Set([...(state.places || []), ...(state.areas || [])].map(p => p.category).filter(Boolean))];
  const allSlugs = [...new Set([...Object.keys(labels), ...slugsFromPlaces])];
  // A stored `order` wins; entries without one go last, alphabetical by slug,
  // so the dialog stays deterministic.
  allSlugs.sort((a, b) => {
    const oa = labels[a] && typeof labels[a].order === 'number' ? labels[a].order : Infinity;
    const ob = labels[b] && typeof labels[b].order === 'number' ? labels[b].order : Infinity;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
  const placeCountBySlug = {};
  for (const p of state.places || []) {
    if (!p.category) continue;
    placeCountBySlug[p.category] = (placeCountBySlug[p.category] || 0) + 1;
  }
  const initial = allSlugs.map((slug, i) => {
    const display = (labels[slug] && labels[slug].label) || '';
    // Without a stored colour the dot shows the one the map currently uses.
    let color = (labels[slug] && typeof labels[slug].color === 'number') ? labels[slug].color : -1;
    if (color < 0) {
      const cur = state.categoryColors && state.categoryColors[slug];
      color = cur ? COLORS.indexOf(cur) : 0;
      if (color < 0) color = 0;
    }
    return { slug, display, original: display, color, originalColor: color, originalOrder: i, count: placeCountBySlug[slug] || 0 };
  });
  openViewModal(html`<${CategoriesView} initial=${initial} inUse=${new Set(slugsFromPlaces)} />`, { phone: 'fullscreen' });
}
