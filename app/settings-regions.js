import { escapeHtml, state } from './core.js';
import { dataLayer } from './offline-queue.js';
import { eyeIconHtml, isDefaultHidden, setDefaultHidden } from './prefs.js';
import { modalErrorHtml, modalHeaderHtml, refreshRoutes } from './select.js';
import { closeTopModal, openFullScreenModal, showErrorBox } from './modal.js';
import { wrappedRouter } from './pick-coords.js';

export function openManageRegionsModal() {
  const regions = (state.manifest && state.manifest.regions) ? state.manifest.regions : [];
  // Exclude the synthetic no-region group; it's not a renamable directory.
  const rows = regions
    .filter(r => r.name)
    .map(r => ({ name: r.name, original: r.name, count: r.routes.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Empty regions: Save calls delete-region. Non-empty regions: Save calls
  // clear-region, which moves the routes to "No region" and removes the dir.
  const pendingDeletes = new Set();   // empty regions removed by X
  const pendingClears = new Set();    // non-empty regions removed by X

  openFullScreenModal(
    modalHeaderHtml('Manage regions') +
    '<h3 class="settings-h" style="margin-top:var(--ui-space-3);display:flex;align-items:baseline;gap:var(--ui-space-2)">Regions' +
      '<span id="rgn-clear-warning" class="action-warning" style="margin-left:auto;text-align:right" hidden></span></h3>' +
    '<div id="rgn-rows"></div>' +
    '<div id="rgn-empty" class="hint" hidden>No regions yet. Upload a route with a region to create one.</div>' +
    modalErrorHtml('rgn-error') +
    '<div class="ui-dialog-actions">' +
      '<span id="rgn-save-slot" hidden><button type="button" class="ui-button ui-button-primary" id="rgn-save">Save</button></span>' +
    '</div>',
    function() {
      function hasChanges() {
        if (pendingDeletes.size || pendingClears.size) return true;
        for (const r of rows) if (r.name !== r.original) return true;
        return false;
      }
      function refreshSaveBtn() {
        // The slot hides it: .ui-button's display beats the hidden attribute.
        const slot = document.getElementById('rgn-save-slot');
        if (slot) slot.hidden = !hasChanges();
      }
      function refreshClearWarning() {
        const banner = document.getElementById('rgn-clear-warning');
        if (!banner) return;
        if (!pendingClears.size) { banner.hidden = true; return; }
        const slugs = [...pendingClears];
        const total = slugs.reduce((n, name) => {
          const region = regions.find(x => x.name === name);
          return n + (region ? region.routes.length : 0);
        }, 0);
        banner.textContent = total + ' route' + (total === 1 ? '' : 's') + ' will lose ' + (total === 1 ? 'its' : 'their') + ' region';
        banner.hidden = false;
      }
      function rerender() {
        const container = document.getElementById('rgn-rows');
        const emptyMsg = document.getElementById('rgn-empty');
        if (!rows.length) {
          container.innerHTML = '';
          emptyMsg.hidden = false;
          return;
        }
        emptyMsg.hidden = true;
        container.innerHTML = rows.map((r, i) => {
          const dirty = r.name !== r.original;
          const empty = r.count === 0;
          const tag = dirty ? '<span class="row-tag dirty">edited</span>'
                    : empty ? '<span class="row-tag">empty</span>'
                    : '<span class="row-tag"></span>';
          const xTitle = empty ? 'Remove empty region' : 'Remove region (routes will move to No region)';
          return '<div style="display:flex;gap:var(--ui-space-2);align-items:center;margin-top:var(--ui-space-2)">' +
            '<input type="text" data-i="' + i + '" class="rgn-name' + (dirty ? ' dirty' : '') + '" value="' + escapeHtml(r.name) + '" style="flex:1;min-width:0">' +
            tag +
            (function() { const h = isDefaultHidden('default-hidden-regions', r.name); return '<button type="button" data-name="' + escapeHtml(r.name) + '" class="rgn-hide btn-x' + (h ? ' is-hidden' : '') + '" aria-label="Default visibility on map" title="' + (h ? 'Hidden by default on the map' : 'Shown by default on the map') + '" style="flex:0 0 auto">' + eyeIconHtml(h) + '</button>'; })() +
            '<button type="button" data-i="' + i + '" class="rgn-remove btn-x x-icon" aria-label="Remove" title="' + xTitle + '" style="flex:0 0 auto"></button>' +
          '</div>';
        }).join('');
        container.querySelectorAll('.rgn-name').forEach(inp => {
          inp.addEventListener('input', function() {
            const i = +this.dataset.i;
            const r = rows[i];
            r.name = this.value;
            const dirty = r.name !== r.original;
            this.classList.toggle('dirty', dirty);
            const tagEl = this.parentElement.querySelector('.row-tag');
            if (!tagEl) return;
            if (dirty) {
              tagEl.textContent = 'edited';
              tagEl.classList.add('dirty');
            } else {
              tagEl.classList.remove('dirty');
              tagEl.textContent = r.count === 0 ? 'empty' : '';
            }
            refreshSaveBtn();
          });
        });
        // Default-visibility eye: persists instantly, independent of the
        // rename/remove Save batch; also updates the in-session set.
        container.querySelectorAll('.rgn-hide').forEach(btn => {
          btn.addEventListener('click', /** @this {HTMLButtonElement} */ function() {
            const name = this.dataset.name;
            const nowHidden = !isDefaultHidden('default-hidden-regions', name);
            setDefaultHidden('default-hidden-regions', name, nowHidden);
            if (nowHidden) state.hiddenRegions.add(name); else state.hiddenRegions.delete(name);
            this.classList.toggle('is-hidden', nowHidden);
            this.innerHTML = eyeIconHtml(nowHidden);
            this.title = nowHidden ? 'Hidden by default on the map' : 'Shown by default on the map';
          });
        });
        container.querySelectorAll('.rgn-remove').forEach(btn => {
          btn.addEventListener('click', function() {
            if (this.disabled) return;
            const i = +this.dataset.i;
            const r = rows[i];
            if (r.count === 0) pendingDeletes.add(r.original);
            else pendingClears.add(r.original);
            rows.splice(i, 1);
            rerender();
            refreshSaveBtn();
            refreshClearWarning();
          });
        });
      }
      rerender();
      refreshSaveBtn();

      document.getElementById('rgn-save').addEventListener('click', function() {
        const submit = this;
        submit.disabled = true;
        const err = document.getElementById('rgn-error');
        err.classList.remove('visible');

        // Build the list of renames. Reject if any new name collides with
        // an existing (non-renamed) region or with another rename target.
        const renames = [];
        const seen = new Set(rows.map(r => r.name.trim().toLowerCase()));
        if (seen.size !== rows.length) {
          showErrorBox(err, 'Two regions have the same name.');
          submit.disabled = false;
          return;
        }
        for (const r of rows) {
          const trimmed = r.name.trim();
          if (!trimmed) {
            showErrorBox(err, 'Region name cannot be empty.');
            submit.disabled = false;
            return;
          }
          if (trimmed !== r.original) renames.push({ from: r.original, to: trimmed });
        }

        // Run clears + deletes first so a rename can reuse a freed name.
        const clears = [...pendingClears].map(name =>
          dataLayer.clearRegion({ name })
        );
        const deletes = [...pendingDeletes].map(name =>
          dataLayer.deleteRegion({ name })
        );
        Promise.all([...clears, ...deletes])
          .then(() => Promise.all(renames.map(r => dataLayer.renameRegion(r))))
          .then(() => refreshRoutes())
          .then(() => { wrappedRouter(); closeTopModal(); })
          .catch(e => {
            submit.disabled = false;
            showErrorBox(err, e.message);
          });
      });
    }
  );
}
