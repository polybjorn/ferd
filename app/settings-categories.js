import { COLORS, escapeHtml, state } from './core.js';
import { dataLayer } from './offline-queue.js';
import { eyeIconHtml, isDefaultHidden, setDefaultHidden } from './prefs.js';
import { refreshPlacesPresentation } from './map-popups.js';
import { modalErrorHtml, modalHeaderHtml, openConfirmModal } from './select.js';
import { closeTopModal, openModal, showErrorBox } from './modal.js';

function slugifyCategory(s) {
  return (s || '').toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function openManageCategoriesModal() {
  const labels = state.config.category_labels || {};
  // Uncategorized ('') isn't a manageable slug — drop it.
  const slugsFromPlaces = [...new Set((state.places || []).concat(state.areas || []).map(p => p.category).filter(Boolean))];
  const allSlugs = [...new Set([...Object.keys(labels), ...slugsFromPlaces])];
  // Stored `order` (if any) wins; entries without one fall to the end,
  // ordered alphabetically by slug so the modal stays deterministic.
  allSlugs.sort((a, b) => {
    const oa = labels[a] && typeof labels[a].order === 'number' ? labels[a].order : Infinity;
    const ob = labels[b] && typeof labels[b].order === 'number' ? labels[b].order : Infinity;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
  const placeCountBySlug = {};
  if (state.places) {
    for (const p of state.places) {
      if (!p.category) continue;
      placeCountBySlug[p.category] = (placeCountBySlug[p.category] || 0) + 1;
    }
  }
  const rows = allSlugs.map((slug, i) => {
    const display = (labels[slug] && labels[slug].label) || '';
    // Color index: explicit stored value, or fall back to whatever the
    // current palette assignment is for this slug (so the dot shows the
    // color the user actually sees on the map).
    let color = (labels[slug] && typeof labels[slug].color === 'number') ? labels[slug].color : -1;
    if (color < 0) {
      const cur = state.categoryColors && state.categoryColors[slug];
      color = cur ? COLORS.indexOf(cur) : 0;
      if (color < 0) color = 0;
    }
    return { slug, display, original: display, color, originalColor: color, originalOrder: i, count: placeCountBySlug[slug] || 0 };
  });

  openModal(
    modalHeaderHtml('Manage categories') +
    '<h3 class="settings-h" style="margin-top:var(--ui-space-3)">Add</h3>' +
    '<div class="row" style="margin-top:var(--ui-space-1)">' +
      '<input type="text" id="cat-new-display" placeholder="e.g. Waterfalls">' +
      '<button type="button" class="primary" id="cat-add" style="flex:0 0 auto">Add</button>' +
    '</div>' +
    '<div class="hint" id="cat-new-slug-preview" hidden></div>' +
    modalErrorHtml('cat-error') +
    '<h3 class="settings-h" style="margin-top:var(--ui-space-5);display:flex;align-items:baseline;gap:var(--ui-space-2)">Categories' +
      '<span id="cat-clear-warning" class="action-warning" style="margin-left:auto;text-align:right" hidden></span></h3>' +
    '<div id="cat-rows"></div>' +
    '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-button ui-button-quiet" id="cat-reset-colors">Reset colors</button>' +
      '<span class="action-spacer"></span>' +
      '<span id="cat-save-slot" hidden><button type="button" class="ui-button ui-button-primary" id="cat-save">Save</button></span>' +
    '</div>',
    function() {
      const inUse = new Set(slugsFromPlaces);
      const pendingClears = new Set();  // in-use slugs the user removed; will bulk-clear on Save
      const initialRowKeys = new Set(rows.map(r => r.slug));
      function hasChanges() {
        if (pendingClears.size) return true;
        // Added, label-edited, color-edited, or reordered?
        if (rows.length !== initialRowKeys.size) return true;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!initialRowKeys.has(r.slug)) return true;
          if (r.display !== r.original) return true;
          if (r.color !== r.originalColor) return true;
          if (r.originalOrder !== i) return true;
        }
        return false;
      }
      let openSwatchIdx = -1;
      function refreshSaveBtn() {
        // The slot hides it: .ui-button's display beats the hidden attribute.
        const slot = document.getElementById('cat-save-slot');
        if (slot) slot.hidden = !hasChanges();
      }
      function refreshClearWarning() {
        const banner = document.getElementById('cat-clear-warning');
        if (!banner) return;
        if (!pendingClears.size) { banner.hidden = true; return; }
        const slugs = [...pendingClears];
        const total = state.places.filter(p => slugs.includes(p.category)).length;
        banner.textContent = total + ' place' + (total === 1 ? '' : 's') + ' will lose ' + (total === 1 ? 'its' : 'their') + ' category';
        banner.hidden = false;
      }
      function rerender() {
        const container = document.getElementById('cat-rows');
        if (!rows.length) {
          container.innerHTML = '<div class="hint">No categories yet.</div>';
          return;
        }
        container.innerHTML = rows.map((r, i) => {
          const labelDirty = r.display !== r.original;
          const colorDirty = r.color !== r.originalColor;
          const orderDirty = r.originalOrder !== i;
          const dirty = labelDirty || colorDirty || orderDirty;
          const dotColor = COLORS[r.color % COLORS.length];
          const open = openSwatchIdx === i;
          const swatchGrid = '<div class="cat-swatches' + (open ? ' open' : '') + '">' + COLORS.map((c, ci) =>
            '<button type="button" class="cat-swatch' + (ci === r.color ? ' active' : '') + '" data-i="' + i + '" data-ci="' + ci + '" style="background:' + c + '" title="Color ' + (ci + 1) + '"></button>'
          ).join('') + '</div>';
          const innerTag = dirty ? '<span class="row-tag in-input dirty">edited</span>'
                          : r.count === 0 ? '<span class="row-tag in-input">unused</span>'
                          : '<span class="row-tag in-input"></span>';
          return '<div class="cat-row" data-i="' + i + '" style="margin-top:var(--ui-space-2)">' +
            '<div style="display:flex;gap:var(--ui-space-2);align-items:center">' +
              '<button type="button" class="cat-drag btn-x" data-i="' + i + '" aria-label="Drag to reorder" title="Drag to reorder" style="flex:0 0 auto;cursor:grab;touch-action:none">&#x2630;</button>' +
              '<button type="button" class="cat-color-dot' + (open ? ' open' : '') + '" data-i="' + i + '" title="Change color" style="background:' + dotColor + '"></button>' +
              '<span class="cat-input-wrap" style="position:relative;flex:1;min-width:0;display:block">' +
                '<input type="text" data-i="' + i + '" class="cat-display' + (labelDirty ? ' dirty' : '') + '" value="' + escapeHtml(r.display) + '" placeholder="(falls back to title case)" title="' + escapeHtml('slug: ' + r.slug) + '" style="width:100%">' +
                innerTag +
              '</span>' +
              (function() { const h = isDefaultHidden('default-hidden-categories', r.slug); return '<button type="button" data-slug="' + escapeHtml(r.slug) + '" class="cat-hide btn-x' + (h ? ' is-hidden' : '') + '" aria-label="Default visibility on map" title="' + (h ? 'Hidden by default on the map' : 'Shown by default on the map') + '" style="flex:0 0 auto">' + eyeIconHtml(h) + '</button>'; })() +
              '<button type="button" data-i="' + i + '" class="cat-remove btn-x x-icon" aria-label="Remove" title="Remove" style="flex:0 0 auto"></button>' +
            '</div>' +
            swatchGrid +
          '</div>';
        }).join('');
        container.querySelectorAll('.cat-color-dot').forEach(btn => {
          btn.addEventListener('click', function() {
            const i = +this.dataset.i;
            const willOpen = openSwatchIdx !== i;
            // Close any previously-open grid so only one is expanded at a time.
            container.querySelectorAll('.cat-swatches.open, .cat-color-dot.open')
              .forEach(el => el.classList.remove('open'));
            if (willOpen) {
              const row = this.closest('div').parentElement;
              row.querySelector('.cat-swatches').classList.add('open');
              this.classList.add('open');
            }
            openSwatchIdx = willOpen ? i : -1;
          });
        });
        container.querySelectorAll('.cat-swatch').forEach(btn => {
          btn.addEventListener('click', function() {
            const i = +this.dataset.i;
            const ci = +this.dataset.ci;
            const r = rows[i];
            r.color = ci;
            openSwatchIdx = -1;
            // Animate the grid closed and update the dot color in place,
            // without re-rendering the whole list (which would skip the
            // closing transition).
            const row = this.closest('.cat-swatches').parentElement;
            row.querySelectorAll('.cat-swatch.active').forEach(el => el.classList.remove('active'));
            this.classList.add('active');
            row.querySelector('.cat-swatches').classList.remove('open');
            const dot = row.querySelector('.cat-color-dot');
            dot.style.background = COLORS[ci];
            dot.classList.remove('open');
            // Reflect dirty state in the row's tag without a full rerender.
            const labelDirty = r.display !== r.original;
            const colorDirty = r.color !== r.originalColor;
            const dirty = labelDirty || colorDirty;
            const tagEl = row.querySelector('.row-tag');
            if (tagEl) {
              tagEl.classList.toggle('dirty', dirty);
              tagEl.textContent = dirty ? 'edited'
                : r.count === 0 ? 'unused'
                : '';
            }
            refreshSaveBtn();
          });
        });
        container.querySelectorAll('.cat-display').forEach(inp => {
          inp.addEventListener('input', function() {
            const i = +this.dataset.i;
            const r = rows[i];
            r.display = this.value;
            const dirty = r.display !== r.original;
            this.classList.toggle('dirty', dirty);
            // Update the tag in this row without a full rerender (avoids
            // stealing focus while typing).
            const tagEl = this.parentElement.querySelector('.row-tag');
            if (!tagEl) return;
            if (dirty) {
              tagEl.textContent = 'edited';
              tagEl.classList.add('dirty');
            } else {
              tagEl.classList.remove('dirty');
              tagEl.textContent = r.count === 0 ? 'unused' : '';
            }
            refreshSaveBtn();
          });
        });
        // Default-visibility eye: persists instantly (its own synced pref),
        // independent of the label/color/order Save batch. Also updates the
        // in-session set so the next map navigation reflects it.
        container.querySelectorAll('.cat-hide').forEach(btn => {
          btn.addEventListener('click', function() {
            const slug = this.dataset.slug;
            const nowHidden = !isDefaultHidden('default-hidden-categories', slug);
            setDefaultHidden('default-hidden-categories', slug, nowHidden);
            if (nowHidden) state.hiddenCategories.add(slug); else state.hiddenCategories.delete(slug);
            this.classList.toggle('is-hidden', nowHidden);
            this.innerHTML = eyeIconHtml(nowHidden);
            this.title = nowHidden ? 'Hidden by default on the map' : 'Shown by default on the map';
          });
        });
        container.querySelectorAll('.cat-remove').forEach(btn => {
          btn.addEventListener('click', function() {
            if (this.disabled) return;
            const i = +this.dataset.i;
            const slug = rows[i].slug;
            if (inUse.has(slug)) pendingClears.add(slug);
            rows.splice(i, 1);
            rerender();
            refreshClearWarning();
            refreshSaveBtn();
          });
        });
        container.querySelectorAll('.cat-drag').forEach(handle => {
          handle.addEventListener('pointerdown', function(ev) {
            ev.preventDefault();
            const startIdx = +this.dataset.i;
            const rowEls = Array.from(container.querySelectorAll('.cat-row'));
            const rowEl = rowEls[startIdx];
            if (!rowEl) return;
            const startRect = rowEl.getBoundingClientRect();
            const offsetY = ev.clientY - startRect.top;
            let curIdx = startIdx;
            openSwatchIdx = -1;
            rowEl.classList.add('dragging');
            rowEl.style.position = 'relative';
            rowEl.style.zIndex = '5';
            rowEl.style.pointerEvents = 'none';
            rowEl.style.opacity = '0.85';
            this.style.cursor = 'grabbing';
            document.body.style.cursor = 'grabbing';
            function onMove(e) {
              // Reorder check first (compare cursor against the adjacent
              // non-dragged neighbor's center).
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
                // FLIP-animate the displaced neighbor(s): record old top,
                // do the DOM swap, set inverse transform, clear on next
                // frame to animate.
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
                  const newTop = a.el.getBoundingClientRect().top;
                  const dy = a.oldTop - newTop;
                  if (!dy) continue;
                  a.el.style.transition = 'none';
                  a.el.style.transform = 'translateY(' + dy + 'px)';
                  requestAnimationFrame(() => {
                    a.el.style.transition = '';
                    a.el.style.transform = '';
                  });
                }
              }
              // Re-anchor the dragged row under the cursor. Done AFTER any
              // DOM reorder so there's no paint-frame gap where the row
              // sits in its new slot without the lift transform.
              rowEl.style.transform = '';
              const natural = rowEl.getBoundingClientRect();
              rowEl.style.transform = 'translateY(' + (e.clientY - offsetY - natural.top) + 'px)';
            }
            function onUp() {
              document.removeEventListener('pointermove', onMove);
              document.removeEventListener('pointerup', onUp);
              document.removeEventListener('pointercancel', onUp);
              document.body.style.cursor = '';
              if (curIdx !== startIdx) {
                const [moved] = rows.splice(startIdx, 1);
                rows.splice(curIdx, 0, moved);
              }
              rerender();
              refreshSaveBtn();
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
          });
        });
      }
      rerender();
      refreshSaveBtn();

      const newDisplay = document.getElementById('cat-new-display');
      const slugPreview = document.getElementById('cat-new-slug-preview');
      newDisplay.addEventListener('input', function() {
        const s = slugifyCategory(this.value);
        if (s) {
          slugPreview.innerHTML = 'Will be saved as slug <code>' + escapeHtml(s) + '</code>.';
          slugPreview.hidden = false;
        } else {
          slugPreview.hidden = true;
        }
      });

      document.getElementById('cat-add').addEventListener('click', function() {
        const display = newDisplay.value.trim();
        const err = document.getElementById('cat-error');
        err.classList.remove('visible');
        if (!display) { showErrorBox(err, 'Display label required'); return; }
        const slug = slugifyCategory(display);
        if (!slug) { showErrorBox(err, 'Display label has no usable letters or digits for a slug'); return; }
        if (rows.some(r => r.slug === slug)) { showErrorBox(err, 'A category with slug "' + slug + '" already exists'); return; }
        rows.push({ slug, display, original: '', color: 0, originalColor: 0, originalOrder: rows.length, count: 0 });
        newDisplay.value = '';
        slugPreview.hidden = true;
        rerender();
        refreshSaveBtn();
      });

      document.getElementById('cat-reset-colors').addEventListener('click', function() {
        // Assign 0..n-1 mod palette length in current display order, so
        // reordering rows lets the user pick which category gets which
        // palette slot.
        rows.forEach((r, i) => { r.color = i % COLORS.length; });
        openSwatchIdx = -1;
        rerender();
        refreshSaveBtn();
      });

      document.getElementById('cat-save').addEventListener('click', function() {
        const submit = this;
        const doSave = function() {
        submit.disabled = true;
        const payload = {};
        rows.forEach((r, i) => {
          const label = r.display.trim();
          if (!label) return;
          payload[r.slug] = { label, color: r.color, order: i };
        });
        // Bulk-clear any in-use slugs the user removed, then PUT labels.
        // Clear failures abort the save so the label map and place data
        // don't get out of sync.
        const clears = [...pendingClears].map(slug =>
          dataLayer.clearCategory({ category: slug })
        );
        Promise.all(clears)
          .then(() => dataLayer.putCategoryLabels({ category_labels: payload }))
          .then(res => {
            state.config.category_labels = res.category_labels || payload;
            if (pendingClears.size && state.places) {
              // The server cleared `category` for these slugs; mirror it
              // locally so we don't have to refetch and rebuild markers.
              for (const p of state.places) {
                if (pendingClears.has(p.category)) p.category = '';
              }
              for (const a of state.areas || []) {
                if (pendingClears.has(a.category)) a.category = '';
              }
            }
            refreshPlacesPresentation();
            closeTopModal();
          })
          .catch(err => {
            submit.disabled = false;
            showErrorBox(document.getElementById('cat-error'), err.message);
          });
        };
        // Removing a category that places still use clears it from them on
        // save - confirm before that destructive bulk edit.
        if (pendingClears.size) {
          const slugs = [...pendingClears];
          const total = state.places.concat(state.areas || []).filter(p => slugs.includes(p.category)).length;
          const many = slugs.length > 1;
          openConfirmModal({
            title: 'Remove ' + (many ? 'categories' : 'category') + ' in use?',
            body: total + ' item' + (total === 1 ? '' : 's') + ' will lose ' + (total === 1 ? 'its' : 'their') + ' category (' + slugs.map(s => '"' + s + '"').join(', ') + ') when you save. This cannot be undone.',
            confirmLabel: 'Save',
            danger: true,
          }).then(ok => { if (ok) doSave(); });
        } else {
          doSave();
        }
      });
    }
  );
}
