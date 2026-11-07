import { escapeHtml, state } from './core.js';
import { reloadCatalogCache } from './places-list.js';
import { api } from './auth.js';
import { renderAdminCatalog } from './settings-account.js';
import { modalErrorHtml, modalHeaderHtml, openConfirmModal } from './select.js';
import { closeModal, openFullScreenModal, showErrorBox } from './modal.js';

export function openCatalogManager() {
  openFullScreenModal(
    modalHeaderHtml(null, {titleHtml: 'Manage catalog<span id="cat-mgr-count" class="modal-title-count"></span>'}) +
    '<input type="text" id="cat-mgr-filter" placeholder="Filter…" style="margin-bottom:var(--ui-space-2)">' +
    '<div id="cat-mgr-list"></div>' +
    '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-button ui-button-quiet" id="cat-mgr-notes-toggle">Show notes</button>' +
      '<span class="action-spacer"></span>' +
      '<button type="button" id="cat-mgr-clear" class="ui-button ui-button-danger">Remove all</button>' +
    '</div>',
    function() {
      const filter = document.getElementById('cat-mgr-filter');
      const list = document.getElementById('cat-mgr-list');

      const countEl = document.getElementById('cat-mgr-count');
      function render() {
        // `?include_hidden=1` brings back the shipped entries the admin
        // has suppressed (tagged with _hidden: true) so they can be
        // unhidden from this modal.
        api('GET', '/catalog?include_hidden=1').then(entries => {
          const items = Array.isArray(entries) ? entries.slice() : [];
          countEl.textContent = items.length ? '(' + items.length + ')' : '';
          if (!items.length) {
            list.innerHTML = '<div class="hint">Catalog is empty.</div>';
            return;
          }
          items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          const eyeOn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
          const eyeOff = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';
          list.innerHTML = '<ul class="user-list">' + items.map(e => {
            const meta = [e.category, e.country].filter(Boolean).join(' · ');
            const name = escapeHtml(e.name || '(unnamed)');
            const note = (e.note || '').trim();
            const shipped = e._source === 'shipped';
            const hidden = !!e._hidden;
            // Source is conveyed by the action button (eye for shipped,
            // Remove for local). Hidden state is conveyed by the row
            // opacity + the eye-off glyph. No text tag.
            const action = shipped
              ? '<button data-act="catalog-hide" data-hidden="' + (hidden ? '1' : '0') + '" class="catalog-eye-btn" title="' + (hidden ? 'Unhide for users' : 'Hide from users') + '" aria-label="' + (hidden ? 'Unhide' : 'Hide') + '">' + (hidden ? eyeOff : eyeOn) + '</button>'
              : '<button data-act="catalog-delete" class="danger-btn">Remove</button>';
            return '<li class="user-row" data-name="' + escapeHtml(e.name || '') + '"' + (hidden ? ' style="opacity:0.6"' : '') + '>' +
              '<span class="user-name" style="min-width:0">' +
                '<span title="' + name + '" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</span>' +
                (meta ? '<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted);font-weight:400">' + escapeHtml(meta) + '</span>' : '') +
                (note ? '<span class="row-note">' + escapeHtml(note) + '</span>' : '') +
              '</span>' +
              '<div class="user-actions">' + action + '</div>' +
            '</li>';
          }).join('') + '</ul>';
          list.querySelectorAll('button[data-act="catalog-delete"]').forEach(btn => {
            btn.addEventListener('click', function() {
              const name = this.closest('.user-row').dataset.name;
              openConfirmModal({
                title: 'Remove from catalog',
                body: 'Remove "' + name + '" from the site catalog? Users who already imported it keep their copy.',
                confirmLabel: 'Remove',
                danger: true,
              }).then(ok => {
                if (!ok) return;
                this.disabled = true;
                api('POST', '/admin/catalog/delete', { names: [name] })
                  .then(() => { state._catalogCache = null; render(); renderAdminCatalog(); reloadCatalogCache(); })
                  .catch(err => { this.disabled = false; alert('Failed: ' + err.message); });
              });
            });
          });
          list.querySelectorAll('button[data-act="catalog-hide"]').forEach(btn => {
            btn.addEventListener('click', function() {
              const name = this.closest('.user-row').dataset.name;
              const wantHidden = this.dataset.hidden !== '1';
              this.disabled = true;
              api('POST', '/admin/catalog/hide', { name, hidden: wantHidden })
                .then(() => { state._catalogCache = null; render(); renderAdminCatalog(); reloadCatalogCache(); })
                .catch(err => { this.disabled = false; alert('Failed: ' + err.message); });
            });
          });
          applyFilter();
        }).catch(() => {
          list.innerHTML = '<div class="hint">Could not load catalog.</div>';
        });
      }

      function applyFilter() {
        const q = filter.value.trim().toLowerCase();
        list.querySelectorAll('.user-row').forEach(row => {
          row.style.display = (!q || row.textContent.toLowerCase().includes(q)) ? '' : 'none';
        });
      }
      filter.addEventListener('input', applyFilter);
      const notesToggle = document.getElementById('cat-mgr-notes-toggle');
      notesToggle.addEventListener('click', function() {
        list.classList.add('notes-anim');
        const on = list.classList.toggle('show-notes');
        this.textContent = on ? 'Hide notes' : 'Show notes';
      });
      const clearBtn = document.getElementById('cat-mgr-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', function() {
          openConfirmModal({
            title: 'Remove all local catalog entries',
            body: 'Empties only the local catalog additions. Shipped entries remain (toggle them off above to hide). Users who already imported keep their copies.',
            confirmLabel: 'Remove all',
            danger: true,
          }).then(ok => {
            if (!ok) return;
            clearBtn.disabled = true;
            api('POST', '/admin/catalog/clear')
              .then(() => { state._catalogCache = null; render(); renderAdminCatalog(); reloadCatalogCache(); })
              .catch(err => alert('Failed: ' + err.message))
              .then(() => { clearBtn.disabled = false; });
          });
        });
      }
      render();
    }
  );
}

