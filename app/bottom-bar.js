import { effect } from '@preact/signals';
import { auth, catalogCache, places } from './store.js';
import { catalogUpdatesPending } from './auth.js';
import { openAddModal } from './lazy-open.js';

// The phone bar's own buttons. Its links are plain hashes, Search is wired in
// map-phone.js, and refreshTabVisibility shows and hides the items.

// Add opens the form that fits the page: a list's own kind (a route's page
// counts as Routes), and every kind from the map and You.
const ADD_TAB = /** @type {Record<string, 'place' | 'route' | 'area'>} */ ({ places: 'place', routes: 'route', route: 'route', areas: 'area' });
const add = document.getElementById('bar-add');
if (add) add.addEventListener('click', () => openAddModal(null, ADD_TAB[document.body.dataset.view || ''] || null));

// Updates are reviewed from the You page's gear, which is out of sight on
// every other tab, so the bar item carries the same dot. The signals are read
// here because this runs before state is bound to them, and the check waits a
// microtask for the effect that copies the places into state.
effect(() => {
  auth.value; places.value; catalogCache.value;
  queueMicrotask(() => {
    const item = document.getElementById('bar-you');
    if (item) item.classList.toggle('has-dot', catalogUpdatesPending());
  });
});
