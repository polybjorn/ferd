import { displayCategory, grpNum, reduceMotion, state } from '../core.js';
import { dataLayer } from '../store.js';
import {
  AREA_CATEGORY_KINDS, AREA_MAX_FILE_BYTES, AREA_TARGET_POINTS, _areaPointCount,
  nominatimAreas, parseAreaGeoJson,
} from '../area-geo.js';
import { FilePick, categorySlugs } from '../form-fields.js';
import { fitAddedAreas } from '../map/index.js';
import { getShowField } from '../prefs.js';
import { closeModal } from '../modal.js';
import { t } from '../i18n.js';
import { ErrorBox, Field, Toggle, html, useEffect, useLayoutEffect, useRef, useState } from '../view.js';
import { areaValues, newAreaItems } from './area-payload.js';
import { AreaFields, AreaLocalName } from './edit-area.js';

/** @param {Event} e */
const valueOf = e => /** @type {HTMLInputElement} */ (e.currentTarget).value;

const RESULTS_TIMING = { duration: 200, easing: 'ease' };

// Runs only on an explicit search: Nominatim's usage policy rules out
// search-as-you-type.
/** @param {string} q */
function searchAreaBoundaries(q) {
  const params = new URLSearchParams({
    q, format: 'geojson', polygon_geojson: '1', polygon_threshold: '0.001',
    namedetails: '1', 'accept-language': 'en', limit: '8',
  });
  return fetch('https://nominatim.openstreetmap.org/search?' + params, { credentials: 'omit', signal: AbortSignal.timeout(20000) })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(nominatimAreas);
}

// The note under the search label: opens on the info button, closes on an
// outside press or Escape (Escape does not also close the dialog).
function SearchNote() {
  const [open, setOpen] = useState(false);
  const btn = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const note = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    if (!open) return undefined;
    /** @param {Event} e */
    const outside = e => {
      const target = /** @type {Node} */ (e.target);
      if (note.current && btn.current && !note.current.contains(target) && !btn.current.contains(target)) setOpen(false);
    };
    /** @param {KeyboardEvent} e */
    const key = e => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      if (btn.current) btn.current.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  return html`<div class="area-search-label">
    <label class="ui-field-label ui-required" for="a-search">${t('area.findBoundary')}</label>
    <button type="button" class="area-search-info" id="a-search-info" ref=${btn} aria-label=${t('area.aboutSearch')}
      aria-expanded=${String(open)} aria-controls="a-search-note" onClick=${() => setOpen((/** @type {boolean} */ o) => !o)}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
    </button>
    <div class=${'area-search-note' + (open ? ' open' : '')} id="a-search-note" ref=${note}>${t('area.searchNote')}</div>
  </div>`;
}