export function openCatalogPicker() {
  const own = Array.isArray(state.places) ? state.places : [];
  if (!own.length) {
    alert('You have no places to promote yet. Add some first.');
    return;
  }
  api('GET', '/catalog').then(catalog => {
    const inCatalog = new Set((Array.isArray(catalog) ? catalog : []).map(e => e && e.name).filter(Boolean));
    const places = own.filter(p => !inCatalog.has(p.name));
    if (!places.length) {
      alert('All your places are already in the catalog.');
      return;
    }
    places.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderCatalogPicker(places);
  }).catch(err => alert('Could not load catalog: ' + err.message));
}

function renderCatalogPicker(places) {
  const rows = places.map((p, i) => {
    const meta = [p.category, p.country].filter(Boolean).join(' · ');
    const name = escapeHtml(p.name || '(unnamed)');
    const note = (p.note || '').trim();
    return '<label class="browse-row" data-idx="' + i + '" style="display:flex;align-items:flex-start;gap:var(--ui-space-2);padding:var(--ui-space-2) 0;border-bottom:1px solid var(--border);cursor:pointer">' +
      '<input type="checkbox" class="ui-check cat-pick" data-idx="' + i + '" style="margin-top:var(--ui-space-1)">' +
      '<span style="flex:1;min-width:0">' +
        '<span title="' + name + '" style="display:block;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</span>' +
        (meta ? '<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted)">' + escapeHtml(meta) + '</span>' : '') +
        (note ? '<span class="row-note">' + escapeHtml(note) + '</span>' : '') +
      '</span>' +
    '</label>';
  }).join('');
  openFullScreenModal(
    modalHeaderHtml('Add to catalog') +
    '<input type="text" id="cat-filter" placeholder="Filter…" style="margin-bottom:var(--ui-space-2)">' +
    '<div id="cat-list">' + rows + '</div>' +
    modalErrorHtml('add-error') +
    '<div class="ui-dialog-actions">' +
      '<button type="button" class="ui-button ui-button-quiet" id="cat-notes-toggle">Show notes</button>' +
      '<span id="cat-status" style="font-size:var(--ui-text-xs);color:var(--muted);flex:1"></span>' +
      '<button type="button" class="ui-button" id="cat-select-all">Select all</button>' +
      '<button type="button" class="ui-button ui-button-primary" id="cat-submit" disabled>Add selected</button>' +
    '</div>',
    function() {
      const filter = document.getElementById('cat-filter');
      const list = document.getElementById('cat-list');
      const submit = document.getElementById('cat-submit');
      const selectAll = document.getElementById('cat-select-all');
      const status = document.getElementById('cat-status');
      // state.places carries runtime annotations (`_slug`, normalized empty
      // `category`) that aren't part of the server-side place schema; only
      // forward the documented fields.
      const ALLOWED = ['name', 'lat', 'lon', 'category', 'country', 'visited', 'note', 'sources', 'local_name', 'date_visited', 'rating'];
      function visibleRows() {
        return Array.from(list.querySelectorAll('.browse-row')).filter(r => r.style.display !== 'none');
      }
      function cleanPlace(p) {
        const out = {};
        for (const k of ALLOWED) {
          if (p[k] === '' && k === 'category') continue;
          if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
        }
        return out;
      }
      function updateBtns() {
        const checked = list.querySelectorAll('.cat-pick:checked').length;
        submit.disabled = checked === 0;
        submit.textContent = checked ? 'Add ' + checked + ' selected' : 'Add selected';
        const vis = visibleRows();
        const visChecked = vis.filter(r => { const cb = r.querySelector('.cat-pick'); return cb && cb.checked; }).length;
        selectAll.disabled = vis.length === 0;
        selectAll.textContent = (vis.length > 0 && visChecked === vis.length) ? 'Deselect all' : 'Select all';
      }
      list.addEventListener('change', updateBtns);
      filter.addEventListener('input', function() {
        const q = this.value.trim().toLowerCase();
        list.querySelectorAll('.browse-row').forEach(row => {
          row.style.display = (!q || row.textContent.toLowerCase().includes(q)) ? 'flex' : 'none';
        });
        updateBtns();
      });
      function submitPicks(picks) {
        if (!picks.length) return;
        openConfirmModal({
          title: 'Add to catalog?',
          body: 'Add ' + picks.length + ' place' + (picks.length === 1 ? '' : 's') + ' to the shared catalog? They become available for everyone to browse and import.',
          confirmLabel: 'Add ' + picks.length,
        }).then(ok => { if (ok) doSubmit(picks); });
      }
      function doSubmit(picks) {
        submit.disabled = true;
        selectAll.disabled = true;
        status.textContent = 'Adding…';
        const errEl = document.getElementById('add-error');
        if (errEl) errEl.classList.remove('visible');
        return api('POST', '/admin/catalog/add', { entries: picks })
          .then(r => {
            state._catalogCache = null;
            closeModal();
            renderAdminCatalog();
            reloadCatalogCache();
            if (r.skipped) {
              // Surface skip count so the admin knows dedup happened.
              alert('Added ' + r.added + ', skipped ' + r.skipped + ' (already in catalog).');
            }
          })
          .catch(err => {
            submit.disabled = false;
            status.textContent = '';
            updateBtns();
            const e = document.getElementById('add-error');
            if (e) showErrorBox(e, err.message);
          });
      }
      submit.addEventListener('click', function() {
        const picks = Array.from(list.querySelectorAll('.cat-pick:checked'))
          .map(cb => places[parseInt(cb.dataset.idx, 10)])
          .filter(Boolean)
          .map(cleanPlace);
        submitPicks(picks);
      });
      selectAll.addEventListener('click', function() {
        const vis = visibleRows();
        const allChecked = vis.length > 0 && vis.every(r => { const cb = r.querySelector('.cat-pick'); return cb && cb.checked; });
        vis.forEach(r => { const cb = r.querySelector('.cat-pick'); if (cb) cb.checked = !allChecked; });
        updateBtns();
      });
      const notesToggle = document.getElementById('cat-notes-toggle');
      notesToggle.addEventListener('click', function() {
        list.classList.add('notes-anim');
        const on = list.classList.toggle('show-notes');
        this.textContent = on ? 'Hide notes' : 'Show notes';
      });
      updateBtns();
    }
  );
}
