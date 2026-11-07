import { state } from '../core.js';
import { dataLayer } from '../store.js';
import { t } from '../i18n.js';
import { closeTopModal } from '../modal.js';
import { wrappedRouter } from '../pick-coords.js';
import { DialogHead, ErrorBox, HideToggle, RowTag, html, openViewModal, useState } from '../view.js';

function RegionRow({ index, region, edited, onName, onRemove }) {
  const [name, setName] = useState(region.original);
  const dirty = name !== region.original;
  const empty = region.count === 0;
  const input = e => {
    setName(e.currentTarget.value);
    onName(region.original, e.currentTarget.value);
  };
  const tag = dirty ? t('common.edited') : empty ? t('regions.emptyTag') : '';
  return html`<div style="display:flex;gap:var(--ui-space-2);align-items:center;margin-top:var(--ui-space-2)">
    <input type="text" data-i=${index} class=${'rgn-name' + (dirty ? ' dirty' : '')} value=${name} style="flex:1;min-width:0" onInput=${input} />
    <${RowTag} text=${tag} dirty=${dirty} />
    <${HideToggle} prefKey="default-hidden-regions" id=${region.original} hiddenSet=${state.hiddenRegions} className="rgn-hide" attrs=${{ 'data-name': region.original }} />
    <button type="button" data-i=${index} class="rgn-remove btn-x x-icon" aria-label=${t('common.remove')}
      title=${t(empty ? 'regions.removeEmpty' : 'regions.removeInUse')} style="flex:0 0 auto" onClick=${() => onRemove(region)}></button>
  </div>`;
}

// Empty regions are deleted on Save; non-empty ones are cleared, which moves
// their routes to "No region" and removes the directory.
function RegionsView({ regions }) {
  const [rows, setRows] = useState(() => regions
    .filter(r => r.name)
    .map(r => ({ original: r.name, count: r.routes.length }))
    .sort((a, b) => a.original.localeCompare(b.original)));
  const [names, setNames] = useState({});
  const [removed, setRemoved] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameOf = r => (r.original in names ? names[r.original] : r.original);
  const changed = removed.length > 0 || rows.some(r => nameOf(r) !== r.original);
  const lost = removed.filter(r => r.count > 0).reduce((n, r) => n + r.count, 0);
  const remove = region => {
    setRows(list => list.filter(r => r !== region));
    setRemoved(list => list.concat(region));
  };
  const save = () => {
    setError('');
    const current = rows.map(nameOf);
    if (new Set(current.map(n => n.trim().toLowerCase())).size !== rows.length) {
      setError(t('regions.duplicate'));
      return;
    }
    const renames = [];
    for (const r of rows) {
      const trimmed = nameOf(r).trim();
      if (!trimmed) { setError(t('regions.nameRequired')); return; }
      if (trimmed !== r.original) renames.push({ from: r.original, to: trimmed });
    }
    setBusy(true);
    // Clears and deletes run first so a rename can reuse a freed name.
    Promise.all(removed.map(r => (r.count === 0
      ? dataLayer.deleteRegion({ name: r.original })
      : dataLayer.clearRegion({ name: r.original }))))
      .then(() => Promise.all(renames.map(r => dataLayer.renameRegion(r))))
      .then(() => { wrappedRouter(); closeTopModal(); })
      .catch(e => { setBusy(false); setError(e.message); });
  };
  return html`
    <${DialogHead} title=${t('regions.title')} />
    <div class="ui-dialog-body">
      <h3 class="settings-h" style="margin-top:var(--ui-space-3);display:flex;align-items:baseline;gap:var(--ui-space-2)">${t('regions.heading')}
        <span id="rgn-clear-warning" class="action-warning" style="margin-left:auto;text-align:right" hidden=${!lost}>${lost ? t('regions.clearWarning', { count: lost }) : ''}</span></h3>
      <div id="rgn-rows">${rows.map((r, i) => html`<${RegionRow} key=${r.original} index=${i} region=${r} onName=${(from, v) => setNames(n => ({ ...n, [from]: v }))} onRemove=${remove} />`)}</div>
      <div id="rgn-empty" class="hint" hidden=${rows.length > 0}>${t('regions.empty')}</div>
      <${ErrorBox} id="rgn-error" msg=${error} />
    </div>
    <div class="ui-dialog-actions">
      <span id="rgn-save-slot" hidden=${!changed}><button type="button" class="ui-button ui-button-primary" id="rgn-save" disabled=${busy} onClick=${save}>${t('common.save')}</button></span>
    </div>`;
}

export function openManageRegionsModal() {
  const regions = (state.manifest && state.manifest.regions) ? state.manifest.regions : [];
  openViewModal(html`<${RegionsView} regions=${regions} />`, { phone: 'fullscreen' });
}
