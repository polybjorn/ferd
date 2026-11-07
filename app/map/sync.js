import { effect } from '@preact/signals';
import { state } from '../core.js';
import * as store from '../store.js';
import { syncAreasOnMap } from './area-layer.js';
import { syncPlacesOnMap } from './map-popups.js';

// The index map follows the store's signals: any write, local or synced,
// lands here and is drawn without a rebuild, so callers never tell the map
// that something changed. The views' copies in state are filled by effects
// of their own (bindStoreToState in select.js), so the map waits a
// microtask for them, which also folds a batch of writes into one pass.

/** @type {Set<string> | null} */
let pending = null;

/** @param {string} kind */
function mark(kind) {
  if (!pending) {
    pending = new Set();
    queueMicrotask(flushMapSync);
  }
  pending.add(kind);
}

export function bindMapToStore() {
  // Place colours come from the labels, so a label change redraws the places.
  effect(() => { store.places.value; store.labels.value; mark('places'); });
  effect(() => { store.areas.value; mark('areas'); });
  effect(() => { store.routes.value; mark('routes'); });
}

// Runs a pending pass now, for a caller that reads the map right after a write.
export function flushMapSync() {
  const kinds = pending;
  pending = null;
  if (!kinds || !homeMapMounted()) return;
  // A completed route can make an area visited, so routes redraw the areas too.
  if (kinds.has('routes') && state._syncRoutesOnMap) state._syncRoutesOnMap();
  if (kinds.has('places')) syncPlacesOnMap();
  else if (kinds.has('areas') || kinds.has('routes')) syncAreasOnMap();
}

// The index map, not the route detail map, which has no place layer.
export function homeMapMounted() { return !!state._placeClusterGroup; }
