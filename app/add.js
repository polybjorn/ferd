import { displayCategory, escapeHtml, grpNum, sortedCategorySlugs, state } from './core.js';
import { dataLayer } from './offline-queue.js';
import {
  AREA_CATEGORY_KINDS, AREA_MAX_FILE_BYTES, AREA_TARGET_POINTS, _areaPointCount,
  buildAreaGeometry, nominatimAreas, parseAreaGeoJson,
} from './area-geo.js';
import {
  radioPillsHtml, readPlaceFormFields, readRouteMetaFields, readSelectOrNew, readStarRating,
  selectOrNewHtml, starRatingHtml, wireSelectOrNew, wireStarRating,
} from './form-fields.js';
import { collectTags, tagsInclude } from './tags.js';
import { wireFilterPopover } from './map-panel.js';
import { catalogEnabled, getShowField, placesEnabled, routesEnabled } from './prefs.js';
import { refreshPlacesPresentation, syncPlacesOnMap } from './map-popups.js';
import { readAreaFormFields, readAreaLocalName, reduceMotion } from './areas.js';
import { wireCountryPicker } from './countries.js';
import { fetchCatalog } from './places-list.js';
import { router } from './router.js';
import {
  enhanceSelectsIn, modalErrorHtml, modalHeaderHtml, openConfirmModal, refreshAreas,
  refreshPlaces, refreshRoutes, uiFieldHtml, uiToggleHtml,
} from './select.js';
import { closeModal, openFullScreenModal, showModalError } from './modal.js';
import { enterPickCoordsMode } from './pick-coords.js';

