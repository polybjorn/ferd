// The add flows, the edit dialogs, the map context menu and the settings group
// load on first use. The click handlers
// that open them import this module instead, so the eager graph stays small.
// sw.js precaches every lazy file, so these imports resolve offline too.
// Each one waits for its stylesheet as well, so a view never renders before
// its rules apply.

/** @type {Map<string, Promise<unknown>>} */
const styleLoads = new Map();

/**
 * Adds a stylesheet once and resolves when it has applied. Cleared on
 * failure, so a later call retries.
 * @param {string} href
 * @returns {Promise<unknown>}
 */
export function loadStyle(href) {
  let load = styleLoads.get(href);
  if (!load) {
    load = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = () => { link.remove(); reject(new Error(href)); };
      document.head.appendChild(link);
    });
    styleLoads.set(href, load);
    load.catch(() => styleLoads.delete(href));
  }
  return load;
}

// The rules of the dialogs and of the list pages, split out of app.css. Every
// lazy page and view can open a dialog, so each of them loads DIALOG_STYLES.
export const DIALOG_STYLES = '/app/dialogs.css';
export const LIST_STYLES = '/app/lists.css';

/**
 * Resolves to the module once it and its stylesheets have loaded.
 * @template T
 * @param {Promise<T>} module
 * @param {string[]} hrefs
 * @returns {Promise<T>}
 */
export function withStyles(module, ...hrefs) {
  return Promise.all([module, ...hrefs.map(loadStyle)]).then(([mod]) => mod);
}

/**
 * Wraps a dynamic import so a second click while it is in flight is dropped
 * instead of opening a second modal once it resolves.
 * @template {(...args: any[]) => void} F
 * @param {() => Promise<F>} load
 * @returns {(...args: Parameters<F>) => void}
 */
function lazyOpener(load) {
  let loading = false;
  return (...args) => {
    if (loading) return;
    loading = true;
    load().then(open => open(...args), e => console.error('lazy open failed', e))
      .finally(() => { loading = false; });
  };
}

export const openAddModal = lazyOpener(() => withStyles(import('./add/add.js'), DIALOG_STYLES).then(m => m.openAddModal));
export const openSettingsModal = lazyOpener(() => withStyles(import('./settings/settings.js'), DIALOG_STYLES).then(m => m.openSettingsModal));
export const openLogsModal = lazyOpener(() => withStyles(import('./settings/logs.js'), DIALOG_STYLES).then(m => m.openLogsModal));
export const openEditPlaceModal = lazyOpener(() => withStyles(import('./places/edit-place.js'), DIALOG_STYLES).then(m => m.openEditPlaceModal));
export const openEditAreaModal = lazyOpener(() => withStyles(import('./areas/edit-area.js'), DIALOG_STYLES).then(m => m.openEditAreaModal));
export const openEditTrailMetadataModal = lazyOpener(() => withStyles(import('./routes/route-meta.js'), DIALOG_STYLES).then(m => m.openEditTrailMetadataModal));
export const openMapPlaceContextMenu = lazyOpener(() => withStyles(import('./context-menu.js'), DIALOG_STYLES).then(m => m.openMapPlaceContextMenu));
export const openMapRouteContextMenu = lazyOpener(() => withStyles(import('./context-menu.js'), DIALOG_STYLES).then(m => m.openMapRouteContextMenu));