export function AddArea() {
  const [v, setV] = useState(() => areaValues(null, categorySlugs()));
  /** @param {Partial<typeof v>} p */
  const patch = p => setV((/** @type {any} */ prev) => ({ ...prev, ...p }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState(/** @type {any[] | null} */ (null));
  // Bumped per search, so each result list is a new set of rows.
  const [searchId, setSearchId] = useState(0);
  const [picked, setPicked] = useState(-1);
  const [folded, setFolded] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [parsed, setParsed] = useState(/** @type {any} */ (null));
  const [pickedLocal, setPickedLocal] = useState('');
  const [file, setFile] = useState(/** @type {File | null} */ (null));
  const [info, setInfo] = useState('');
  const [split, setSplit] = useState(false);
  // A category this form added for the picked row, offered beside the stored ones.
  const [extraCategory, setExtraCategory] = useState('');
  const autoCategory = useRef('');
  // A search answers after the render that started it, so its pick reads the
  // category the user may have chosen meanwhile from here, not from `v`.
  const category = useRef(v.category);
  category.current = v.category;
  const fileInput = useRef(/** @type {HTMLInputElement | null} */ (null));
  const resultsEl = useRef(/** @type {HTMLDivElement | null} */ (null));
  const fromHeight = useRef(0);
  const motion = useRef(0);

  const splitAvailable = !!parsed && !parsed.osm && parsed.features.length > 1;
  const separate = splitAvailable && split;

  // Places share this list, so only AREA_CATEGORY_KINDS may add to it: one
  // per OSM type would fill it with suburb, city district and the like. A
  // choice the user made stays, while one this form made follows the picked
  // row.
  /** @param {string} kind */
  const pickCategory = kind => {
    if (category.current.sel && category.current.sel !== autoCategory.current) return;
    const slug = kind.replace(/ /g, '-');
    const exists = categorySlugs().includes(slug);
    const add = !exists && AREA_CATEGORY_KINDS.has(slug);
    setExtraCategory(add ? slug : '');
    autoCategory.current = exists || add ? slug : '';
    patch({ category: { sel: autoCategory.current, text: '' } });
  };

  /** @param {number} from @param {number} to */
  const animateHeight = (from, to) => {
    if (from === to || reduceMotion() || !resultsEl.current) return;
    resultsEl.current.animate([
      { height: from + 'px', overflow: 'hidden' },
      { height: to + 'px', overflow: 'hidden' },
    ], RESULTS_TIMING);
  };
  // The new rows are measured once they exist, then the list eases from the
  // old height.
  useLayoutEffect(() => {
    if (!resultsEl.current || !searchId) return;
    animateHeight(fromHeight.current, resultsEl.current.offsetHeight);
  }, [searchId]);

  // The other rows stay rendered until the end so they can fade while the
  // picked one slides between its place in the list and the top.
  /** @param {HTMLElement | null} row @param {boolean} fold */
  const foldResults = (row, fold) => {
    const list = resultsEl.current;
    if (!list || !row) return;
    const rows = Array.from(/** @type {NodeListOf<HTMLElement>} */ (list.querySelectorAll('.area-result')));
    const others = rows.filter(b => b !== row);
    if (others.every(b => b.hidden === fold)) { setFolded(fold); return; }
    const my = ++motion.current;
    const settle = () => {
      if (my !== motion.current) return;
      others.forEach(b => { b.hidden = fold; });
      setFolded(fold);
    };
    others.forEach(b => { b.hidden = false; });
    const fullHeight = list.offsetHeight;
    const shift = row.offsetTop - rows[0].offsetTop;
    others.forEach(b => { b.hidden = true; });
    const foldedHeight = list.offsetHeight;
    if (reduceMotion()) { settle(); return; }
    others.forEach(b => { b.hidden = false; });
    if (fold) animateHeight(fullHeight, foldedHeight);
    else animateHeight(foldedHeight, fullHeight);
    const inList = { transform: 'none' };
    const atTop = { transform: 'translateY(' + -shift + 'px)' };
    row.animate(fold ? [inList, atTop] : [atTop, inList], RESULTS_TIMING);
    const shown = { ...inList, opacity: 1 };
    const gone = { ...atTop, opacity: 0 };
    others.forEach(b => b.animate(fold ? [shown, gone] : [gone, shown], RESULTS_TIMING));
    setTimeout(settle, RESULTS_TIMING.duration);
  };
  const pickedRow = () => resultsEl.current && resultsEl.current.querySelector('.area-result[aria-pressed="true"]');

  const showAll = () => {
    const row = /** @type {HTMLElement | null} */ (pickedRow());
    if (row) foldResults(row, false);
    setShowMore(false);
  };

  const clearFile = () => {
    if (fileInput.current) fileInput.current.value = '';
    setFile(null);
  };

  /** @param {any} result @param {number} i @param {HTMLElement | null} row @param {number} count */
  const pickResult = (result, i, row, count) => {
    setParsed({ features: [{ name: result.name, polygons: result.polygons }], ignored: 0, osm: true });
    setPickedLocal(result.localName);
    patch({ name: result.name, ...(getShowField('local-name') ? { local_name: result.localName } : {}) });
    pickCategory(result.kind);
    setPicked(i);
    foldResults(row, true);
    setShowMore(count > 1);
    clearFile();
    setError('');
    setInfo('');
  };

  const runSearch = () => {
    const text = q.trim();
    if (!text || searching) return;
    setSearching(true);
    setError('');
    searchAreaBoundaries(text).then(list => {
      fromHeight.current = found && found.length && resultsEl.current ? resultsEl.current.offsetHeight : 0;
      motion.current++;
      setFound(list);
      setPicked(-1);
      setFolded(false);
      setShowMore(false);
      setSearchId((/** @type {number} */ n) => n + 1);
      if (!list.length) setError(t('area.noBoundary'));
      else if (list.length === 1) pickResult(list[0], 0, null, 1);
    }).catch(() => {
      setError(t('area.searchFailed'));
    }).finally(() => setSearching(false));
  };

  const onFile = (/** @type {File | null} */ f) => {
    setParsed(null);
    setPickedLocal('');
    patch({ local_name: '' });
    setPicked(-1);
    showAll();
    setInfo('');
    setError('');
    setFile(f);
    if (!f) return;
    if (f.size > AREA_MAX_FILE_BYTES) { setError(t('area.fileTooBig')); return; }
    f.text().then(parseAreaGeoJson).then(result => {
      setParsed(result);
      const n = result.features.length;
      setV((/** @type {any} */ prev) => prev.name.trim() ? prev
        : { ...prev, name: (n === 1 && result.features[0].name) || f.name.replace(/\.(geo)?json$/i, '') });
      const points = result.features.reduce((sum, x) => sum + _areaPointCount(x.polygons), 0);
      setInfo(t('area.parsed', { count: n, polygons: grpNum(n), points: grpNum(points) }) +
        (points > AREA_TARGET_POINTS ? ' ' + t('area.simplified') : '') +
        (result.ignored ? ' ' + t('area.ignored', { count: grpNum(result.ignored) }) : ''));
    }).catch(err => setError(err.message));
  };

  const submit = (/** @type {Event} */ e) => {
    e.preventDefault();
    if (!parsed) { setError(t('area.needBoundary')); return; }
    const items = newAreaItems(v, {
      parsed, split: separate, pickedLocal, show: getShowField,
      fallbackName: n => t('area.fallbackName', { n }),
    });
    setBusy(true);
    const before = new Set((state.areas || []).map(a => a.id));
    items.reduce((chain, area) => chain.then(() => dataLayer.createArea(area)), Promise.resolve())
      .then(() => {
        closeModal();
        fitAddedAreas(before);
      })
      .catch((/** @type {Error} */ err) => { setBusy(false); setError(err.message); });
  };

  return html`<form id="area-form" onSubmit=${submit}>
    <div class="ui-section">
      <div class="ui-field">
        <${SearchNote} />
        <div class="ui-control-row">
          <input type="text" id="a-search" maxlength="200" enterkeyhint="search" placeholder=${t('area.searchPlaceholder')}
            value=${q} onInput=${(/** @type {Event} */ e) => setQ(valueOf(e))}
            onKeyDown=${(/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }} />
          <button type="button" class="primary" id="a-search-go" disabled=${searching} onClick=${runSearch}>${t('area.search')}</button>
        </div>
        <div class="area-results" id="a-results" ref=${resultsEl} hidden=${!found || !found.length}>
          ${(found || []).map((/** @type {any} */ result, /** @type {number} */ i) => html`<button type="button" class="area-result" key=${searchId + ':' + i}
            aria-pressed=${String(picked === i)} hidden=${folded && picked !== i}
            onClick=${(/** @type {Event} */ e) => pickResult(result, i, /** @type {HTMLElement} */ (e.currentTarget), found ? found.length : 0)}>
            <span class="area-result-name">${result.name}</span>
            <span class="area-result-kind">${result.kind}</span>
            ${result.detail && html`<span class="area-result-detail">${result.detail}</span>`}
          </button>`)}
        </div>
        <div class="area-results-foot">
          <button type="button" class="area-results-more" id="a-results-more" hidden=${!showMore} onClick=${showAll}>${t('area.showAll', { count: found ? found.length : 0 })}</button>
          <span class="area-results-credit" id="a-results-credit" hidden=${!found || !found.length}>${t('area.credit')}</span>
        </div>
      </div>
      <${Field} label=${t('area.orFile')}>
        <${FilePick} id="a-file" accept=".geojson,.json,application/geo+json,application/json" file=${file} onFile=${onFile} inputRef=${fileInput} />
        <p class="ui-hint" id="a-file-info" hidden=${!info}>${info}</p>
      <//>
      <div id="a-split-row" hidden=${!splitAvailable}>
        <${Toggle} id="a-split" label=${t('area.split')} initial=${split} onToggle=${setSplit} />
      </div>
      <div id="a-name-row" hidden=${separate}>
        <div class="ui-section">
          <${Field} id="a-name" label=${t('form.name')} required>
            <input type="text" id="a-name" required=${!separate} maxlength="200" value=${v.name} onInput=${(/** @type {Event} */ e) => patch({ name: valueOf(e) })} />
          <//>
          <${AreaLocalName} prefix="a" v=${v} patch=${patch} />
        </div>
      </div>
      <${AreaFields} prefix="a" v=${v} patch=${patch} extraCategories=${extraCategory ? [extraCategory] : []} />
    </div>
    <${ErrorBox} id="area-error" msg=${error} />
    <div class="form-actions">
      <button type="submit" class="ui-button ui-button-primary" id="area-submit" disabled=${busy}>${t('area.add')}</button>
    </div>
  </form>`;
}