export function openAddModal(prefillCoords, initialTab, draft) {
  const showPlaces = placesEnabled();
  const showTrails = routesEnabled();
  if (!showPlaces && !showTrails) return;
  // Entry-point determines which tabs the modal exposes:
  //   'place' (Places list Add)  -> [Place, Browse]
  //   'route' (Routes list Add)  -> just the GPX form, no tabs
  //   null    (map Add button)   -> [Place, Route, Area, Browse], filtered by enabled features
  // Browse reads the merged catalog in server mode and the bundled shipped
  // catalog.json in local mode (see fetchCatalog); hidden when the Catalog
  // feature is toggled off.
  const showBrowse = catalogEnabled();
  let tabs;
  if (initialTab === 'route') {
    tabs = ['route'];
  } else if (initialTab === 'place') {
    tabs = showPlaces ? (showBrowse ? ['place', 'browse'] : ['place']) : ['route'];
  } else {
    tabs = [];
    if (showPlaces) tabs.push('place');
    if (showTrails) tabs.push('route');
    if (showPlaces) tabs.push('area');
    if (showPlaces && showBrowse) tabs.push('browse');
  }
  let tab = tabs[0];
  const tabLabels = { place: 'Place', route: 'Route', area: 'Area', browse: 'Browse' };
  // With one tab there is no tab row, so the head names the form instead.
  const singleTabTitle = 'Add ' + tabLabels[tab].toLowerCase();
  openFullScreenModal(
    modalHeaderHtml(singleTabTitle, {tabsHtml: tabs.length > 1 ?
      '<div class="modal-tabs" id="add-tabs">' +
        tabs.map(t => '<button data-tab="' + t + '"' + (t === tab ? ' class="active"' : '') + '>' + tabLabels[t] + '</button>').join('') +
      '</div>'
      : ''}) +
    '<div id="add-body"></div>',
    function() {
      document.querySelectorAll('#add-tabs button[data-tab]').forEach(b => {
        b.addEventListener('click', function() {
          tab = this.dataset.tab;
          document.querySelectorAll('#add-tabs button[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
          renderTab();
        });
      });
      renderTab();
    }
  );

  function renderTab() {
    const body = document.getElementById('add-body');
    body.innerHTML = tab === 'place' ? placeFormHtml()
      : tab === 'route' ? gpxFormHtml()
      : tab === 'area' ? areaFormHtml()
      : browseFormHtml();
    if (tab === 'place') wirePlaceForm();
    else if (tab === 'route') wireGpxForm();
    else if (tab === 'area') wireAreaForm();
    else wireBrowseForm();
    enhanceSelectsIn(body);
  }

  function placeFormHtml() {
    // Exclude the uncategorized bucket ('') — "no category" is already the
    // default state of the empty placeholder option.
    const cats = sortedCategorySlugs(Object.keys(state.categoryColors).filter(c => c !== ''));
    const c = prefillCoords;
    // A draft carries field values across the close+reopen that wraps a
    // "Pick on map" click, so the user's input survives picking coordinates.
    const d = draft || {};
    const sourcesText = (d.sources || []).join('\n');
    return '<form id="place-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('p-name', 'Name',
          '<input type="text" id="p-name" required value="' + escapeHtml(d.name || '') + '">', { required: true }) +
        (getShowField('local-name') ?
          uiFieldHtml('p-local-name', 'Local name',
            '<input type="text" id="p-local-name" placeholder="In the local language" value="' + escapeHtml(d.local_name || '') + '">')
        : '') +
        '<div>' +
          uiFieldHtml(null, 'Coordinates',
            '<div class="ui-control-row">' +
              '<button type="button" class="primary" id="pick-on-map">' + (c ? 'Re-pick on map' : 'Pick on map') + '</button>' +
              (c
                ? '<span class="ui-control-text" id="p-coords-display">' + c.lat.toFixed(5) + ', ' + c.lng.toFixed(5) + '</span>'
                : '<a href="#" class="ui-control-text" id="p-coords-manual">or enter manually</a>') +
            '</div>', { required: true }) +
          '<div class="collapsible" id="p-coords-fields">' +
            '<div class="collapsible-inner">' +
              '<div class="ui-field-row">' +
                uiFieldHtml('p-lat', 'Latitude', '<input type="number" id="p-lat" step="any" value="' + (c ? c.lat.toFixed(5) : '') + '">') +
                uiFieldHtml('p-lon', 'Longitude', '<input type="number" id="p-lon" step="any" value="' + (c ? c.lng.toFixed(5) : '') + '">') +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        uiFieldHtml('p-category', 'Category',
          selectOrNewHtml('p-category', cats, d.category || null, displayCategory, '', 'New category name')) +
        uiFieldHtml('p-country', 'Country',
          '<input type="text" id="p-country" value="' + escapeHtml(d.country || '') + '">') +
        (getShowField('note') ?
          uiFieldHtml('p-note', 'Note',
            '<textarea id="p-note">' + escapeHtml(d.note || '') + '</textarea>')
        : '') +
        (getShowField('image') ?
          uiFieldHtml('p-image', 'Image URL',
            '<input type="url" id="p-image" placeholder="https://example.com/photo.jpg" value="' + escapeHtml(d.image || '') + '">')
        : '') +
        uiFieldHtml('p-sources', 'Sources',
          '<textarea id="p-sources" placeholder="One URL per line">' + escapeHtml(sourcesText) + '</textarea>') +
        '<div>' +
          uiToggleHtml('p-visited', 'I&rsquo;ve visited this place', { checked: d.visited }) +
          ((getShowField('date') || getShowField('rating')) ?
            '<div class="collapsible' + (d.visited ? ' expanded' : '') + '" id="p-visited-extras">' +
              '<div class="collapsible-inner">' +
                '<div class="ui-section">' +
                  (getShowField('date') ?
                    uiFieldHtml('p-date-visited', 'Date visited',
                      '<input type="date" id="p-date-visited" value="' + escapeHtml(d.date_visited || '') + '">')
                  : '') +
                  (getShowField('rating') ?
                    uiFieldHtml(null, 'Rating', starRatingHtml('p-rating', d.rating || ''))
                  : '') +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        '</div>' +
      '</div>' +
      modalErrorHtml('add-error') +
      '<div class="modal-actions">' +
        '<button type="submit" class="ui-button ui-button-primary" id="place-submit">Add place</button>' +
      '</div>' +
    '</form>';
  }

  function gpxFormHtml() {
    // Skip the synthetic no-region group ("") when listing existing regions.
    const regions = state.manifest ? state.manifest.regions.map(r => r.name).filter(Boolean).sort() : [];
    return '<form id="gpx-form">' +
      '<div class="ui-section">' +
        uiFieldHtml('g-name', 'Name',
          '<input type="text" id="g-name" required placeholder="e.g. Summit Loop">', { required: true }) +
        (getShowField('local-name') ?
          uiFieldHtml('g-local-name', 'Local name',
            '<input type="text" id="g-local-name" placeholder="In the local language">')
        : '') +
        uiFieldHtml(null, 'GPX file',
          '<div class="ui-control-row">' +
            '<input type="file" id="g-file" tabindex="-1" accept=".gpx,application/gpx+xml,text/xml" class="file-input-hidden" required>' +
            '<button type="button" class="primary" id="g-file-pick">Choose file</button>' +
            '<span class="ui-control-text" id="g-file-name">No file selected</span>' +
          '</div>', { required: true }) +
        uiFieldHtml('g-region', 'Region',
          selectOrNewHtml('g-region', regions, null, null, '', 'New region name')) +
        uiFieldHtml(null, 'Difficulty',
          radioPillsHtml('g-difficulty', [['', 'None'], ['easy', 'Easy'], ['moderate', 'Moderate'], ['hard', 'Hard'], ['expert', 'Expert']], '')) +
        (getShowField('tags') ?
          uiFieldHtml('g-tags', 'Tags (comma-separated)',
            '<input type="text" id="g-tags" placeholder="summit, panorama, via-ferrata">')
        : '') +
        (getShowField('note') ?
          uiFieldHtml('g-notes', 'Notes',
            '<textarea id="g-notes" maxlength="2000"></textarea>')
        : '') +
        uiFieldHtml('g-source', 'Source URL',
          '<input type="url" id="g-source" placeholder="https://example.com/route">') +
        uiToggleHtml('g-strip-pii', 'Strip personal data from GPX', { title: 'Removes timestamps, author, and creator from the GPX file' }) +
        '<div>' +
          uiToggleHtml('g-completed', 'I&rsquo;ve completed this route') +
          ((getShowField('date') || getShowField('rating')) ?
            '<div class="collapsible" id="g-completed-extras">' +
              '<div class="collapsible-inner">' +
                '<div class="ui-section">' +
                  (getShowField('date') ?
                    uiFieldHtml('g-date', 'Date completed', '<input type="date" id="g-date">')
                  : '') +
                  (getShowField('rating') ?
                    uiFieldHtml(null, 'Rating', starRatingHtml('g-rating', ''))
                  : '') +
                '</div>' +
              '</div>' +
            '</div>'
          : '') +
        '</div>' +
      '</div>' +
      modalErrorHtml('add-error') +
      '<div class="modal-actions">' +
        '<button type="submit" class="ui-button ui-button-primary" id="gpx-submit">Upload route</button>' +
      '</div>' +
    '</form>';
  }

  function wirePlaceForm() {
    wireSelectOrNew('p-category');
    wireCountryPicker('p-country');
    wireStarRating('p-rating');
    const visitedCb = document.getElementById('p-visited');
    const visitedExtras = document.getElementById('p-visited-extras');
    if (visitedCb && visitedExtras) {
      visitedCb.addEventListener('change', function() {
        visitedExtras.classList.toggle('expanded', this.checked);
      });
    }
    document.getElementById('pick-on-map').addEventListener('click', function() {
      // Snapshot current form values so they survive the close+reopen around
      // the map click. Coordinates aren't set yet (that's why the user is
      // picking), so this can't reuse readPlaceFormFields, which requires them.
      const $ = id => document.getElementById('p-' + id);
      const val = id => { const el = $(id); return el ? el.value : ''; };
      const sourcesRaw = val('sources').trim();
      const snapshot = {
        name: val('name').trim(),
        local_name: val('local-name').trim(),
        category: readSelectOrNew('p-category'),
        country: val('country').trim(),
        note: val('note').trim(),
        image: val('image').trim(),
        sources: sourcesRaw ? sourcesRaw.split('\n').map(s => s.trim()).filter(Boolean) : [],
        visited: $('visited') ? $('visited').checked : false,
        date_visited: val('date-visited').trim(),
        rating: readStarRating('p-rating'),
      };
      closeModal();
      enterPickCoordsMode(function(latlng) {
        openAddModal({ lat: latlng.lat, lng: latlng.lng }, 'place', snapshot);
      });
    });
    // "or enter manually" reveals the lat/lon inputs with the same
    // collapsible animation used elsewhere.
    const manualLink = document.getElementById('p-coords-manual');
    const coordsBox = document.getElementById('p-coords-fields');
    // If coords were prefilled (user came from a map pick), keep the
    // inputs available immediately so the user can fine-tune.
    if (prefillCoords) coordsBox.classList.add('expanded');
    if (manualLink && coordsBox) {
      manualLink.addEventListener('click', function(e) {
        e.preventDefault();
        coordsBox.classList.add('expanded');
        this.style.display = 'none';
      });
      if (coordsBox.classList.contains('expanded')) manualLink.style.display = 'none';
    }
    document.getElementById('place-form').addEventListener('submit', function(e) {
      e.preventDefault();
      const r = readPlaceFormFields('p');
      if (r.error) { showModalError(r.error); return; }
      const submitBtn = document.getElementById('place-submit');
      submitBtn.disabled = true;
      const prevColors = Object.assign({}, state.categoryColors);
      dataLayer.createPlace(r.payload)
        .then(() => refreshPlaces())
        .then(() => { closeModal(); syncPlacesOnMap(prevColors); refreshPlacesPresentation(); })
        .catch(err => { submitBtn.disabled = false; showModalError(err.message); });
    });
  }

  function areaFormHtml() {
    const cats = sortedCategorySlugs(Object.keys(state.categoryColors).filter(c => c !== ''));
    return '<form id="area-form">' +
      '<div class="ui-section">' +
        '<div class="ui-field">' +
          '<div class="area-search-label">' +
            '<label class="ui-field-label ui-required" for="a-search">Find a boundary</label>' +
            '<button type="button" class="area-search-info" id="a-search-info" aria-label="About this search" aria-expanded="false" aria-controls="a-search-note">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>' +
            '</button>' +
            '<div class="area-search-note" id="a-search-note">Nominatim, OpenStreetMap&rsquo;s search service, sees what you type and your IP address.</div>' +
          '</div>' +
          '<div class="ui-control-row">' +
            '<input type="text" id="a-search" maxlength="200" enterkeyhint="search" placeholder="Search OpenStreetMap">' +
            '<button type="button" class="primary" id="a-search-go">Search</button>' +
          '</div>' +
          '<div class="area-results" id="a-results" hidden></div>' +
          '<div class="area-results-foot">' +
            '<button type="button" class="area-results-more" id="a-results-more" hidden></button>' +
            '<span class="area-results-credit" id="a-results-credit" hidden>&copy; OpenStreetMap contributors</span>' +
          '</div>' +
        '</div>' +
        uiFieldHtml(null, 'Or use a GeoJSON file',
          '<div class="ui-control-row">' +
            '<input type="file" id="a-file" tabindex="-1" accept=".geojson,.json,application/geo+json,application/json" class="file-input-hidden">' +
            '<button type="button" class="primary" id="a-file-pick">Choose file</button>' +
            '<span class="ui-control-text" id="a-file-name">No file selected</span>' +
          '</div>' +
          '<p class="ui-hint" id="a-file-info" hidden></p>') +
        '<div id="a-split-row" hidden>' +
          uiToggleHtml('a-split', 'Keep as separate areas') +
        '</div>' +
        '<div id="a-name-row">' +
          '<div class="ui-section">' +
            uiFieldHtml('a-name', 'Name', '<input type="text" id="a-name" required maxlength="200">', { required: true }) +
            (getShowField('local-name') ?
              uiFieldHtml('a-local-name', 'Local name',
                '<input type="text" id="a-local-name" maxlength="200" placeholder="In the local language">')
            : '') +
          '</div>' +
        '</div>' +
        uiFieldHtml('a-category', 'Category',
          selectOrNewHtml('a-category', cats, null, displayCategory, '', 'New category name')) +
        (getShowField('note') ?
          uiFieldHtml('a-note', 'Note', '<textarea id="a-note"></textarea>')
        : '') +
        '<div>' +
          uiToggleHtml('a-visited', 'I&rsquo;ve visited this area') +
          '<p class="ui-hint">A visited place or completed route inside also makes it visited.</p>' +
        '</div>' +
      '</div>' +
      modalErrorHtml('area-error') +
      '<div class="modal-actions">' +
        '<button type="submit" class="ui-button ui-button-primary" id="area-submit">Add area</button>' +
      '</div>' +
    '</form>';
  }

  // Runs only on an explicit search: Nominatim's usage policy rules out
  // search-as-you-type.
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
  function wireAreaForm() {
    wireSelectOrNew('a-category');
    const fileInput = document.getElementById('a-file');
    const fileName = document.getElementById('a-file-name');
    const info = document.getElementById('a-file-info');
    const splitRow = document.getElementById('a-split-row');
    const split = document.getElementById('a-split');
    const nameRow = document.getElementById('a-name-row');
    const nameEl = document.getElementById('a-name');
    const errorEl = document.getElementById('area-error');
    const localEl = document.getElementById('a-local-name');
    const searchEl = document.getElementById('a-search');
    const searchGo = document.getElementById('a-search-go');
    const creditEl = document.getElementById('a-results-credit');
    const infoBtn = document.getElementById('a-search-info');
    const noteEl = document.getElementById('a-search-note');
    const closeNote = () => {
      noteEl.classList.remove('open');
      infoBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onNoteOutside, true);
      document.removeEventListener('keydown', onNoteKey, true);
    };
    const onNoteOutside = e => {
      if (!noteEl.contains(e.target) && !infoBtn.contains(e.target)) closeNote();
    };
    const onNoteKey = e => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeNote();
      infoBtn.focus();
    };
    infoBtn.addEventListener('click', function() {
      if (noteEl.classList.contains('open')) { closeNote(); return; }
      noteEl.classList.add('open');
      infoBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onNoteOutside, true);
      document.addEventListener('keydown', onNoteKey, true);
    });
    const resultsEl = document.getElementById('a-results');
    const moreEl = document.getElementById('a-results-more');
    let parsed = null;
    let pickedLocal = '';
    const categoryEl = document.getElementById('a-category');
    let autoCategory = '';
    let autoOption = null;
    // Places share this list, so only AREA_CATEGORY_KINDS may add to it:
    // one per OSM type would fill it with suburb, city district and the
    // like. A choice the user made stays, while one this form made follows
    // the picked row.
    const pickCategory = kind => {
      if (categoryEl.value && categoryEl.value !== autoCategory) return;
      const slug = kind.replace(/ /g, '-');
      if (autoOption) autoOption.remove();
      autoOption = null;
      const exists = Array.from(categoryEl.options).some(o => o.value === slug);
      if (!exists && AREA_CATEGORY_KINDS.has(slug)) {
        autoOption = new Option(displayCategory(slug), slug);
        categoryEl.insertBefore(autoOption, categoryEl.querySelector('option[value="__new__"]'));
      }
      autoCategory = exists || autoOption ? slug : '';
      categoryEl.value = autoCategory;
      categoryEl.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const showParsed = () => {
      const n = parsed.features.length;
      const points = parsed.features.reduce((sum, x) => sum + _areaPointCount(x.polygons), 0);
      info.textContent = grpNum(n) + (n === 1 ? ' polygon, ' : ' polygons, ') + grpNum(points) + ' points.' +
        (points > AREA_TARGET_POINTS ? ' Simplified on save.' : '') +
        (parsed.ignored ? ' Ignored ' + grpNum(parsed.ignored) + ' without a polygon.' : '');
      info.hidden = false;
      splitRow.hidden = n < 2;
      syncSplit();
    };
    const clearFile = () => {
      fileInput.value = '';
      fileName.textContent = 'No file selected';
      fileName.classList.remove('has-file');
    };
    const resultsTiming = { duration: 200, easing: 'ease' };
    const animateResultsHeight = (from, to) => {
      if (from === to || reduceMotion()) return;
      resultsEl.animate([
        { height: from + 'px', overflow: 'hidden' },
        { height: to + 'px', overflow: 'hidden' },
      ], resultsTiming);
    };
    let resultsMotion = 0;
    // The other rows stay rendered until the end so they can fade while the
    // picked one slides between its place in the list and the top.
    const foldResults = (row, fold) => {
      const rows = Array.from(resultsEl.querySelectorAll('.area-result'));
      const others = rows.filter(b => b !== row);
      if (others.every(b => b.hidden === fold)) return;
      const motion = ++resultsMotion;
      const settle = () => { if (motion === resultsMotion) others.forEach(b => { b.hidden = fold; }); };
      others.forEach(b => { b.hidden = false; });
      const fullHeight = resultsEl.offsetHeight;
      const shift = row.offsetTop - rows[0].offsetTop;
      others.forEach(b => { b.hidden = true; });
      const foldedHeight = resultsEl.offsetHeight;
      if (reduceMotion()) { settle(); return; }
      others.forEach(b => { b.hidden = false; });
      if (fold) animateResultsHeight(fullHeight, foldedHeight);
      else animateResultsHeight(foldedHeight, fullHeight);
      const inList = { transform: 'none' };
      const atTop = { transform: 'translateY(' + -shift + 'px)' };
      row.animate(fold ? [inList, atTop] : [atTop, inList], resultsTiming);
      const shown = { ...inList, opacity: 1 };
      const gone = { ...atTop, opacity: 0 };
      others.forEach(b => b.animate(fold ? [shown, gone] : [gone, shown], resultsTiming));
      setTimeout(settle, resultsTiming.duration);
    };
    const showAllResults = () => {
      const picked = resultsEl.querySelector('.area-result:not([hidden])');
      if (picked) foldResults(picked, false);
      moreEl.hidden = true;
    };
    moreEl.addEventListener('click', showAllResults);
    const pickResult = (result, row) => {
      parsed = { features: [{ name: result.name, polygons: result.polygons }], ignored: 0, osm: true };
      pickedLocal = result.localName;
      nameEl.value = result.name;
      if (localEl) localEl.value = result.localName;
      pickCategory(result.kind);
      const rows = resultsEl.querySelectorAll('.area-result');
      rows.forEach(b => b.setAttribute('aria-pressed', String(b === row)));
      foldResults(row, true);
      moreEl.textContent = 'Show all ' + rows.length + ' results';
      moreEl.hidden = rows.length < 2;
      clearFile();
      errorEl.classList.remove('visible');
      info.hidden = true;
      splitRow.hidden = true;
      syncSplit();
    };
    const runSearch = () => {
      const q = searchEl.value.trim();
      if (!q || searchGo.disabled) return;
      searchGo.disabled = true;
      errorEl.classList.remove('visible');
      searchAreaBoundaries(q).then(found => {
        const fromHeight = resultsEl.hidden ? 0 : resultsEl.offsetHeight;
        resultsMotion++;
        resultsEl.replaceChildren(...found.map(result => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'area-result';
          row.setAttribute('aria-pressed', 'false');
          const part = (cls, text) => {
            const span = document.createElement('span');
            span.className = cls;
            span.textContent = text;
            return span;
          };
          row.append(part('area-result-name', result.name), part('area-result-kind', result.kind));
          if (result.detail) row.append(part('area-result-detail', result.detail));
          row.addEventListener('click', () => pickResult(result, row));
          return row;
        }));
        resultsEl.hidden = !found.length;
        creditEl.hidden = !found.length;
        moreEl.hidden = true;
        animateResultsHeight(fromHeight, resultsEl.offsetHeight);
        if (!found.length) showModalError('No boundary found. Try the full name, or add the region or country.');
        else if (found.length === 1) pickResult(found[0], resultsEl.firstChild);
      }).catch(() => {
        showModalError('The search failed. Check your connection, or use a file.');
      }).finally(() => { searchGo.disabled = false; });
    };
    searchGo.addEventListener('click', runSearch);
    searchEl.addEventListener('keydown', function(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      runSearch();
    });
    const syncSplit = () => {
      const separate = !splitRow.hidden && split.checked;
      nameRow.hidden = separate;
      nameEl.required = !separate;
    };
    split.addEventListener('change', syncSplit);
    document.getElementById('a-file-pick').addEventListener('click', function() { fileInput.click(); });
    fileInput.addEventListener('change', function() {
      const f = this.files && this.files[0];
      parsed = null;
      pickedLocal = '';
      if (localEl) localEl.value = '';
      resultsEl.querySelectorAll('.area-result').forEach(b => b.setAttribute('aria-pressed', 'false'));
      showAllResults();
      info.hidden = true;
      splitRow.hidden = true;
      errorEl.classList.remove('visible');
      syncSplit();
      fileName.textContent = f ? f.name : 'No file selected';
      fileName.classList.toggle('has-file', !!f);
      if (!f) return;
      if (f.size > AREA_MAX_FILE_BYTES) { showModalError('The file is over 25 MB.'); return; }
      f.text().then(parseAreaGeoJson).then(result => {
        parsed = result;
        const n = result.features.length;
        if (!nameEl.value.trim()) {
          nameEl.value = (n === 1 && result.features[0].name) || f.name.replace(/\.(geo)?json$/i, '');
        }
        showParsed();
      }).catch(err => showModalError(err.message));
    });
    document.getElementById('area-form').addEventListener('submit', function(e) {
      e.preventDefault();
      if (!parsed) { showModalError('Search for a boundary or choose a file.'); return; }
      const shared = readAreaFormFields('a');
      const items = (!splitRow.hidden && split.checked)
        ? parsed.features.map((x, i) => Object.assign({}, shared, { name: x.name || 'Area ' + (i + 1), geometry: buildAreaGeometry(x.polygons) }))
        : [Object.assign({}, shared, { name: nameEl.value.trim(), geometry: buildAreaGeometry(parsed.features.flatMap(x => x.polygons)) })];
      const local = readAreaLocalName('a', pickedLocal);
      if (local && items.length === 1 && !split.checked) items[0].local_name = local;
      if (parsed.osm) for (const item of items) item.source = 'osm';
      const submit = document.getElementById('area-submit');
      submit.disabled = true;
      const before = new Set((state.areas || []).map(a => a.id));
      items.reduce((chain, area) => chain.then(() => dataLayer.createArea(area)), Promise.resolve())
        .then(() => refreshAreas())
        .then(() => {
          closeModal();
          refreshPlacesPresentation();
          const map = state.currentMap;
          const added = (state._areaLayers || []).filter(x => !before.has(x.area.id));
          if (!map || !added.length) return;
          const bounds = L.latLngBounds();
          for (const x of added) bounds.extend(x.layer.getBounds());
          if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
        })
        .catch(err => { submit.disabled = false; showModalError(err.message); });
    });
  }

  function wireGpxForm() {
    wireSelectOrNew('g-region');
    wireStarRating('g-rating');
    const fileInput = document.getElementById('g-file');
    const filePick = document.getElementById('g-file-pick');
    const fileName = document.getElementById('g-file-name');
    if (filePick) filePick.addEventListener('click', function() { fileInput.click(); });
    if (fileInput) fileInput.addEventListener('change', function() {
      const f = this.files && this.files[0];
      if (f) {
        fileName.textContent = f.name;
        fileName.classList.add('has-file');
      } else {
        fileName.textContent = 'No file selected';
        fileName.classList.remove('has-file');
      }
    });
    const completedCb = document.getElementById('g-completed');
    const completedExtras = document.getElementById('g-completed-extras');
    if (completedCb && completedExtras) {
      completedCb.addEventListener('change', function() {
        completedExtras.classList.toggle('expanded', this.checked);
      });
    }
    document.getElementById('gpx-form').addEventListener('submit', function(e) {
      e.preventDefault();
      const file = document.getElementById('g-file').files[0];
      const region = readSelectOrNew('g-region');
      const name = document.getElementById('g-name').value.trim();
      if (!file) { showModalError('Pick a GPX file first.'); return; }
      const stripPii = document.getElementById('g-strip-pii').checked;
      const completed = document.getElementById('g-completed').checked;
      // Default is "planned": file lands as <name>.planned.gpx, rendered as a
      // dashed overlay. Toggling "completed" saves the walked variant.
      const storedName = completed ? name : (name + '.planned');

      // Optional metadata. date_completed + rating only apply to completed routes.
      // Each field may be hidden by user preference; guard with optional chaining.
      const get = id => { const el = document.getElementById(id); return el ? el.value : ''; };
      const metadata = readRouteMetaFields('g');
      if (completed) {
        const dateVal = get('g-date').trim();
        const ratingRaw = readStarRating('g-rating');
        if (dateVal) metadata.date_completed = dateVal;
        if (ratingRaw) metadata.rating = parseInt(ratingRaw, 10);
      }
      const metaKey = region ? region + '/' + name : name;

      const submitBtn = document.getElementById('gpx-submit');
      submitBtn.disabled = true;
      dataLayer.uploadGpx({ region, name: storedName, stripPii, file })
      .then(() => {
        if (Object.keys(metadata).length === 0) return null;
        return dataLayer.putMetadata({ key: metaKey, metadata: metadata });
      })
      .then(() => refreshRoutes())
      .then(() => { closeModal(); router(); })
      .catch(err => { submitBtn.disabled = false; showModalError(err.message); });
    });
  }

  function browseFormHtml() {
    return '<div id="browse-body">' +
      '<div style="font-size:var(--ui-text-xs);color:var(--muted);padding:var(--ui-space-2) 0">Loading catalogue&hellip;</div>' +
      '</div>';
  }

  function wireBrowseForm() {
    const body = document.getElementById('browse-body');
    // Cache the catalog across tab switches so reopening Browse renders
    // instantly instead of flashing "Loading..." -> content. Admin mutations
    // invalidate `state._catalogCache` in renderAdminCatalog / picker / mgr.
    if (Array.isArray(state._catalogCache)) {
      renderBrowse(state._catalogCache);
      return;
    }
    fetchCatalog()
      .then(entries => {
        state._catalogCache = Array.isArray(entries) ? entries : [];
        renderBrowse(state._catalogCache);
      })
      .catch(err => { body.innerHTML = '<div class="modal-error" style="display:block">' + escapeHtml(err.message) + '</div>'; });

    function renderBrowse(rawEntries) {
      // Hide entries the user has already imported. Tracked by from_catalog
      // name and by primary source URL, so a catalog entry that was renamed
      // since import (name changed, source stable) isn't offered again as a
      // duplicate.
      const importedNames = new Set();
      const importedSources = new Set();
      (state.places || []).forEach(p => {
        if (!p || !p.from_catalog) return;
        importedNames.add(p.from_catalog);
        (Array.isArray(p.sources) ? p.sources : []).forEach(s => {
          if (typeof s === 'string' && s.trim()) importedSources.add(s);
        });
      });
      const entries = (rawEntries || []).filter(e => {
        if (!e) return false;
        if (importedNames.has(e.name)) return false;
        const primary = Array.isArray(e.sources) && e.sources[0];
        return !(primary && importedSources.has(primary));
      });
      if (!entries.length) {
        const allHidden = (rawEntries || []).length > 0;
        body.innerHTML = '<div style="font-size:var(--ui-text-xs);color:var(--muted);padding:var(--ui-space-2) 0">' +
          (allHidden
            ? "You've imported everything in the catalogue."
            : 'No catalogue entries available yet. An admin can add some from Settings &rsaquo; Admin &rsaquo; Catalog.') +
          '</div>';
        return;
      }
      const rows = entries.map((e, i) => {
        const meta = [e.category, e.country].filter(Boolean).join(' · ');
        const name = escapeHtml(e.name || '(unnamed)');
        const note = (e.note || '').trim();
        const firstSource = Array.isArray(e.sources) ? e.sources.find(s => typeof s === 'string' && s.trim()) : null;
        const sourceLink = firstSource
          ? '<a href="' + escapeHtml(firstSource) + '" target="_blank" rel="noopener" class="row-src">Source</a>'
          : '';
        return '<label class="browse-row" data-idx="' + i + '" style="display:flex;align-items:flex-start;gap:var(--ui-space-2);padding:var(--ui-space-2) 0;border-bottom:1px solid var(--border);cursor:pointer">' +
          '<input type="checkbox" class="ui-check browse-pick" data-idx="' + i + '" style="margin-top:var(--ui-space-1)">' +
          '<span style="flex:1;min-width:0;display:block">' +
            '<span style="display:flex;align-items:center;gap:var(--ui-space-2);width:100%">' +
              '<span title="' + name + '" style="flex:1;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + name + '</span>' +
              sourceLink +
            '</span>' +
            (meta ? '<span style="display:block;font-size:var(--ui-text-xs);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(meta) + '</span>' : '') +
            (note ? '<span class="row-note">' + escapeHtml(note) + '</span>' : '') +
          '</span>' +
        '</label>';
      }).join('');
      // Filter dimensions drawn from the entries actually on offer (after
      // dedup), so the dropdowns never list a value with no matching row.
      // Categories are slugs; label them via displayCategory. Tags are
      // empty until catalog entries ship them, so that select self-hides.
      const fCats = [...new Set(entries.map(e => e.category).filter(Boolean))]
        .sort((a, b) => displayCategory(a).localeCompare(displayCategory(b)));
      const fCountries = [...new Set(entries.map(e => e.country).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b));
      const fTags = collectTags(entries);
      const hasFilters = fCats.length > 1 || fCountries.length > 1 || fTags.length > 0;
      body.innerHTML =
        '<div style="display:flex;gap:var(--ui-space-2);align-items:center;margin-bottom:var(--ui-space-2)" id="browse-controls">' +
          '<input type="text" id="browse-filter" placeholder="Filter&hellip;" style="flex:1;margin:0">' +
          (hasFilters ?
            '<div class="filter-dropdown">' +
              '<button type="button" class="filter-btn" id="browse-filter-btn" aria-haspopup="true" aria-expanded="false">Filters</button>' +
              '<div class="filter-popover" id="browse-filter-popover" hidden>' +
                (fCats.length > 1 ?
                  '<select id="bf-category"><option value="all">Category</option>' +
                    fCats.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(displayCategory(c)) + '</option>').join('') +
                  '</select>' : '') +
                (fCountries.length > 1 ?
                  '<select id="bf-country"><option value="all">Country</option>' +
                    fCountries.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('') +
                  '</select>' : '') +
                (fTags.length ?
                  '<select id="bf-tag"><option value="all">Tag</option>' +
                    fTags.map(t => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join('') +
                  '</select>' : '') +
                '<button type="button" class="filter-clear" id="browse-clear">Clear filters</button>' +
              '</div>' +
            '</div>' : '') +
        '</div>' +
        '<div id="browse-list" style="max-height:50vh;overflow-y:auto">' + rows + '</div>' +
        modalErrorHtml('add-error') +
        '<div class="modal-actions" style="display:flex;align-items:center;gap:var(--ui-space-2)">' +
          '<button type="button" class="ui-button ui-button-quiet" id="browse-notes-toggle">Show notes</button>' +
          '<button type="button" class="ui-button ui-button-quiet" id="browse-select-all">Select all</button>' +
          '<span class="action-spacer"></span>' +
          '<button type="button" class="ui-button ui-button-primary" id="browse-add" disabled>Add selected</button>' +
        '</div>';

      const searchInput = document.getElementById('browse-filter');
      const list = document.getElementById('browse-list');
      const addBtn = document.getElementById('browse-add');
      const selectAllBtn = document.getElementById('browse-select-all');

      function visibleRows() {
        return Array.from(list.querySelectorAll('.browse-row'))
          .filter(r => r.style.display !== 'none');
      }
      function updateBtn() {
        const n = list.querySelectorAll('.browse-pick:checked').length;
        addBtn.disabled = n === 0;
        addBtn.textContent = n ? 'Add ' + n + ' selected' : 'Add selected';
        const vis = visibleRows();
        const visChecked = vis.filter(r => r.querySelector('.browse-pick').checked).length;
        selectAllBtn.textContent = (vis.length && visChecked === vis.length) ? 'Clear selection' : 'Select all';
        selectAllBtn.disabled = vis.length === 0;
      }
      list.addEventListener('change', updateBtn);

      selectAllBtn.addEventListener('click', function() {
        const vis = visibleRows();
        const allChecked = vis.length && vis.every(r => r.querySelector('.browse-pick').checked);
        vis.forEach(r => { r.querySelector('.browse-pick').checked = !allChecked; });
        updateBtn();
      });

      // Combined filter: free-text (matched against the row's visible text)
      // intersected with the Category / Country / Tag dropdowns.
      function applyFilters() {
        const q = (searchInput.value || '').trim().toLowerCase();
        const catSel = document.getElementById('bf-category');
        const countrySel = document.getElementById('bf-country');
        const tagSel = document.getElementById('bf-tag');
        const cat = catSel ? catSel.value : 'all';
        const country = countrySel ? countrySel.value : 'all';
        const tag = tagSel ? tagSel.value : 'all';
        list.querySelectorAll('.browse-row').forEach(row => {
          const e = entries[parseInt(row.dataset.idx, 10)] || {};
          let show = !q || row.textContent.toLowerCase().includes(q);
          if (show && cat !== 'all') show = e.category === cat;
          if (show && country !== 'all') show = e.country === country;
          if (show && tag !== 'all') show = tagsInclude(e.tags, tag);
          row.style.display = show ? 'flex' : 'none';
        });
        updateBtn();
      }
      if (hasFilters) {
        const controls = document.getElementById('browse-controls');
        enhanceSelectsIn(controls);
        wireFilterPopover({
          btn: document.getElementById('browse-filter-btn'),
          pop: document.getElementById('browse-filter-popover'),
          clear: document.getElementById('browse-clear'),
          sels: ['bf-category', 'bf-country', 'bf-tag'].map(id => document.getElementById(id)).filter(Boolean),
          keyById: { 'bf-category': 'category', 'bf-country': 'country', 'bf-tag': 'tag' },
          filters: {}, searchInput, searchKey: 'q', onApply: applyFilters,
        });
      } else {
        searchInput.addEventListener('input', applyFilters);
      }

      // Source links sit inside a <label>; without this they'd toggle the
      // row's checkbox as a side effect of the label's default behavior.
      list.querySelectorAll('.row-src').forEach(a => {
        a.addEventListener('click', function(ev) { ev.stopPropagation(); });
      });

      const notesToggle = document.getElementById('browse-notes-toggle');
      notesToggle.addEventListener('click', function() {
        list.classList.add('notes-anim');
        const on = list.classList.toggle('show-notes');
        this.textContent = on ? 'Hide notes' : 'Show notes';
      });

      addBtn.addEventListener('click', function() {
        const picked = Array.from(list.querySelectorAll('.browse-pick:checked'))
          .map(cb => entries[parseInt(cb.dataset.idx, 10)])
          .filter(Boolean)
          // _source is a server-side UI tag; the place schema rejects it.
          // Tag the imported place with its catalog source so Browse can
          // hide it on re-open and a future "Update from catalog" knows
          // the lineage.
          .map(e => { const { _source, ...rest } = e; return Object.assign({}, rest, { from_catalog: e.name }); });
        if (!picked.length) return;
        function runImport() {
          addBtn.disabled = true;
          const prevColors = Object.assign({}, state.categoryColors);
          let done = 0;
          const errors = [];
          (function next() {
            if (done >= picked.length) {
              refreshPlaces().then(() => {
                syncPlacesOnMap(prevColors);
                refreshPlacesPresentation();
                if (errors.length) {
                  updateBtn();
                  showModalError(errors.length + ' of ' + picked.length + ' failed: ' + errors.join('; '));
                } else {
                  closeModal();
                }
              }).catch(err => { updateBtn(); showModalError(err.message); });
              return;
            }
            addBtn.textContent = 'Adding ' + (done + 1) + ' of ' + picked.length + '…';
            dataLayer.createPlace(picked[done])
              .catch(err => errors.push((picked[done].name || '?') + ': ' + err.message))
              .then(() => { done++; next(); });
          })();
        }
        // Small selections import straight away; only guard large batches.
        if (picked.length < 10) { runImport(); return; }
        openConfirmModal({
          title: 'Add ' + picked.length + ' places to your map?',
          confirmLabel: 'Add',
        }).then(ok => { if (ok) runImport(); });
      });
    }
  }
}
