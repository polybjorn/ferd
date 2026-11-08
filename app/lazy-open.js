// The add flows and the settings group load on first use. The click handlers
// that open them import this module instead, so the eager graph stays small.
// sw.js precaches every lazy file, so these imports resolve offline too.

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

export const openAddModal = lazyOpener(() => import('./add/add.js').then(m => m.openAddModal));
export const openSettingsModal = lazyOpener(() => import('./settings/settings.js').then(m => m.openSettingsModal));
export const openLogsModal = lazyOpener(() => import('./settings/logs.js').then(m => m.openLogsModal));
